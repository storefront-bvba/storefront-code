// Storefront Code (fork): a message sent to a sleeping host wakes it (F8, wish of 2026-11-27).
// Upstream's outbox already holds a message while its host is unreachable and sends it once the
// connection is back; this asks the wake relay to wake that host and retries the connection, so
// the reply follows without the user noticing the host slept.
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadOutboxManager } from "../../state/thread-outbox";
import { environmentConnectedAtom } from "../../state/use-remote-environment-registry";
import { wakeHost } from "./hostPowerClient";
import { hostsToWake } from "./wakeTargets";

const TICK_MS = 5_000;
// A host resumes in seconds; a second packet a minute later covers a lost one or a host that fell
// asleep again before the message went out.
const WAKE_EVERY_MS = 60_000;
const RETRY_EVERY_MS = 10_000;

export function installWakeForQueuedMessages(): () => void {
  const wokenAt = new Map<EnvironmentId, number>();
  const retriedAt = new Map<EnvironmentId, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const check = () => {
    const waiting = hostsToWake(
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
      (environmentId) => appAtomRegistry.get(environmentConnectedAtom(environmentId)),
    );
    if (waiting.length === 0) {
      if (timer !== null) clearInterval(timer);
      timer = null;
      wokenAt.clear();
      retriedAt.clear();
      return;
    }
    timer ??= setInterval(check, TICK_MS);
    const now = Date.now();
    for (const environmentId of waiting) {
      if (now - (wokenAt.get(environmentId) ?? 0) >= WAKE_EVERY_MS) {
        wokenAt.set(environmentId, now);
        // A host without a relay entry, or one the relay cannot wake, answers so; nothing to do then.
        void Effect.runPromise(wakeHost(environmentId));
      }
      if (now - (retriedAt.get(environmentId) ?? 0) >= RETRY_EVERY_MS) {
        retriedAt.set(environmentId, now);
        void Effect.runPromise(
          Effect.ignore(environmentCatalog.retryNow.run(appAtomRegistry, environmentId)),
        );
      }
    }
  };

  const unsubscribe = appAtomRegistry.subscribe(
    threadOutboxManager.queuedMessagesByThreadKeyAtom,
    check,
    { immediate: true },
  );
  return () => {
    unsubscribe();
    if (timer !== null) clearInterval(timer);
  };
}
