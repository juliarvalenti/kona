import { graph, graphWrite } from "./microsoft.ts";
import { cleanText, displayName, htmlToPlain } from "./mailtext.ts";
import { addressOf, parseAddresses } from "./compose.ts";
import type { InboxPage, MailDraft, MailMessage, MailProvider, MailThread, OpenThread, StoredDraft } from "./mail.ts";

/**
 * Outlook / Microsoft 365 as a `MailProvider` (server/mail.ts), over Microsoft
 * Graph. Graph is message-shaped where Gmail is thread-shaped, so the work here
 * is folding messages into conversations (`conversationId`), fanning writes back
 * out over the messages in one, and translating the Gmail-ish query the applet's
 * search bar speaks into `$search`/`$filter`.
 * Everything below the class is pure and unit-tested without the network.
 */

export interface GraphAddress {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphMessage {
  id?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  lastModifiedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  from?: GraphAddress;
  sender?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  replyTo?: GraphAddress[];
  internetMessageId?: string;
  categories?: string[];
  body?: { contentType?: string; content?: string };
}

/** Fields the list needs; asking for the body of 20 messages would be rude. */
const LIST_SELECT = "id,conversationId,subject,from,sender,receivedDateTime,isRead,hasAttachments,bodyPreview";
const THREAD_SELECT =
  "id,conversationId,subject,from,sender,toRecipients,ccRecipients,replyTo,internetMessageId,receivedDateTime,isRead,body";
/** What a saved draft needs to reopen in the composer. */
const DRAFT_SELECT = "id,subject,toRecipients,ccRecipients,body,bodyPreview,lastModifiedDateTime";

/** Well-known folder names Graph resolves without a lookup. */
const ARCHIVE = "archive";
const DELETED = "deleteditems";

/** "Ada Lovelace" if Graph knows it, else the address. */
export function fromName(m: GraphMessage): string {
  const e = (m.from ?? m.sender)?.emailAddress;
  if (e?.name && e.name.trim()) return displayName(e.name);
  return e?.address ?? "(unknown)";
}

export function parseDate(date: string | undefined): number {
  const t = Date.parse(date ?? "");
  return Number.isNaN(t) ? 0 : t;
}

/** Graph body -> readable terminal text (HTML is the common case). */
export function messageBody(m: GraphMessage): string {
  const content = m.body?.content ?? "";
  if (!content) return "";
  return (m.body?.contentType ?? "").toLowerCase() === "html" ? htmlToPlain(content) : cleanText(content);
}

/** One message as a list row (before conversation folding). */
export function toThread(m: GraphMessage): MailThread {
  const date = m.receivedDateTime ?? "";
  return {
    // The row is a CONVERSATION: `open` re-fetches by conversationId. Lone
    // messages without one fall back to their own id.
    id: m.conversationId || m.id || "",
    from: fromName(m),
    subject: m.subject || "(no subject)",
    snippet: (m.bodyPreview ?? "").replace(/\s+/g, " ").trim(),
    date,
    ts: parseDate(date),
    unread: m.isRead === false,
  };
}

/**
 * Fold messages into conversations: newest message wins the row, and the row is
 * unread if ANY message in it is — the same rule Gmail's UNREAD label gives us.
 */
export function groupConversations(messages: GraphMessage[]): MailThread[] {
  const byId = new Map<string, MailThread>();
  for (const m of messages) {
    const row = toThread(m);
    if (!row.id) continue;
    const seen = byId.get(row.id);
    if (!seen) {
      byId.set(row.id, row);
    } else {
      const unread = seen.unread || row.unread;
      byId.set(row.id, { ...(row.ts >= seen.ts ? row : seen), unread });
    }
  }
  return [...byId.values()].sort((a, b) => b.ts - a.ts);
}

/** OData string literal: wrap in quotes, double any quote inside. */
export function odataQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export interface GraphQuery {
  /** `$search` term, when the query has anything free-text about it. */
  search?: string;
  /** `$filter` expression — mutually exclusive with `$search` in Graph. */
  filter?: string;
  /** Predicates Graph won't take alongside `$search`; applied client-side. */
  unread?: boolean;
  hasAttachment?: boolean;
}

/**
 * Translate the Gmail-flavored query the search bar speaks into Graph's
 * vocabulary. `in:inbox` is implicit (we ask the inbox folder), `is:unread` and
 * `has:attachment` become filters, everything else becomes a `$search` term —
 * and since Graph refuses `$search` together with `$filter`/`$orderby`, the
 * caller re-applies the flag predicates itself when both are present.
 */
export function graphQuery(query: string): GraphQuery {
  const out: GraphQuery = {};
  const terms: string[] = [];
  // A token is a run of non-space, except that a quoted phrase holds together
  // even after a field prefix: subject:"quarterly review" is ONE token.
  const tokens = (query ?? "").match(/\S*"[^"]*"|\S+/g) ?? [];
  const unquote = (s: string) => (s.length > 1 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

  for (const raw of tokens) {
    const colon = raw.indexOf(":");
    const k = colon > 0 ? raw.slice(0, colon).toLowerCase() : "";
    const rest = colon > 0 ? unquote(raw.slice(colon + 1)) : "";
    const token = unquote(raw);

    if (k === "in" || k === "label") {
      if (rest.toLowerCase() !== "inbox") terms.push(rest); // no folder map yet
    } else if (k === "is") {
      if (rest.toLowerCase() === "unread") out.unread = true;
      else if (rest.toLowerCase() === "read") out.unread = false;
    } else if (k === "has" && rest.toLowerCase() === "attachment") {
      out.hasAttachment = true;
    } else if ((k === "from" || k === "to" || k === "subject" || k === "body") && rest) {
      terms.push(`${k}:${/\s/.test(rest) ? `"${rest}"` : rest}`);
    } else if (token.trim()) {
      terms.push(/\s/.test(token) ? `"${token}"` : token); // keep a phrase a phrase
    }
  }

  if (terms.length) {
    out.search = terms.join(" ");
    return out;
  }
  const filters: string[] = [];
  if (out.unread === true) filters.push("isRead eq false");
  if (out.unread === false) filters.push("isRead eq true");
  if (out.hasAttachment) filters.push("hasAttachments eq true");
  if (filters.length) out.filter = filters.join(" and ");
  return out;
}

/** Apply the predicates Graph could not take server-side. */
export function applyFlags(rows: MailThread[], q: GraphQuery): MailThread[] {
  if (!q.search) return rows; // filters already ran server-side
  let out = rows;
  if (q.unread === true) out = out.filter((t) => t.unread);
  if (q.unread === false) out = out.filter((t) => !t.unread);
  return out;
}

/** Graph recipients -> the "Name <addr>" strings the rest of kona speaks. */
export function recipients(list: GraphAddress[] | undefined): string[] {
  return (list ?? [])
    .map((r) => {
      const e = r.emailAddress;
      if (!e?.address) return "";
      return e.name && e.name.trim() && e.name !== e.address ? `${e.name} <${e.address}>` : e.address;
    })
    .filter(Boolean);
}

/** …and back: the shape Graph wants on a message it is about to send. */
export function toRecipients(list: string[] | undefined): GraphAddress[] {
  return (list ?? [])
    .flatMap((r) => parseAddresses(r))
    .map((r) => ({ emailAddress: { address: addressOf(r) } }))
    .filter((r) => r.emailAddress.address.includes("@"));
}

/**
 * A draft as a Graph message resource. Plain text, because that is what the
 * composer writes and what the reader shows.
 */
export function graphMessage(draft: MailDraft): Record<string, unknown> {
  const message: Record<string, unknown> = {
    subject: draft.subject ?? "",
    body: { contentType: "Text", content: draft.body ?? "" },
    toRecipients: toRecipients(draft.to),
  };
  if (draft.cc?.length) message.ccRecipients = toRecipients(draft.cc);
  if (draft.bcc?.length) message.bccRecipients = toRecipients(draft.bcc);
  return message;
}

/** A Graph draft -> the shape the composer reopens. */
export function toStoredDraft(m: GraphMessage): StoredDraft {
  return {
    id: m.id ?? "",
    to: recipients(m.toRecipients),
    cc: recipients(m.ccRecipients),
    subject: m.subject ?? "",
    body: messageBody(m) || (m.bodyPreview ?? ""),
    ts: parseDate(m.lastModifiedDateTime ?? m.receivedDateTime),
  };
}

export class OutlookProvider implements MailProvider {
  readonly id = "outlook" as const;
  constructor(readonly account: string) {}

  async listInbox(query = "in:inbox", max = 20, pageToken?: string): Promise<InboxPage> {
    const q = graphQuery(query);
    let page: Record<string, any>;
    if (pageToken) {
      // A nextLink is a complete, already-parameterized Graph URL.
      page = await graph(this.account, pageToken);
    } else {
      const params: Record<string, string> = { $select: LIST_SELECT, $top: String(max) };
      if (q.search) {
        // $search brings its own relevance order; Graph rejects $orderby with it.
        params.$search = `"${q.search.replace(/"/g, '\\"')}"`;
      } else {
        params.$orderby = "receivedDateTime desc";
        if (q.filter) params.$filter = q.filter;
      }
      const path = q.search ? "/me/messages" : "/me/mailFolders/inbox/messages";
      page = await graph(this.account, path, params);
    }

    const messages = (page.value ?? []) as GraphMessage[];
    return {
      threads: applyFlags(groupConversations(messages), q),
      nextPageToken: (page["@odata.nextLink"] as string | undefined) ?? undefined,
    };
  }

  async getThread(id: string): Promise<OpenThread> {
    // conversationId + $orderby is the combination Graph refuses on some
    // mailboxes, so we filter server-side and sort here.
    const page = await graph(this.account, "/me/messages", {
      $filter: `conversationId eq ${odataQuote(id)}`,
      $select: THREAD_SELECT,
      $top: "50",
    });
    const raw = ((page.value ?? []) as GraphMessage[]).slice().sort(
      (a, b) => parseDate(a.receivedDateTime) - parseDate(b.receivedDateTime),
    );
    const messages: MailMessage[] = raw.map((m) => ({
      id: m.id,
      from: fromName(m),
      fromAddress: (m.from ?? m.sender)?.emailAddress?.address ?? "",
      ...(m.replyTo?.length ? { replyTo: recipients(m.replyTo)[0] } : {}),
      to: recipients(m.toRecipients),
      cc: recipients(m.ccRecipients),
      date: m.receivedDateTime ?? "",
      body: messageBody(m),
      ...(m.internetMessageId ? { messageId: m.internetMessageId } : {}),
    }));
    return { id, subject: raw[0]?.subject || "(no subject)", messages };
  }

  // --- the write side --------------------------------------------------------

  /**
   * Graph is message-shaped and kona's rows are conversations, so every flag
   * below fans out over the messages in the conversation. A row whose id is
   * really a lone message id (no conversationId) falls back to itself.
   */
  private async messageIds(id: string): Promise<string[]> {
    const page = await graph(this.account, "/me/messages", {
      $filter: `conversationId eq ${odataQuote(id)}`,
      $select: "id",
      $top: "50",
    });
    const ids = ((page.value ?? []) as GraphMessage[]).map((m) => m.id).filter((x): x is string => !!x);
    return ids.length ? ids : [id];
  }

  /** Do the same thing to every message in the conversation. */
  private async eachMessage(id: string, run: (messageId: string) => Promise<unknown>): Promise<void> {
    const ids = await this.messageIds(id);
    await Promise.all(ids.map(run));
  }

  /**
   * Send. A reply goes through `createReply` so Outlook keeps it in the same
   * conversation, then we overwrite the recipients and body the composer
   * actually collected (a bare reply would only ever answer the sender).
   */
  async send(draft: MailDraft): Promise<{ id?: string }> {
    const answering = draft.inReplyTo?.id;
    if (answering) {
      const reply = await graphWrite(this.account, "POST", `/me/messages/${answering}/createReply`, {});
      const id = String(reply.id ?? "");
      if (!id) throw new Error("graph would not open a reply draft");
      await graphWrite(this.account, "PATCH", `/me/messages/${id}`, graphMessage(draft));
      await graphWrite(this.account, "POST", `/me/messages/${id}/send`);
      return { id };
    }
    await graphWrite(this.account, "POST", "/me/sendMail", {
      message: graphMessage(draft),
      saveToSentItems: true,
    });
    return {};
  }

  /** Create a draft in the Drafts folder, or update the one we already saved. */
  async saveDraft(draft: MailDraft): Promise<{ id: string }> {
    if (draft.draftId) {
      await graphWrite(this.account, "PATCH", `/me/messages/${draft.draftId}`, graphMessage(draft));
      return { id: draft.draftId };
    }
    const saved = await graphWrite(this.account, "POST", "/me/messages", {
      ...graphMessage(draft),
      isDraft: true,
    });
    return { id: String(saved.id ?? "") };
  }

  async sendDraft(id: string): Promise<void> {
    await graphWrite(this.account, "POST", `/me/messages/${id}/send`);
  }

  async listDrafts(max = 20): Promise<StoredDraft[]> {
    const page = await graph(this.account, "/me/mailFolders/drafts/messages", {
      $select: DRAFT_SELECT,
      $orderby: "lastModifiedDateTime desc",
      $top: String(max),
    });
    return ((page.value ?? []) as GraphMessage[]).map(toStoredDraft);
  }

  async markRead(id: string, read = true): Promise<void> {
    await this.eachMessage(id, (m) => graphWrite(this.account, "PATCH", `/me/messages/${m}`, { isRead: read }));
  }

  async archive(id: string): Promise<void> {
    await this.eachMessage(id, (m) =>
      graphWrite(this.account, "POST", `/me/messages/${m}/move`, { destinationId: ARCHIVE }),
    );
  }

  async trash(id: string): Promise<void> {
    await this.eachMessage(id, (m) =>
      graphWrite(this.account, "POST", `/me/messages/${m}/move`, { destinationId: DELETED }),
    );
  }

  /**
   * Outlook's answer to a Gmail label is a category. Categories are free text
   * on the message, so applying one is a PATCH — no label to create first.
   */
  async label(id: string, name: string): Promise<void> {
    const tag = name.trim();
    if (!tag) throw new Error("a label needs a name");
    const page = await graph(this.account, "/me/messages", {
      $filter: `conversationId eq ${odataQuote(id)}`,
      $select: "id,categories",
      $top: "50",
    });
    const rows = (page.value ?? []) as GraphMessage[];
    const targets = rows.length ? rows : [{ id, categories: [] as string[] }];
    await Promise.all(
      targets.map((m) => {
        const categories = [...new Set([...(m.categories ?? []), tag])];
        return graphWrite(this.account, "PATCH", `/me/messages/${m.id}`, { categories });
      }),
    );
  }
}
