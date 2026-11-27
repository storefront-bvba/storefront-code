// Storefront Code (fork): the phone's side of the wake relay (F8). Kept apart from the host
// requests and free of native modules at import time, so the voice route can read it.
import {
  StorefrontWakeRelay,
  StorefrontWakeRelayHosts,
  type StorefrontWakeRelayHost,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

const RELAY_TIMEOUT_MS = 8_000;
const RELAY_KEY = "storefront.wake-relay";

const encodeRelay = Schema.encodeSync(Schema.fromJsonString(StorefrontWakeRelay));
const decodeRelay = Schema.decodeUnknownOption(Schema.fromJsonString(StorefrontWakeRelay));
const decodeRelayHosts = Schema.decodeUnknownEffect(StorefrontWakeRelayHosts);

// Loaded on first use: the keychain is native.
const secureStore = () => import("expo-secure-store");

export const loadWakeRelay = Effect.promise(() =>
  secureStore()
    .then((store) => store.getItemAsync(RELAY_KEY))
    .catch(() => null),
).pipe(Effect.map((raw) => (raw === null ? null : Option.getOrNull(decodeRelay(raw)))));

/** Keeps the relay a host handed out; a sleeping host can no longer hand it out. */
export const saveWakeRelay = Effect.fn("storefrontPower.saveWakeRelay")(function* (
  relay: StorefrontWakeRelay,
) {
  const known = yield* loadWakeRelay;
  if (known?.url === relay.url && known.token === relay.token) return;
  yield* Effect.promise(() =>
    secureStore()
      .then((store) => store.setItemAsync(RELAY_KEY, encodeRelay(relay)))
      .catch(() => undefined),
  );
  appAtomRegistry.refresh(relayHostsAtom);
});

export type RelayHosts =
  | { readonly _tag: "NoRelay" }
  | { readonly _tag: "Unreachable" }
  | { readonly _tag: "Ok"; readonly hosts: ReadonlyArray<StorefrontWakeRelayHost> };

const relayRequest = Effect.fn("storefrontPower.relayRequest")(
  function* (relay: StorefrontWakeRelay, path: string, method: "GET" | "POST") {
    const http = yield* HttpClient.HttpClient;
    const url = `${relay.url}${path}`;
    const request = method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url);
    return yield* http
      .execute(request.pipe(HttpClientRequest.bearerToken(relay.token)))
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.timeout(RELAY_TIMEOUT_MS),
      );
  },
  Effect.provide(FetchHttpClient.layer),
  // The request carries the token, so only the fact of the failure leaves here.
  Effect.mapError(() => "unreachable" as const),
);

export const relayHostsAtom = Atom.make(
  Effect.gen(function* () {
    const relay = yield* loadWakeRelay;
    if (relay === null) return { _tag: "NoRelay" } as RelayHosts;
    const response = yield* relayRequest(relay, "/v1/hosts", "GET");
    if (response.status !== 200) return { _tag: "Unreachable" } as RelayHosts;
    const body = yield* decodeRelayHosts(yield* response.json);
    return { _tag: "Ok", hosts: body.hosts } as RelayHosts;
  }).pipe(Effect.orElseSucceed((): RelayHosts => ({ _tag: "Unreachable" }))),
).pipe(Atom.keepAlive, Atom.withLabel("storefront-wake-relay-hosts"));

export type WakeOutcome = "waking" | "cannotWake" | "noRelay" | "failed";

export const wakeHost = Effect.fn("storefrontPower.wakeHost")(
  function* (hostId: string) {
    const relay = yield* loadWakeRelay;
    if (relay === null) return "noRelay" as WakeOutcome;
    const response = yield* relayRequest(
      relay,
      `/v1/hosts/${encodeURIComponent(hostId)}/wake`,
      "POST",
    );
    if (response.status === 409) return "cannotWake" as WakeOutcome;
    return (
      response.status === 202 || response.status === 200 ? "waking" : "failed"
    ) as WakeOutcome;
  },
  Effect.orElseSucceed((): WakeOutcome => "failed"),
  Effect.tap(() => Effect.sync(() => appAtomRegistry.refresh(relayHostsAtom))),
);
