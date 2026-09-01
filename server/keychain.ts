/**
 * macOS Keychain, the two calls kona needs. Every OAuth provider stores its
 * refresh token here — OS-encrypted, gated by your login — so no plaintext
 * secret ever touches disk.
 *
 * Entries are (service, account) pairs: the service names the provider
 * (`kona-gmail`, `kona-outlook`) and the account names the *connected mailbox*
 * (`ada@gmail.com`), which is what lets kona hold several accounts at once.
 * Off macOS `security` is missing and every call is a miss, which surfaces as
 * "not signed in" rather than a crash.
 */

export function kcGet(service: string, account: string): string | null {
  try {
    const r = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-a", account, "-w"]);
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim() || null;
  } catch {
    return null; // no `security` binary (not macOS)
  }
}

export function kcSet(service: string, account: string, secret: string, label: string): void {
  const r = Bun.spawnSync([
    "security", "add-generic-password",
    "-U", // update if it already exists
    "-s", service,
    "-a", account,
    "-D", label,
    "-w", secret,
  ]);
  if (r.exitCode !== 0) throw new Error(`keychain write failed: ${r.stderr.toString()}`);
}

export function kcDelete(service: string, account: string): void {
  try {
    Bun.spawnSync(["security", "delete-generic-password", "-s", service, "-a", account]);
  } catch {
    /* nothing to remove */
  }
}
