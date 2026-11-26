import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { bumpHostPushAttempt, hostPushRelayKey, setHostPushHostsKey } from "./hostPushKey";
import * as HostRelayClient from "./hostRelayClient";

const relayCalls: Array<string> = [];
const relayClient = {
  registerDevice: () => Effect.sync(() => (relayCalls.push("registerDevice"), { ok: true })),
  unregisterDevice: () => Effect.sync(() => (relayCalls.push("unregisterDevice"), { ok: true })),
  registerLiveActivity: () =>
    Effect.sync(() => (relayCalls.push("registerLiveActivity"), { ok: true })),
  getAgentActivitySnapshot: () =>
    Effect.sync(() => (relayCalls.push("getAgentActivitySnapshot"), { aggregate: null })),
  relayUrl: "http://relay.invalid",
} as unknown as ManagedRelay.ManagedRelayClient["Service"];

const layer = HostRelayClient.layer(Layer.succeed(ManagedRelay.ManagedRelayClient, relayClient));
const payload = {
  deviceId: "phone-1",
  label: "iPhone",
  platform: "ios" as const,
  iosMajorVersion: 26,
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

afterEach(() => {
  HostRelayClient.bindHostRelay(null);
  setHostPushHostsKey(null);
  relayCalls.length = 0;
});

describe("hostRelayClient", () => {
  it.effect("keeps upstream's relay calls until the host client is bound", () =>
    Effect.gen(function* () {
      const client = yield* ManagedRelay.ManagedRelayClient;
      yield* client.registerDevice({ clerkToken: "t", payload });
      expect(relayCalls).toEqual(["registerDevice"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("sends the four agent-awareness calls to the hosts once bound", () =>
    Effect.gen(function* () {
      const hostCalls: Array<string> = [];
      HostRelayClient.bindHostRelay({
        registerDevice: (body) =>
          Effect.sync(() => (hostCalls.push(`device:${body.deviceId}`), { ok: true })),
        unregisterDevice: (deviceId) =>
          Effect.sync(() => (hostCalls.push(`unregister:${deviceId}`), { ok: true })),
        registerLiveActivity: (body) =>
          Effect.sync(() => (hostCalls.push(`activity:${body.activityPushToken}`), { ok: true })),
        getAgentActivitySnapshot: Effect.sync(
          () => (hostCalls.push("snapshot"), { aggregate: null }),
        ),
      });
      const client = yield* ManagedRelay.ManagedRelayClient;
      yield* client.registerDevice({ clerkToken: "t", payload });
      yield* client.unregisterDevice({ clerkToken: "t", deviceId: "phone-1" });
      yield* client.registerLiveActivity({
        clerkToken: "t",
        payload: { deviceId: "phone-1", activityPushToken: "token" },
      });
      yield* client.getAgentActivitySnapshot({ clerkToken: "t" });
      expect(hostCalls).toEqual([
        "device:phone-1",
        "unregister:phone-1",
        "activity:token",
        "snapshot",
      ]);
      expect(relayCalls).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("hostPushRelayKey", () => {
  it("is null without push hosts and changes with the hosts, the day and a forced attempt", () => {
    const morning = Date.parse("2026-11-26T08:00:00.000Z");
    expect(hostPushRelayKey(morning)).toBeNull();
    setHostPushHostsKey("env-1:session-1");
    const first = hostPushRelayKey(morning);
    expect(first).toContain("env-1:session-1");
    expect(hostPushRelayKey(morning + 60_000)).toBe(first);
    expect(hostPushRelayKey(morning + 24 * 60 * 60_000)).not.toBe(first);
    bumpHostPushAttempt();
    expect(hostPushRelayKey(morning)).not.toBe(first);
  });
});
