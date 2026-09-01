import { graph } from "./microsoft.ts";
import { cleanText, displayName, htmlToPlain } from "./mailtext.ts";
import type { InboxPage, MailMessage, MailProvider, MailThread, OpenThread } from "./mail.ts";

/**
 * Outlook / Microsoft 365 as a `MailProvider` (server/mail.ts), over Microsoft
 * Graph. Graph is message-shaped where Gmail is thread-shaped, so the work here
 * is folding messages into conversations (`conversationId`) and translating the
 * Gmail-ish query the applet's search bar speaks into `$search`/`$filter`.
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
  isRead?: boolean;
  hasAttachments?: boolean;
  from?: GraphAddress;
  sender?: GraphAddress;
  body?: { contentType?: string; content?: string };
}

/** Fields the list needs; asking for the body of 20 messages would be rude. */
const LIST_SELECT = "id,conversationId,subject,from,sender,receivedDateTime,isRead,hasAttachments,bodyPreview";
const THREAD_SELECT = "id,conversationId,subject,from,sender,receivedDateTime,isRead,body";

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
      from: fromName(m),
      date: m.receivedDateTime ?? "",
      body: messageBody(m),
    }));
    return { id, subject: raw[0]?.subject || "(no subject)", messages };
  }
}
