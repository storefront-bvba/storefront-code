import { assert, describe, it } from "@effect/vitest";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import * as DeviceStore from "./DeviceStore.ts";
import { hostPushSettingsConfig, parseTopics } from "./HostPushConfig.ts";

const registration = (
  overrides: Partial<RelayDeviceRegistrationRequest> = {},
): RelayDeviceRegistrationRequest => ({
  deviceId: "phone-1",
  label: "iPhone",
  platform: "ios",
  iosMajorVersion: 26,
  bundleId: "be.storefront.code",
  apsEnvironment: "production",
  pushToken: "token-1",
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
  ...overrides,
});

describe("DeviceStore transitions", () => {
  it("gives a push token to one device and keeps fields a refresh leaves out", () => {
    let devices: DeviceStore.DeviceMap = new Map();
    devices = DeviceStore.registerDevice(devices, {
      sessionId: "s1",
      registration: registration(),
      now: "2026-11-26T10:00:00.000Z",
    });
    devices = DeviceStore.registerDevice(devices, {
      sessionId: "s1",
      registration: registration({ deviceId: "phone-2" }),
      now: "2026-11-26T10:01:00.000Z",
    });
    assert.isNull(devices.get("phone-1")?.pushToken ?? null);
    assert.equal(devices.get("phone-2")?.pushToken, "token-1");

    const { pushToken: _pushToken, ...withoutToken } = registration({ deviceId: "phone-2" });
    devices = DeviceStore.registerDevice(devices, {
      sessionId: "s2",
      registration: withoutToken,
      now: "2026-11-26T10:02:00.000Z",
    });
    assert.equal(devices.get("phone-2")?.pushToken, "token-1");
    assert.equal(devices.get("phone-2")?.sessionId, "s2");
  });

  it("keeps the arming time when the phone re-sends the same Live Activity token", () => {
    let devices: DeviceStore.DeviceMap = new Map();
    devices = DeviceStore.registerLiveActivity(devices, {
      deviceId: "phone-1",
      activityPushToken: "activity-1",
      now: "2026-11-26T10:00:00.000Z",
    });
    devices = DeviceStore.registerLiveActivity(devices, {
      deviceId: "phone-1",
      activityPushToken: "activity-1",
      now: "2026-11-26T10:05:00.000Z",
    });
    assert.equal(devices.get("phone-1")?.liveActivity?.armedAt, "2026-11-26T10:00:00.000Z");
    devices = DeviceStore.registerLiveActivity(devices, {
      deviceId: "phone-1",
      activityPushToken: "activity-2",
      now: "2026-11-26T10:06:00.000Z",
    });
    assert.equal(devices.get("phone-1")?.liveActivity?.armedAt, "2026-11-26T10:06:00.000Z");
  });

  it("retires a token on end and on a permanent failure", () => {
    let devices: DeviceStore.DeviceMap = DeviceStore.registerDevice(new Map(), {
      sessionId: "s1",
      registration: registration(),
      now: "2026-11-26T10:00:00.000Z",
    });
    devices = DeviceStore.registerLiveActivity(devices, {
      deviceId: "phone-1",
      activityPushToken: "activity-1",
      now: "2026-11-26T10:00:00.000Z",
    });
    devices = DeviceStore.markDelivery(devices, {
      deviceId: "phone-1",
      kind: "live_activity_update",
      aggregate: null,
      deliveredAt: "2026-11-26T10:01:00.000Z",
    });
    assert.equal(devices.get("phone-1")?.liveActivity?.activityPushToken, "activity-1");
    devices = DeviceStore.markDelivery(devices, {
      deviceId: "phone-1",
      kind: "live_activity_end",
      aggregate: null,
      deliveredAt: "2026-11-26T10:02:00.000Z",
    });
    assert.isNull(devices.get("phone-1")?.liveActivity?.activityPushToken ?? null);
    devices = DeviceStore.invalidateToken(devices, {
      deviceId: "phone-1",
      kind: "push_notification",
      now: "2026-11-26T10:03:00.000Z",
    });
    assert.isNull(devices.get("phone-1")?.pushToken ?? null);
  });

  it("prunes ended sessions and registrations older than the cut-off", () => {
    let devices: DeviceStore.DeviceMap = DeviceStore.registerDevice(new Map(), {
      sessionId: "s1",
      registration: registration(),
      now: "2026-11-01T10:00:00.000Z",
    });
    devices = DeviceStore.registerDevice(devices, {
      sessionId: "s2",
      registration: registration({ deviceId: "phone-2", pushToken: "token-2" }),
      now: "2026-11-26T10:00:00.000Z",
    });
    assert.deepStrictEqual(
      [...DeviceStore.pruneDevices(devices, { removedSessionIds: new Set(["s2"]) }).keys()],
      ["phone-1"],
    );
    assert.deepStrictEqual(
      [
        ...DeviceStore.pruneDevices(devices, {
          registeredBefore: "2026-11-12T10:00:00.000Z",
        }).keys(),
      ],
      ["phone-2"],
    );
  });

  it("keeps a learned APNs environment while the phone sends the same claim", () => {
    let devices: DeviceStore.DeviceMap = DeviceStore.registerDevice(new Map(), {
      sessionId: "s1",
      registration: registration({ apsEnvironment: "sandbox" }),
      now: "2026-11-26T10:00:00.000Z",
    });
    devices = DeviceStore.setApsEnvironment(devices, {
      deviceId: "phone-1",
      apsEnvironment: "production",
      now: "2026-11-26T10:01:00.000Z",
    });
    devices = DeviceStore.registerDevice(devices, {
      sessionId: "s1",
      registration: registration({ apsEnvironment: "sandbox" }),
      now: "2026-11-27T10:00:00.000Z",
    });
    assert.equal(devices.get("phone-1")?.apsEnvironment, "production");
    devices = DeviceStore.registerDevice(devices, {
      sessionId: "s1",
      registration: registration({ apsEnvironment: "sandbox", pushToken: "new-token" }),
      now: "2026-11-28T10:00:00.000Z",
    });
    assert.equal(devices.get("phone-1")?.apsEnvironment, "sandbox", "a new token starts over");
  });
});

describe("HostPushConfig", () => {
  const read = (env: Record<string, string>) =>
    hostPushSettingsConfig.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    );

  it.effect("is off unless all four variables are set", () =>
    Effect.gen(function* () {
      assert.isNull(yield* read({}));
      assert.isNull(
        yield* read({
          STOREFRONT_APNS_KEY_FILE: "/key.p8",
          STOREFRONT_APNS_KEY_ID: "R2MGM4T6A5",
          STOREFRONT_APNS_TEAM_ID: "2Z43A4WSC3",
        }),
      );
      assert.deepStrictEqual(
        yield* read({
          STOREFRONT_APNS_KEY_FILE: "/key.p8",
          STOREFRONT_APNS_KEY_ID: "R2MGM4T6A5",
          STOREFRONT_APNS_TEAM_ID: "2Z43A4WSC3",
          STOREFRONT_APNS_TOPICS: "be.storefront.code, be.storefront.code.dev",
        }),
        {
          keyFile: "/key.p8",
          keyId: "R2MGM4T6A5",
          teamId: "2Z43A4WSC3",
          topics: ["be.storefront.code", "be.storefront.code.dev"],
        },
      );
    }),
  );

  it("reads topics separated by commas or spaces and drops malformed ones", () => {
    assert.deepStrictEqual(parseTopics("be.storefront.code be.storefront.code,nope"), [
      "be.storefront.code",
    ]);
  });
});
