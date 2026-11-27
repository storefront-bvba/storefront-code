// Storefront Code (fork): the phone's side of F8 (fork/design/F8-sleep-and-wake.md). Hosts answer
// over the phone's own connection; the wake relay is asked directly, with the address and token a
// host handed out (kept in the keychain), so Wake up works while every host sleeps.
import {
  type EnvironmentId,
  StorefrontPowerStatus,
  StorefrontWakeRelay,
  StorefrontWakeRelayHosts,
  type StorefrontWakeRelayHost,
} from "@t3tools/contracts";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { Atom } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { answer, type HostAnswer, type RequestError, settle } from "../push/hostPushClient";

const REQUEST_TIMEOUT_MS = 10_000;
const RELAY_TIMEOUT_MS = 8_000;
const RELAY_KEY = "storefront.wake-relay";

type PowerRequest = Parameters<
  typeof executeConnectedEnvironmentHttpRequest<
    "storefrontPower",
    HttpClientResponse.HttpClientResponse,
    RequestError,
    never
  >
>[0];

const call = (input: Pick<PowerRequest, "method" | "url" | "request">) =>
  executeConnectedEnvironmentHttpRequest<
    "storefrontPower",
    HttpClientResponse.HttpClientResponse,
    RequestError,
    never
  >({
    group: "storefrontPower",
    method: input.method,
    url: input.url,
    timeoutMs: REQUEST_TIMEOUT_MS,
    requestInit: { redirect: "error" },
    isUnauthorizedResponse: (response) => response.status === 401,
    request: input.request,
  }).pipe(Effect.flatMap(answer(StorefrontPowerStatus)));

const statusCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "storefrontPowerStatus",
  execute: () =>
    call({
      method: "GET",
      url: (urls) => urls.status(),
      request: ({ client, headers }) => client.status({ headers, responseMode: "response-only" }),
    }),
});

const stayAwakeCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "storefrontPowerStayAwake",
  execute: (on: boolean) =>
    call({
      method: "PUT",
      url: (urls) => urls.setStayAwake(),
      request: ({ client, headers }) =>
        client.setStayAwake({ headers, payload: { on }, responseMode: "response-only" }),
    }),
});

const sleepWhenDoneCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "storefrontPowerSleepWhenDone",
  execute: (on: boolean) =>
    call({
      method: "PUT",
      url: (urls) => urls.setSleepWhenDone(),
      request: ({ client, headers }) =>
        client.setSleepWhenDone({ headers, payload: { on }, responseMode: "response-only" }),
    }),
});

const encodeRelay = Schema.encodeSync(Schema.fromJsonString(StorefrontWakeRelay));
const decodeRelay = Schema.decodeUnknownOption(Schema.fromJsonString(StorefrontWakeRelay));
const decodeRelayHosts = Schema.decodeUnknownEffect(StorefrontWakeRelayHosts);

export const loadWakeRelay = Effect.promise(() =>
  SecureStore.getItemAsync(RELAY_KEY).catch(() => null),
).pipe(Effect.map((raw) => (raw === null ? null : Option.getOrNull(decodeRelay(raw)))));

// The relay outlives every host's answer: a sleeping host can no longer hand it out.
const rememberRelay = (status: HostAnswer<StorefrontPowerStatus>) =>
  status._tag !== "Ok" || status.value.relay === null
    ? Effect.void
    : Effect.gen(function* () {
        const relay = status.value.relay;
        if (relay === null) return;
        const known = yield* loadWakeRelay;
        if (known?.url === relay.url && known.token === relay.token) return;
        yield* Effect.promise(() =>
          SecureStore.setItemAsync(RELAY_KEY, encodeRelay(relay)).catch(() => undefined),
        );
        appAtomRegistry.refresh(relayHostsAtom);
      });

const withRelay = (effect: Effect.Effect<HostAnswer<StorefrontPowerStatus>>) =>
  effect.pipe(Effect.tap(rememberRelay));

export const hostPowerStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    withRelay(settle(statusCommand.run(appAtomRegistry, { environmentId, input: undefined }))),
  ).pipe(Atom.withLabel(`storefront-power-status:${environmentId}`)),
);

export const setStayAwake = (environmentId: EnvironmentId, on: boolean) =>
  withRelay(settle(stayAwakeCommand.run(appAtomRegistry, { environmentId, input: on })));

export const setSleepWhenDone = (environmentId: EnvironmentId, on: boolean) =>
  withRelay(settle(sleepWhenDoneCommand.run(appAtomRegistry, { environmentId, input: on })));

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
