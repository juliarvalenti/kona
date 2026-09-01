import { gapi } from "./google.ts";
import { cleanText, displayName, htmlToPlain } from "./mailtext.ts";
import type { InboxPage, MailProvider, MailThread, OpenThread } from "./mail.ts";

/**
 * Gmail as a `MailProvider` (server/mail.ts): fetch inbox threads and full
 * threads, normalized into the small shapes the email applet stores as state.
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
  snippet?: string;
  labelIds?: string[];
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
    const messages = ((full.messages ?? []) as GMessage[]).map((m) => ({
      from: displayName(header(m.payload?.headers, "From")),
      date: header(m.payload?.headers, "Date"),
      body: extractBody(m.payload),
    }));
    return {
      id,
      subject: header((full.messages?.[0] as GMessage)?.payload?.headers, "Subject") || "(no subject)",
      messages,
    };
  }
}
