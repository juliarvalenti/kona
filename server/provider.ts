import { createHash, randomBytes } from "node:crypto";

/**
 * The handful of things every provider server does the same way.
 *
 * gmail, outlook, spotify, webex and ticker each grew their own copy of these
 * — five identical `readJson`s, three identical PKCE pairs, and three
 * hand-rolled token expiries that each picked their own skew. Rules that are
 * easy to write slightly differently (how long a token is good for, how much
 * clock skew to allow) belong in ONE place; the flows themselves stay in each
 * provider, because that is where they genuinely differ.
 */

/** Read a JSON config file; a missing or malformed file is simply "not set up". */
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Bun.file(path).text()) as T;
  } catch {
    return null;
  }
}

/**
 * A PKCE verifier/challenge pair (S256). Desktop OAuth clients can't keep a
 * secret, so the verifier is what proves the code came back to the same
 * process that asked for it.
 */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** An access token with the moment it stops being usable. */
export interface AccessToken {
  token: string;
  exp: number;
}

/** Refresh this early rather than handing out a token that dies mid-request. */
const SKEW_MS = 30_000;
/** What a provider that doesn't say `expires_in` is assumed to mean. */
const DEFAULT_TTL_S = 3600;

/** The cached token, if it will still be valid a moment from now. */
export function freshToken(entry: AccessToken | null | undefined): string | null {
  return entry && entry.exp > Date.now() + SKEW_MS ? entry.token : null;
}

/** Stamp a freshly minted token with its expiry (providers report seconds). */
export function expiringToken(token: string, expiresIn?: number): AccessToken {
  return { token, exp: Date.now() + (expiresIn ?? DEFAULT_TTL_S) * 1000 };
}
