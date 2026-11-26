// Storefront Code (fork): the four relay calls agent awareness makes go to the paired hosts
// instead (fork/design/F5-host-push.md). The host client is bound late, by activateHostPush,
// because it needs the connection runtime, which itself builds on lib/runtime.
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type {
  RelayAgentActivitySnapshotResponse,
  RelayDeviceRegistrationRequest,
  RelayLiveActivityRegistrationRequest,
  RelayOkResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

type RelayFailure = ManagedRelay.ManagedRelayClientError;

export interface HostRelay {
  readonly registerDevice: (
    payload: RelayDeviceRegistrationRequest,
  ) => Effect.Effect<RelayOkResponse, RelayFailure>;
  readonly unregisterDevice: (deviceId: string) => Effect.Effect<RelayOkResponse, RelayFailure>;
  readonly registerLiveActivity: (
    payload: RelayLiveActivityRegistrationRequest,
  ) => Effect.Effect<RelayOkResponse, RelayFailure>;
  readonly getAgentActivitySnapshot: Effect.Effect<
    RelayAgentActivitySnapshotResponse,
    RelayFailure
  >;
}

let bound: HostRelay | null = null;

export function bindHostRelay(next: HostRelay | null): void {
  bound = next;
}

/** Wraps the managed relay client; unbound, every call still goes where upstream sends it. */
export const layer = <A, E, R>(
  inner: Layer.Layer<A | ManagedRelay.ManagedRelayClient, E, R>,
): Layer.Layer<A | ManagedRelay.ManagedRelayClient, E, R> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const found = yield* Effect.serviceOption(ManagedRelay.ManagedRelayClient);
      // Tests stand the relay layer in with an empty one; there is nothing to wrap then.
      if (Option.isNone(found)) {
        return Context.empty() as Context.Context<ManagedRelay.ManagedRelayClient>;
      }
      const base = found.value;
      return Context.make(
        ManagedRelay.ManagedRelayClient,
        ManagedRelay.ManagedRelayClient.of({
          ...base,
          registerDevice: Effect.fnUntraced(function* (input) {
            return yield* bound ? bound.registerDevice(input.payload) : base.registerDevice(input);
          }),
          unregisterDevice: Effect.fnUntraced(function* (input) {
            return yield* bound
              ? bound.unregisterDevice(input.deviceId)
              : base.unregisterDevice(input);
          }),
          registerLiveActivity: Effect.fnUntraced(function* (input) {
            return yield* bound
              ? bound.registerLiveActivity(input.payload)
              : base.registerLiveActivity(input);
          }),
          getAgentActivitySnapshot: Effect.fnUntraced(function* (input) {
            return yield* bound
              ? bound.getAgentActivitySnapshot
              : base.getAgentActivitySnapshot(input);
          }),
        }),
      );
    }),
  ).pipe(Layer.provideMerge(inner));
