// Storefront Code (fork): the phone's side of host-sent push. Each paired host that publishes
// agent activity gets the device and its tokens over the phone's own connection (DPoP renewal
// included); a host without the storefrontPush endpoints answers 404 and is skipped.
import type {
  EnvironmentAuthInvalidError,
  EnvironmentId,
  EnvironmentInternalError,
} from "@t3tools/contracts";
import {
  RelayAgentActivitySnapshotResponse,
  RelayOkResponse,
  type RelayDeviceRegistrationRequest,
  type RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpClientError, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { loadAgentAwarenessDeviceId } from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentSession } from "../../state/session";
import type { HostRelay } from "./hostRelayClient";

const REQUEST_TIMEOUT_MS = 10_000;

export const HostPushStatus = Schema.Struct({
  enabled: Schema.Boolean,
  topics: Schema.Array(Schema.String),
  device: Schema.NullOr(
    Schema.Struct({
      registered: Schema.Boolean,
      hasPushToken: Schema.Boolean,
      hasLiveActivity: Schema.Boolean,
      apsEnvironment: Schema.NullOr(Schema.String),
      registeredAt: Schema.NullOr(Schema.String),
    }),
  ),
});
export type HostPushStatus = typeof HostPushStatus.Type;

const HostPushTestResult = Schema.Struct({
  ok: Schema.Boolean,
  apnsStatus: Schema.NullOr(Schema.Number),
  apnsReason: Schema.NullOr(Schema.String),
});
export type HostPushTestResult = typeof HostPushTestResult.Type;

export type HostAnswer<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Unsupported" }
  | { readonly _tag: "Refused"; readonly status: number };

const answer =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      if (response.status === 404) return { _tag: "Unsupported" } as HostAnswer<A>;
      if (response.status !== 200) {
        return { _tag: "Refused", status: response.status } as HostAnswer<A>;
      }
      const value = yield* Schema.decodeUnknownEffect(schema)(yield* response.json);
      return { _tag: "Ok", value } as HostAnswer<A>;
    });

type RequestError =
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | EnvironmentAuthInvalidError
  | EnvironmentInternalError;

type PushRequest = Parameters<
  typeof executeConnectedEnvironmentHttpRequest<
    "storefrontPush",
    HttpClientResponse.HttpClientResponse,
    RequestError,
    never
  >
>[0];

// One request to the supervised host; renewal and DPoP proofs come from client-runtime.
const call = <A, I>(
  schema: Schema.Codec<A, I>,
  input: Pick<PushRequest, "method" | "url" | "request">,
) =>
  executeConnectedEnvironmentHttpRequest<
    "storefrontPush",
    HttpClientResponse.HttpClientResponse,
    RequestError,
    never
  >({
    group: "storefrontPush",
    method: input.method,
    url: input.url,
    timeoutMs: REQUEST_TIMEOUT_MS,
    requestInit: { redirect: "error" },
    isUnauthorizedResponse: (response) => response.status === 401,
    request: input.request,
  }).pipe(Effect.flatMap(answer(schema)));

const statusCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "storefrontPushStatus",
  execute: (deviceId: string | null) => {
    const query = deviceId === null ? {} : { deviceId };
    return call(HostPushStatus, {
      method: "GET",
      url: (urls) => urls.status({ query }),
      request: ({ client, headers }) =>
        client.status({ headers, query, responseMode: "response-only" }),
    });
  },
});

const registerDeviceCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "storefrontPushRegisterDevice",
  execute: (payload: RelayDeviceRegistrationRequest) => {
    const params = { deviceId: payload.deviceId };
    return call(RelayOkResponse, {
      method: "PUT",
      url: (urls) => urls.registerDevice({ params }),
      request: ({ client, headers }) =>
        client.registerDevice({ headers, params, payload, responseMode: "response-only" }),
    });
  },
});

const unregisterDeviceCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "storefrontPushUnregisterDevice",
  execute: (deviceId: string) => {
    const params = { deviceId };
    return call(RelayOkResponse, {
      method: "DELETE",
      url: (urls) => urls.unregisterDevice({ params }),
      request: ({ client, headers }) =>
        client.unregisterDevice({ headers, params, responseMode: "response-only" }),
    });
  },
});

const registerLiveActivityCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "storefrontPushRegisterLiveActivity",
  execute: (payload: RelayLiveActivityRegistrationRequest) =>
    call(RelayOkResponse, {
      method: "POST",
      url: (urls) => urls.registerLiveActivity(),
      request: ({ client, headers }) =>
        client.registerLiveActivity({ headers, payload, responseMode: "response-only" }),
    }),
});

const snapshotCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "storefrontPushAgentActivity",
  execute: () =>
    call(RelayAgentActivitySnapshotResponse, {
      method: "GET",
      url: (urls) => urls.agentActivity(),
      request: ({ client, headers }) =>
        client.agentActivity({ headers, responseMode: "response-only" }),
    }),
});

const testPushCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "storefrontPushTest",
  execute: (deviceId: string) => {
    const params = { deviceId };
    return call(HostPushTestResult, {
      method: "POST",
      url: (urls) => urls.testPush({ params }),
      request: ({ client, headers }) =>
        client.testPush({ headers, params, responseMode: "response-only" }),
    });
  },
});

export interface PushHost {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string | null;
}

// A session that is briefly unknown during a reconnect must not look like a new one.
const knownSessionIds = new Map<EnvironmentId, string>();

/** Paired hosts that publish agent activity, in a stable order; the first one feeds the card. */
export const pushHostsAtom = Atom.make((get): ReadonlyArray<PushHost> => {
  const hosts: Array<PushHost> = [];
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.agentActivityPublishing !== true) continue;
    const session = AsyncResult.getOrElse(
      get(environmentSession.sessionStateAtom(environmentId)),
      () => null,
    );
    if (session?.sessionId) knownSessionIds.set(environmentId, session.sessionId);
    hosts.push({ environmentId, sessionId: knownSessionIds.get(environmentId) ?? null });
  }
  return [...hosts].sort((a, b) => a.environmentId.localeCompare(b.environmentId));
}).pipe(Atom.keepAlive, Atom.withLabel("storefront-push-hosts"));

export function pushHostsKey(hosts: ReadonlyArray<PushHost>): string | null {
  if (hosts.length === 0) return null;
  return hosts.map((host) => `${host.environmentId}:${host.sessionId ?? ""}`).join(",");
}

const connectedHostIds = () =>
  appAtomRegistry
    .get(pushHostsAtom)
    .map((host) => host.environmentId)
    .filter((environmentId) =>
      Option.isSome(
        appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
      ),
    );

const settle = <A, E>(effect: Effect.Effect<HostAnswer<A>, E>) =>
  effect.pipe(
    Effect.catchCause(() => Effect.succeed({ _tag: "Refused", status: 0 } as HostAnswer<A>)),
  );

const failed = (action: ManagedRelay.ManagedRelayRequestAction, cause: unknown) =>
  new ManagedRelay.ManagedRelayRequestFailedError({ action, cause });

export const hostPushStatus = (environmentId: EnvironmentId, deviceId: string | null) =>
  settle(statusCommand.run(appAtomRegistry, { environmentId, input: deviceId }));

/** What a host says about push and this phone; refresh it after a change. */
export const hostPushStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    Effect.gen(function* () {
      const deviceId = yield* Effect.promise(() => loadAgentAwarenessDeviceId().catch(() => null));
      return yield* hostPushStatus(environmentId, deviceId);
    }),
  ).pipe(Atom.withLabel(`storefront-push-status:${environmentId}`)),
);

export const sendHostTestPush = (environmentId: EnvironmentId, deviceId: string) =>
  settle(testPushCommand.run(appAtomRegistry, { environmentId, input: deviceId }));

export const hostPushRelay: HostRelay = {
  // Alerts come from every host; registration counts when one of them took it.
  registerDevice: Effect.fn("storefrontPush.registerDevice")(function* (payload) {
    const answers = yield* Effect.forEach(
      connectedHostIds(),
      (environmentId) =>
        settle(registerDeviceCommand.run(appAtomRegistry, { environmentId, input: payload })),
      { concurrency: 3 },
    );
    if (answers.some((result) => result._tag === "Ok" && result.value.ok)) return { ok: true };
    return yield* failed("register relay mobile device", answers);
  }),
  unregisterDevice: (deviceId) =>
    Effect.forEach(
      connectedHostIds(),
      (environmentId) =>
        settle(unregisterDeviceCommand.run(appAtomRegistry, { environmentId, input: deviceId })),
      { concurrency: 3, discard: true },
    ).pipe(Effect.as({ ok: true })),
  // One host feeds the Live Activity, so two hosts never fight over the card.
  registerLiveActivity: Effect.fn("storefrontPush.registerLiveActivity")(function* (payload) {
    for (const environmentId of connectedHostIds()) {
      const result = yield* settle(
        registerLiveActivityCommand.run(appAtomRegistry, { environmentId, input: payload }),
      );
      if (result._tag === "Ok" && result.value.ok) return { ok: true };
    }
    return yield* failed("register relay live activity", "no push host took the token");
  }),
  getAgentActivitySnapshot: Effect.gen(function* () {
    for (const environmentId of connectedHostIds()) {
      const result = yield* settle(
        snapshotCommand.run(appAtomRegistry, { environmentId, input: undefined }),
      );
      if (result._tag === "Ok") return result.value;
    }
    return yield* failed("read relay agent activity snapshot", "no push host answered");
  }),
};
