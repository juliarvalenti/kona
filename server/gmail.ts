import { gapi, gapiWrite } from "./google.ts";
import { cleanText, displayName, htmlToPlain } from "./mailtext.ts";
import { mimeRaw, parseAddresses } from "./compose.ts";
import type { InboxPage, MailDraft, MailProvider, MailThread, OpenThread, StoredDraft } from "./mail.ts";

/**
 * Gmail as a `MailProvider` (server/mail.ts): fetch inbox threads and full
 * threads, send and save mail, and move labels around (read, archive, trash,
 * label) — all normalized into the small shapes the email applet stores as state.
 * One instance speaks for one connected mailbox. Parsing helpers are pure and
 * exported so they can be unit-tested without the network.
 */

export { displayName };
export type { MailThread, OpenThread };

interface GHeader {
  name: string;
  value: string;
}
interface GPayload {
  mimeType?: string;
  headers?: GHeader[];
  body?: { data?: string };
  parts?: GPayload[];
}
interface GMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GPayload;
}

export function header(headers: GHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function findPart(payload: GPayload | undefined, mime: string): string | null {
  if (!payload) return null;
  if (payload.mimeType === mime && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  for (const part of payload.parts ?? []) {
    const hit = findPart(part, mime);
    if (hit) return hit;
  }
  return null;
}

/**
 * Best-effort readable body: prefer text/plain, else convert the text/html part
 * to text (most real mail — receipts, newsletters — is HTML-only). Links and
 * images are flattened so the reader stays clean.
 */
export function extractBody(payload: GPayload | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return cleanText(plain);

  const html = findPart(payload, "text/html");
  if (html) return htmlToPlain(html);

  return "";
}

function threadUnread(messages: GMessage[]): boolean {
  return messages.some((m) => (m.labelIds ?? []).includes("UNREAD"));
}

/** RFC-2822 `Date` header -> epoch ms (0 when it is missing or unparseable). */
export function parseDate(date: string): number {
  const t = Date.parse(date);
  return Number.isNaN(t) ? 0 : t;
}

/** The label ids Gmail modify calls speak in, for the flags we care about. */
const UNREAD = "UNREAD";
const INBOX = "INBOX";

interface GLabel {
  id?: string;
  name?: string;
}

/** Find a label by name, case-insensitively — "todo" should match "TODO". */
export function findLabel(labels: GLabel[], name: string): GLabel | null {
  const want = name.trim().toLowerCase();
  return labels.find((l) => (l.name ?? "").toLowerCase() === want) ?? null;
}

/** One message of a thread, with everything a reply needs off its headers. */
export function toMessage(m: GMessage) {
  const h = m.payload?.headers;
  const from = header(h, "From");
  return {
    id: m.id,
    from: displayName(from),
    fromAddress: from,
    ...(header(h, "Reply-To") ? { replyTo: header(h, "Reply-To") } : {}),
    to: parseAddresses(header(h, "To")),
    cc: parseAddresses(header(h, "Cc")),
    date: header(h, "Date"),
    body: extractBody(m.payload),
    ...(header(h, "Message-ID") ? { messageId: header(h, "Message-ID") } : {}),
    ...(header(h, "References") ? { references: header(h, "References") } : {}),
  };
}

/** A Gmail draft resource -> the shape the composer reopens. */
export function toStoredDraft(id: string, message: GMessage | undefined): StoredDraft {
  const h = message?.payload?.headers;
  return {
    id,
    to: parseAddresses(header(h, "To")),
    cc: parseAddresses(header(h, "Cc")),
    subject: header(h, "Subject"),
    body: extractBody(message?.payload),
    ts: Number(message?.internalDate ?? 0) || parseDate(header(h, "Date")),
  };
}

export class GmailProvider implements MailProvider {
  readonly id = "gmail" as const;
  constructor(readonly account: string) {}

  async listInbox(query = "in:inbox", max = 20, pageToken?: string): Promise<InboxPage> {
    const params: Record<string, string> = { q: query, maxResults: String(max) };
    if (pageToken) params.pageToken = pageToken;
    const list = await gapi(this.account, "/gmail/v1/users/me/threads", params);
    const stubs = (list.threads ?? []) as Array<{ id: string; snippet?: string }>;
    // Fetch thread metadata in parallel (Promise.all preserves inbox order).
    // NB: Gmail wants metadataHeaders as repeated params, not a comma string —
    // a comma string silently returns zero headers, so we fetch all metadata.
    const threads = await Promise.all(
      stubs.map(async (t) => {
        const full = await gapi(this.account, `/gmail/v1/users/me/threads/${t.id}`, { format: "metadata" });
        const messages = (full.messages ?? []) as GMessage[];
        const last = messages[messages.length - 1];
        const h = last?.payload?.headers;
        const date = header(h, "Date");
        return {
          id: t.id,
          from: displayName(header(h, "From")),
          subject: header(h, "Subject") || "(no subject)",
          snippet: last?.snippet ?? t.snippet ?? "",
          date,
          ts: parseDate(date),
          unread: threadUnread(messages),
        };
      }),
    );
    return { threads, nextPageToken: list.nextPageToken as string | undefined };
  }

  async getThread(id: string): Promise<OpenThread> {
    const full = await gapi(this.account, `/gmail/v1/users/me/threads/${id}`, { format: "full" });
    const messages = ((full.messages ?? []) as GMessage[]).map(toMessage);
    return {
      id,
      subject: header((full.messages?.[0] as GMessage)?.payload?.headers, "Subject") || "(no subject)",
      messages,
    };
  }

  // --- the write side --------------------------------------------------------

  /** The message as Gmail wants it: RFC-2822 bytes, base64url, plus a threadId. */
  private raw(draft: MailDraft): Record<string, string> {
    const message: Record<string, string> = { raw: mimeRaw(draft) };
    // Threading is belt and braces: the header keeps other clients happy, the
    // threadId keeps Gmail's own conversation view intact.
    if (draft.replyTo) message.threadId = draft.replyTo;
    return message;
  }

  async send(draft: MailDraft): Promise<{ id?: string }> {
    const sent = await gapiWrite(this.account, "POST", "/gmail/v1/users/me/messages/send", this.raw(draft));
    return { id: sent.id as string | undefined };
  }

  /** Create a draft, or update the one `draft.draftId` names. */
  async saveDraft(draft: MailDraft): Promise<{ id: string }> {
    const body = { message: this.raw(draft) };
    const saved = draft.draftId
      ? await gapiWrite(this.account, "PUT", `/gmail/v1/users/me/drafts/${draft.draftId}`, { id: draft.draftId, ...body })
      : await gapiWrite(this.account, "POST", "/gmail/v1/users/me/drafts", body);
    return { id: String(saved.id ?? draft.draftId ?? "") };
  }

  async sendDraft(id: string): Promise<void> {
    await gapiWrite(this.account, "POST", "/gmail/v1/users/me/drafts/send", { id });
  }

  async listDrafts(max = 20): Promise<StoredDraft[]> {
    const list = await gapi(this.account, "/gmail/v1/users/me/drafts", { maxResults: String(max) });
    const stubs = (list.drafts ?? []) as Array<{ id: string }>;
    return Promise.all(
      stubs.map(async (d) => {
        const full = await gapi(this.account, `/gmail/v1/users/me/drafts/${d.id}`, { format: "full" });
        return toStoredDraft(d.id, full.message as GMessage | undefined);
      }),
    );
  }

  /** Every flag below is one `threads.modify` — Gmail state IS its labels. */
  private modify(id: string, body: { addLabelIds?: string[]; removeLabelIds?: string[] }): Promise<unknown> {
    return gapiWrite(this.account, "POST", `/gmail/v1/users/me/threads/${id}/modify`, body);
  }

  async markRead(id: string, read = true): Promise<void> {
    await this.modify(id, read ? { removeLabelIds: [UNREAD] } : { addLabelIds: [UNREAD] });
  }

  async archive(id: string): Promise<void> {
    await this.modify(id, { removeLabelIds: [INBOX] });
  }

  async trash(id: string): Promise<void> {
    await gapiWrite(this.account, "POST", `/gmail/v1/users/me/threads/${id}/trash`);
  }

  /** Apply a label by name, creating it the first time you use one. */
  async label(id: string, name: string): Promise<void> {
    const list = await gapi(this.account, "/gmail/v1/users/me/labels");
    let hit = findLabel((list.labels ?? []) as GLabel[], name);
    if (!hit) {
      hit = (await gapiWrite(this.account, "POST", "/gmail/v1/users/me/labels", {
        name: name.trim(),
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      })) as GLabel;
    }
    if (!hit?.id) throw new Error(`could not create the label "${name}"`);
    await this.modify(id, { addLabelIds: [hit.id] });
  }
}
