// Storefront Code (fork): the phone's side of F8 (fork/design/F8-sleep-and-wake.md). Hosts answer
// over the phone's own connection; the wake relay is asked directly, with the address and token a
// host handed out (kept in the keychain), so Wake up works while every host sleeps.
import { type EnvironmentId, StorefrontPowerStatus } from "@t3tools/contracts";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type { HttpClientResponse } from "effect/http";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { answer, type HostAnswer, type RequestError, settle } from "../push/hostPushClient";
import { saveWakeRelay } from "./wakeRelayClient";

const REQUEST_TIMEOUT_MS = 10_000;

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

// The relay outlives every host's answer: a sleeping host can no longer hand it out.
const rememberRelay = (status: HostAnswer<StorefrontPowerStatus>) =>
  status._tag !== "Ok" || status.value.relay === null
    ? Effect.void
    : Effect.gen(function* () {
        const relay = status.value.relay;
        if (relay === null) return;
        yield* saveWakeRelay(relay);
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
