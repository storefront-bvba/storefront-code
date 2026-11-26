// Storefront Code (fork): stands in for the relay URL in remoteRegistration's registration
// signature, so the phone registers again when a push host or its session changes, and daily.
// Kept apart from activateHostPush.ts, which imports remoteRegistration.
let hostsKey: string | null = null;
// Bumped to register again on purpose; the signature then differs from the saved one.
let attempt = 0;

export function setHostPushHostsKey(key: string | null): void {
  hostsKey = key;
}

export function bumpHostPushAttempt(): void {
  attempt += 1;
}

/** Null while no paired host sends push: the phone then registers nowhere, as without Connect. */
export function hostPushRelayKey(nowMs: number = Date.now()): string | null {
  if (hostsKey === null) return null;
  return `host-push|${hostsKey}|${new Date(nowMs).toISOString().slice(0, 10)}|${attempt}`;
}
