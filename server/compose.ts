import type { MailDraft, MailMessage, OpenThread } from "./mail.ts";

/**
 * Composing, the provider-agnostic half. Everything a reply, a forward or a
 * new message needs BEFORE it becomes an API call lives here — address
 * parsing, the RFC-2822 bytes Gmail wants, the "Re:"/quoted-body conventions
 * both providers show a human.
 *
 * It is all pure, so the rules that decide who a reply-all goes to are unit
 * tested rather than discovered in someone's sent folder.
 */

// --- addresses ---------------------------------------------------------------

/**
 * Split a recipient string the way a human types one: commas or semicolons
 * between addresses, except inside a quoted display name ("Lovelace, Ada").
 * Already-split arrays pass straight through, so a verb can take either.
 */
export function parseAddresses(input: unknown): string[] {
  if (Array.isArray(input)) return input.flatMap((v) => parseAddresses(v));
  if (typeof input !== "string") return [];
  const out: string[] = [];
  let buf = "";
  let quoted = false;
  let angled = false;
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<") angled = true;
    else if (ch === ">") angled = false;
    if ((ch === "," || ch === ";") && !quoted && !angled) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The bare mailbox in "Ada Lovelace <ada@x.com>" — lowercased for comparison. */
export function addressOf(recipient: string): string {
  const angled = recipient.match(/<([^>]+)>/);
  return (angled?.[1] ?? recipient).trim().toLowerCase();
}

/** True when two recipients name the same mailbox, however they are spelled. */
export function sameAddress(a: string, b: string): boolean {
  return !!a && !!b && addressOf(a) === addressOf(b);
}

/** Drop duplicates and anything in `without` (me, and whoever is already on the To). */
export function dedupe(recipients: string[], without: string[] = []): string[] {
  const skip = new Set(without.filter(Boolean).map(addressOf));
  const out: string[] = [];
  for (const r of recipients) {
    const key = addressOf(r);
    if (!key || !key.includes("@") || skip.has(key)) continue;
    skip.add(key);
    out.push(r.trim());
  }
  return out;
}

// --- headers -----------------------------------------------------------------

const ASCII = /^[\x20-\x7e]*$/;

/** RFC 2047 encode a header value that isn't plain ASCII (a subject in Japanese). */
export function encodeWord(value: string): string {
  if (ASCII.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Encode only the display name of an address; the mailbox stays verbatim. */
export function encodeAddress(recipient: string): string {
  const m = recipient.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m || !m[1]?.trim()) return recipient.trim();
  const name = m[1].trim();
  return `${ASCII.test(name) ? `"${name.replace(/"/g, "'")}"` : encodeWord(name)} <${m[2]!.trim()}>`;
}

/** Split base64 into the 76-character lines RFC 2045 asks for. */
function chunk64(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join("\r\n");
}

/**
 * The draft as RFC-2822 bytes: what Gmail's `messages.send` takes (base64url of
 * this). UTF-8 throughout — base64 body, encoded-word headers — so an emoji in
 * a subject line survives the trip.
 */
export function buildMime(draft: MailDraft, opts: { from?: string } = {}): string {
  const lines: string[] = [];
  const addr = (list?: string[]) => (list ?? []).map(encodeAddress).join(", ");
  if (opts.from) lines.push(`From: ${encodeAddress(opts.from)}`);
  if (draft.to?.length) lines.push(`To: ${addr(draft.to)}`);
  if (draft.cc?.length) lines.push(`Cc: ${addr(draft.cc)}`);
  if (draft.bcc?.length) lines.push(`Bcc: ${addr(draft.bcc)}`);
  lines.push(`Subject: ${encodeWord(draft.subject ?? "")}`);
  if (draft.inReplyTo?.messageId) {
    lines.push(`In-Reply-To: ${draft.inReplyTo.messageId}`);
    const refs = [draft.inReplyTo.references, draft.inReplyTo.messageId].filter(Boolean).join(" ");
    lines.push(`References: ${refs}`);
  }
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: base64");
  const body = chunk64(Buffer.from(draft.body ?? "", "utf8").toString("base64"));
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

/** The same bytes, base64url — the exact shape Gmail's `raw` field wants. */
export function mimeRaw(draft: MailDraft, opts: { from?: string } = {}): string {
  return Buffer.from(buildMime(draft, opts), "utf8").toString("base64url");
}

// --- reply / forward ---------------------------------------------------------

/** "Re: hi" from "hi", and "Re: hi" from "Re: hi" — never "Re: Re: hi". */
export function replySubject(subject: string): string {
  const s = (subject || "").trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** "Fwd: hi", idempotent against both "Fwd:" and "Fw:". */
export function forwardSubject(subject: string): string {
  const s = (subject || "").trim();
  return /^(fwd?|fw):/i.test(s) ? s : `Fwd: ${s}`;
}

/** Quote a body the way every mail client does: "> " in front of every line. */
export function quote(body: string, max = 60): string {
  return (body || "")
    .split("\n")
    .slice(0, max)
    .map((l) => `> ${l}`.trimEnd())
    .join("\n");
}

/** The attribution line above a quoted reply. */
export function attribution(m: Pick<MailMessage, "from" | "date">): string {
  return m.date ? `On ${m.date}, ${m.from} wrote:` : `${m.from} wrote:`;
}

/** The message a reply answers: the newest one in the thread. */
export function lastMessage(thread: OpenThread): MailMessage | null {
  return thread.messages[thread.messages.length - 1] ?? null;
}

export interface ReplyOpts {
  /** Reply-all: keep the other recipients on the thread. */
  all?: boolean;
  /** The mailbox replying — never Cc yourself. */
  me?: string;
}

/**
 * Turn an open thread into a prefilled draft. Reply goes to whoever wrote the
 * last message (their Reply-To if they set one); reply-all keeps everyone else
 * on Cc, minus you and minus the person already on the To line.
 */
export function replyDraft(thread: OpenThread, opts: ReplyOpts = {}): MailDraft {
  const last = lastMessage(thread);
  const me = opts.me ?? "";
  const to = dedupe(parseAddresses(last?.replyTo || last?.fromAddress || last?.from || ""), [me]);
  const cc = opts.all
    ? dedupe([...(last?.to ?? []), ...(last?.cc ?? [])], [me, ...to])
    : [];
  const head = last ? `${attribution(last)}\n${quote(last.body)}` : "";
  return {
    to,
    cc,
    subject: replySubject(thread.subject),
    body: head ? `\n\n${head}` : "",
    replyTo: thread.id,
    ...(last ? { inReplyTo: { id: last.id, messageId: last.messageId, references: last.references } } : {}),
  };
}

/** The same, for a forward: no recipients (you pick), the message quoted below. */
export function forwardDraft(thread: OpenThread): MailDraft {
  const last = lastMessage(thread);
  const header = last
    ? [
        "---------- Forwarded message ----------",
        `From: ${last.from}`,
        ...(last.date ? [`Date: ${last.date}`] : []),
        `Subject: ${thread.subject}`,
        ...(last.to?.length ? [`To: ${last.to.join(", ")}`] : []),
        "",
        last.body,
      ].join("\n")
    : "";
  return {
    to: [],
    subject: forwardSubject(thread.subject),
    body: header ? `\n\n${header}` : "",
    ...(last?.id ? { inReplyTo: { id: last.id } } : {}),
  };
}

/** A one-line summary of a draft, for a notice or a drafts row. */
export function draftSummary(draft: Pick<MailDraft, "to" | "subject">): string {
  const who = (draft.to ?? []).join(", ");
  const what = draft.subject || "(no subject)";
  return who ? `${what} → ${who}` : what;
}
