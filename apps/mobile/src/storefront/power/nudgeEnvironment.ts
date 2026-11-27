// Storefront Code (fork): wakes a sleeping host through the wake relay and retries its connection,
// at a pace that suits a host resuming from suspend (F8). Shared by the outbox and dictation, so
// both together still send one magic packet a minute.
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { appAtomRegistry } from "../../state/atom-registry";
import { wakeHost } from "./wakeRelayClient";

// A second packet a minute later covers a lost one or a host that fell asleep again meanwhile.
const WAKE_EVERY_MS = 60_000;
const RETRY_EVERY_MS = 10_000;

const wokenAt = new Map<EnvironmentId, number>();
const retriedAt = new Map<EnvironmentId, number>();

export function nudgeEnvironment(environmentId: EnvironmentId): void {
  const now = Date.now();
  if (now - (wokenAt.get(environmentId) ?? 0) >= WAKE_EVERY_MS) {
    wokenAt.set(environmentId, now);
    // A host the relay does not know or cannot wake answers so; nothing more to do then.
    void Effect.runPromise(wakeHost(environmentId));
  }
  if (now - (retriedAt.get(environmentId) ?? 0) >= RETRY_EVERY_MS) {
    retriedAt.set(environmentId, now);
    // Loaded on first use, so the voice route that imports this needs no connection storage.
    void import("../../connection/catalog").then(({ environmentCatalog }) =>
      Effect.runPromise(
        Effect.ignore(environmentCatalog.retryNow.run(appAtomRegistry, environmentId)),
      ),
    );
  }
}

/** Once a host is back, the next sleep starts with a fresh packet. */
export function forgetNudges(environmentId: EnvironmentId): void {
  wokenAt.delete(environmentId);
  retriedAt.delete(environmentId);
}
