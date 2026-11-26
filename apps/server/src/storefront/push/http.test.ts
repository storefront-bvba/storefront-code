import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@t3tools/contracts";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as NetAddress from "effect/net/NetAddress";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../../auth/http.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerHttp from "../../http.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as HostAgentActivity from "./HostAgentActivity.ts";
import * as StorefrontPushHttp from "./http.ts";

const DESKTOP_BOOTSTRAP_TOKEN = "test-desktop-bootstrap-token";
const ORIGIN = "http://100.64.0.2:3773";

class PushTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.auth,
  EnvironmentHttpApi.groups.storefrontPush,
) {}

const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
const fakeActivity = HostAgentActivity.HostAgentActivity.of({
  enabled: true,
  topics: ["be.storefront.code"],
  publish: () => Effect.void,
  registerDevice: (input) =>
    Effect.sync(() => {
      calls.push({ name: "registerDevice", input });
      return input.registration.bundleId === "be.storefront.code"
        ? ("registered" as const)
        : ("topic-not-allowed" as const);
    }),
  unregisterDevice: (deviceId) =>
    Effect.sync(() => void calls.push({ name: "unregister", input: deviceId })),
  registerLiveActivity: (input) =>
    Effect.sync(() => {
      calls.push({ name: "registerLiveActivity", input });
      return true;
    }),
  snapshot: Effect.succeed({ aggregate: null }),
  status: (input) =>
    Effect.succeed({
      enabled: true,
      topics: ["be.storefront.code"],
      device: input.deviceId
        ? {
            registered: true,
            hasPushToken: true,
            hasLiveActivity: false,
            apsEnvironment: "production" as const,
            registeredAt: "2026-11-26T12:00:00.000Z",
          }
        : null,
    }),
  testPush: () => Effect.succeed({ ok: true, apnsStatus: 200, apnsReason: null }),
  sweep: Effect.void,
  pruneSessions: () => Effect.void,
});

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "desktop" as const,
      host: "0.0.0.0",
      port: 3773,
      desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN,
    };
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-push-http-test-" })));

const layerRoutes = HttpApiBuilder.layer(PushTestApi).pipe(
  Layer.provide([AuthHttp.layer, StorefrontPushHttp.layerGroup]),
  Layer.provide(Layer.succeed(HostAgentActivity.HostAgentActivity, fakeActivity)),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provide(ServerHttp.layerApiBodyLimit),
  Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
  Layer.provide(EnvironmentAuth.layer),
  Layer.provide([
    ManagedPolicy.layerTest(),
    SqlitePersistence.layerMemory,
    ServerEnvironment.layerIdentity,
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make("omarchy"),
        label: "Omarchy",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: false },
      }),
    }),
    Layer.mock(HttpServer.HttpServer)({
      address: NetAddress.inetAddressFromIpStringUnsafe("0.0.0.0", 3773),
    }),
  ]),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(layerConfig),
  Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const registration: RelayDeviceRegistrationRequest = {
  deviceId: "phone-1",
  label: "iPhone",
  platform: "ios",
  iosMajorVersion: 26,
  bundleId: "be.storefront.code",
  apsEnvironment: "production",
  pushToken: "a".repeat(64),
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

const client = Effect.gen(function* () {
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
    (web) => Effect.promise(() => web.dispose()),
  );
  const request = (path: string, init: RequestInit = {}) =>
    Effect.promise(() => handler(new Request(`${ORIGIN}${path}`, init)));
  const exchange = Effect.fnUntraced(function* (credential: string) {
    const response = yield* request("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
      }),
    });
    expect(response.status).toBe(200);
    return ((yield* Effect.promise(() => response.json())) as { access_token: string })
      .access_token;
  });
  const pairedToken = Effect.fnUntraced(function* (scopes: ReadonlyArray<string>) {
    const admin = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN);
    const paired = yield* request("/api/auth/pairing-token", {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ scopes }),
    });
    expect(paired.status).toBe(200);
    const { credential } = (yield* Effect.promise(() => paired.json())) as { credential: string };
    return yield* exchange(credential);
  });
  return { request, pairedToken };
});

describe("storefrontPush endpoints", () => {
  it.effect("register a paired phone under its own session", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const { request, pairedToken } = yield* client;
      const token = yield* pairedToken(["orchestration:read"]);
      const json = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      const registered = yield* request("/api/storefront/push/devices/phone-1", {
        method: "PUT",
        headers: json,
        body: JSON.stringify(registration),
      });
      expect(registered.status).toBe(200);
      expect(yield* Effect.promise(() => registered.json())).toEqual({ ok: true });
      const input = calls[0]?.input as { readonly sessionId: string };
      expect(input.sessionId.length).toBeGreaterThan(0);

      const mismatch = yield* request("/api/storefront/push/devices/phone-2", {
        method: "PUT",
        headers: json,
        body: JSON.stringify(registration),
      });
      expect(mismatch.status).toBe(400);

      const foreignTopic = yield* request("/api/storefront/push/devices/phone-1", {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ ...registration, bundleId: "com.t3tools.t3code" }),
      });
      expect(foreignTopic.status).toBe(400);

      const status = yield* request("/api/storefront/push/status?deviceId=phone-1", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(status.status).toBe(200);
      expect(((yield* Effect.promise(() => status.json())) as { enabled: boolean }).enabled).toBe(
        true,
      );

      const live = yield* request("/api/storefront/push/live-activities", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ deviceId: "phone-1", activityPushToken: "b".repeat(64) }),
      });
      expect(live.status).toBe(200);
      const snapshot = yield* request("/api/storefront/push/agent-activity", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(yield* Effect.promise(() => snapshot.json())).toEqual({ aggregate: null });
    }).pipe(Effect.scoped),
  );

  it.effect("refuse callers without a session or without the read scope", () =>
    Effect.gen(function* () {
      const { request, pairedToken } = yield* client;
      const anonymous = yield* request("/api/storefront/push/status");
      expect(anonymous.status).toBe(401);
      const token = yield* pairedToken(["relay:read"]);
      const unscoped = yield* request("/api/storefront/push/status", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(unscoped.status).toBe(403);
    }).pipe(Effect.scoped),
  );
});
