// Storefront Code (fork): a message sent to a sleeping host wakes it (F8, wish of 2026-11-27).
// Upstream's outbox already holds a message while its host is unreachable and sends it once the
// connection is back; this asks the wake relay to wake that host and retries the connection, so
// the reply follows without the user noticing the host slept.
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../../state/atom-registry";
import { threadOutboxManager } from "../../state/thread-outbox";
import { environmentConnectedAtom } from "../../state/use-remote-environment-registry";
import { forgetNudges, nudgeEnvironment } from "./nudgeEnvironment";
import { hostsToWake } from "./wakeTargets";

const TICK_MS = 5_000;

export function installWakeForQueuedMessages(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let waking: ReadonlyArray<EnvironmentId> = [];

  const check = () => {
    const waiting = hostsToWake(
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
      (environmentId) => appAtomRegistry.get(environmentConnectedAtom(environmentId)),
    );
    for (const environmentId of waking) {
      if (!waiting.includes(environmentId)) forgetNudges(environmentId);
    }
    waking = waiting;
    for (const environmentId of waiting) nudgeEnvironment(environmentId);
    if (waiting.length === 0) {
      if (timer !== null) clearInterval(timer);
      timer = null;
    } else {
      timer ??= setInterval(check, TICK_MS);
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
