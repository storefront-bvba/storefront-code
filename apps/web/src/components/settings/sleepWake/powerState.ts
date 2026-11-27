// Storefront Code (fork): each host's power status, the wake relays they named, and what those
// relays report. Relays stay known for the session, so a host that went to sleep can be woken.
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  StorefrontWakeRelay,
  StorefrontWakeRelayHost,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { readPowerStatus, writePowerSwitch } from "./powerHost";
import { rememberRelay } from "./sleepWake.logic";
import { fetchWakeRelayHosts } from "./wakeRelayClient";

export const knownRelaysAtom = Atom.make<ReadonlyArray<StorefrontWakeRelay>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("storefront-wake-relays"),
);

export const powerStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) =>
      readPowerStatus(environmentId).pipe(
        Effect.tap((read) =>
          Effect.sync(() => {
            if (read._tag !== "Ok" || read.status.relay === null) return;
            get.set(knownRelaysAtom, rememberRelay(get.once(knownRelaysAtom), read.status.relay));
          }),
        ),
      ),
    )
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`storefront-power:${environmentId}`)),
);

export interface RelayRead {
  readonly relay: StorefrontWakeRelay;
  /** Null when the relay could not be reached. */
  readonly hosts: ReadonlyArray<StorefrontWakeRelayHost> | null;
}

class WakeRelayUnreachable extends Schema.TaggedError<WakeRelayUnreachable>()(
  "WakeRelayUnreachable",
  {},
) {}

export const relaysKey = (relays: ReadonlyArray<StorefrontWakeRelay>) => JSON.stringify(relays);

// Keyed by the relays' JSON so equal lists share one atom; the label leaves the token out.
export const relayHostsAtom = Atom.family((key: string) => {
  const relays = JSON.parse(key) as ReadonlyArray<StorefrontWakeRelay>;
  return Atom.make(
    Effect.forEach(
      relays,
      (relay): Effect.Effect<RelayRead> =>
        Effect.tryPromise({
          try: () => fetchWakeRelayHosts(relay),
          catch: () => new WakeRelayUnreachable(),
        }).pipe(
          Effect.map((hosts) => ({ relay, hosts })),
          Effect.orElseSucceed(() => ({ relay, hosts: null })),
        ),
      { concurrency: "unbounded" },
    ),
  ).pipe(Atom.withLabel("storefront-wake-relay-hosts"));
});

const powerScheduler = createAtomCommandScheduler();

export const setPowerSwitch = createRuntimeCommand(connectionAtomRuntime, {
  label: "storefront:power:set-switch",
  scheduler: powerScheduler,
  concurrency: {
    mode: "serial",
    key: (input: Parameters<typeof writePowerSwitch>[0]) => input.environmentId,
  },
  execute: writePowerSwitch,
});
