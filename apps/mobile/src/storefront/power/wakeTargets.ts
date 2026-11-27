// Storefront Code (fork): which hosts a queued message should wake (F8), apart so it tests
// without React Native.
import type { EnvironmentId } from "@t3tools/contracts";

/** Hosts with a queued message and no connection, the ones to wake. */
export function hostsToWake(
  queues: Readonly<Record<string, ReadonlyArray<{ readonly environmentId: EnvironmentId }>>>,
  connected: (environmentId: EnvironmentId) => boolean,
): ReadonlyArray<EnvironmentId> {
  const hosts = new Set<EnvironmentId>();
  for (const queue of Object.values(queues)) {
    for (const message of queue) hosts.add(message.environmentId);
  }
  return [...hosts].filter((environmentId) => !connected(environmentId));
}
