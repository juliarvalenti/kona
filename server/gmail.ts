import { gapi } from "./google.ts";
import { convert as htmlToText } from "html-to-text";

/**
 * A thin Gmail layer: fetch inbox threads and full threads, normalized into
 * small shapes the email applet stores as state. Parsing helpers are pure and
 * exported so they can be unit-tested without the network.
 */

export interface MailThread {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
}

export interface MailMessage {
  from: string;
  date: string;
  body: string;
}

export interface OpenThread {
  id: string;
  subject: string;
  messages: MailMessage[];
}

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

/** "Ada Lovelace <ada@x.com>" -> "Ada Lovelace"; bare address -> the address. */
export function displayName(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m && m[1]?.trim()) return m[1].trim();
  if (m && m[2]) return m[2].trim();
  return from.trim();
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
  if (plain) return plain.trim();

  const html = findPart(payload, "text/html");
  if (html) {
    return htmlToText(html, {
      wordwrap: false, // let the TUI wrap
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "a", options: { ignoreHref: true } },
      ],
    }).trim();
  }
  return "";
}

function threadUnread(messages: GMessage[]): boolean {
  return messages.some((m) => (m.labelIds ?? []).includes("UNREAD"));
}

export async function listInbox(query = "in:inbox", max = 20): Promise<MailThread[]> {
  const list = await gapi("/gmail/v1/users/me/threads", { q: query, maxResults: String(max) });
  const stubs = (list.threads ?? []) as Array<{ id: string; snippet?: string }>;
  // Fetch thread metadata in parallel (Promise.all preserves inbox order).
  // NB: Gmail wants metadataHeaders as repeated params, not a comma string —
  // a comma string silently returns zero headers, so we fetch all metadata.
  return Promise.all(
    stubs.map(async (t) => {
      const full = await gapi(`/gmail/v1/users/me/threads/${t.id}`, { format: "metadata" });
      const messages = (full.messages ?? []) as GMessage[];
      const last = messages[messages.length - 1];
      const h = last?.payload?.headers;
      return {
        id: t.id,
        from: displayName(header(h, "From")),
        subject: header(h, "Subject") || "(no subject)",
        snippet: last?.snippet ?? t.snippet ?? "",
        date: header(h, "Date"),
        unread: threadUnread(messages),
      };
    }),
  );
}

export async function getThread(id: string): Promise<OpenThread> {
  const full = await gapi(`/gmail/v1/users/me/threads/${id}`, { format: "full" });
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
