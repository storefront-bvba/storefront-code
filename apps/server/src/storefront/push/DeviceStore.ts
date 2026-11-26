// Storefront Code (fork): this host's phones, in `<stateDir>/storefront/push-devices.json`
// (mode 600, atomic writes), never in the database: upstream's migration chain stays as it is.
// Records mirror the relay's device and Live Activity rows, so the ported rules see the same
// fields (fork/design/F5-host-push.md).
import {
  RelayAgentActivityAggregateState,
  RelayApnsEnvironment,
  RelayDeviceRegistrationRequest,
  type RelayDeliveryKind,
} from "@t3tools/contracts/relay";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";

export const LiveActivityRecord = Schema.Struct({
  activityPushToken: Schema.NullOr(Schema.String),
  /** When the phone armed the card; upstream's `remote_started_at`. */
  armedAt: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
  lastAggregate: Schema.NullOr(RelayAgentActivityAggregateState),
  lastDeliveryAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type LiveActivityRecord = typeof LiveActivityRecord.Type;

export const DeviceRecord = Schema.Struct({
  deviceId: Schema.String,
  /** The auth session that last registered the device; pushes stop when it ends. */
  sessionId: Schema.NullOr(Schema.String),
  registration: Schema.NullOr(RelayDeviceRegistrationRequest),
  pushToken: Schema.NullOr(Schema.String),
  bundleId: Schema.NullOr(Schema.String),
  /** Starts as the phone's own claim; flips once when Apple says the token is for the other one. */
  apsEnvironment: Schema.NullOr(RelayApnsEnvironment),
  registeredAt: Schema.NullOr(Schema.String),
  liveActivity: Schema.NullOr(LiveActivityRecord),
  updatedAt: Schema.String,
});
export type DeviceRecord = typeof DeviceRecord.Type;

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  devices: Schema.Array(DeviceRecord),
});

const decodeStoreFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StoreFile));
const encodeStoreFile = Schema.encodeEffect(Schema.fromJsonString(StoreFile));

export type DeliveryKind = Exclude<RelayDeliveryKind, "live_activity_start">;

export type DeviceMap = ReadonlyMap<string, DeviceRecord>;

// Pure transitions, each the counterpart of a relay table write.

/** `Devices.register`: a push token belongs to one device; omitted fields keep their value. */
export function registerDevice(
  devices: DeviceMap,
  input: {
    readonly sessionId: string;
    readonly registration: RelayDeviceRegistrationRequest;
    readonly now: string;
  },
): DeviceMap {
  const next = new Map(devices);
  const registration = input.registration;
  if (registration.pushToken) {
    for (const [id, device] of next) {
      if (id !== registration.deviceId && device.pushToken === registration.pushToken) {
        next.set(id, { ...device, pushToken: null, updatedAt: input.now });
      }
    }
  }
  const current = next.get(registration.deviceId);
  const apsEnvironment = registration.apsEnvironment ?? current?.apsEnvironment ?? null;
  next.set(registration.deviceId, {
    deviceId: registration.deviceId,
    sessionId: input.sessionId,
    registration,
    pushToken: registration.pushToken ?? current?.pushToken ?? null,
    bundleId: registration.bundleId ?? current?.bundleId ?? null,
    // A remembered flip holds while the phone keeps sending the same claim.
    apsEnvironment:
      current?.registration?.apsEnvironment === registration.apsEnvironment &&
      current?.pushToken === (registration.pushToken ?? current?.pushToken)
        ? (current?.apsEnvironment ?? apsEnvironment)
        : apsEnvironment,
    registeredAt: input.now,
    liveActivity: current?.liveActivity ?? null,
    updatedAt: input.now,
  });
  return next;
}

export function unregisterDevice(devices: DeviceMap, deviceId: string): DeviceMap {
  if (!devices.has(deviceId)) return devices;
  const next = new Map(devices);
  next.delete(deviceId);
  return next;
}

function emptyDevice(deviceId: string, now: string): DeviceRecord {
  return {
    deviceId,
    sessionId: null,
    registration: null,
    pushToken: null,
    bundleId: null,
    apsEnvironment: null,
    registeredAt: null,
    liveActivity: null,
    updatedAt: now,
  };
}

/** `LiveActivities.register`, including its rule that a token refresh keeps the arming time. */
export function registerLiveActivity(
  devices: DeviceMap,
  input: { readonly deviceId: string; readonly activityPushToken: string; readonly now: string },
): DeviceMap {
  const next = new Map(devices);
  const current = next.get(input.deviceId);
  // Port of LiveActivities.ts:159-163 (upstream 67661cfbb5): a foreground token refresh must
  // retain the original arming time or grace can swallow an owed end event.
  const armedAt =
    (current?.liveActivity?.activityPushToken === input.activityPushToken
      ? current.liveActivity.armedAt
      : null) ?? input.now;
  for (const [id, device] of next) {
    if (device.liveActivity?.activityPushToken === input.activityPushToken) {
      next.set(id, {
        ...device,
        liveActivity: {
          ...device.liveActivity,
          activityPushToken: null,
          armedAt: null,
          endedAt: input.now,
          updatedAt: input.now,
        },
      });
    }
  }
  const base = next.get(input.deviceId) ?? emptyDevice(input.deviceId, input.now);
  next.set(input.deviceId, {
    ...base,
    liveActivity: {
      activityPushToken: input.activityPushToken,
      armedAt,
      endedAt: null,
      lastAggregate: null,
      lastDeliveryAt: null,
      updatedAt: input.now,
    },
    updatedAt: input.now,
  });
  return next;
}

/** `LiveActivities.markDelivery`: an end retires the token, an update keeps it. */
export function markDelivery(
  devices: DeviceMap,
  input: {
    readonly deviceId: string;
    readonly kind: DeliveryKind;
    readonly aggregate: RelayAgentActivityAggregateState | null;
    readonly deliveredAt: string;
  },
): DeviceMap {
  const current = devices.get(input.deviceId);
  if (!current) return devices;
  const liveActivity = current.liveActivity;
  const next = new Map(devices);
  next.set(input.deviceId, {
    ...current,
    liveActivity: {
      activityPushToken:
        input.kind === "live_activity_update" ? (liveActivity?.activityPushToken ?? null) : null,
      armedAt: liveActivity?.armedAt ?? null,
      endedAt:
        input.kind === "live_activity_end" ? input.deliveredAt : (liveActivity?.endedAt ?? null),
      lastAggregate: input.aggregate,
      lastDeliveryAt: input.deliveredAt,
      updatedAt: input.deliveredAt,
    },
    updatedAt: input.deliveredAt,
  });
  return next;
}

/** `LiveActivities.invalidateDeliveryToken`: Apple said the token is dead. */
export function invalidateToken(
  devices: DeviceMap,
  input: { readonly deviceId: string; readonly kind: DeliveryKind; readonly now: string },
): DeviceMap {
  const current = devices.get(input.deviceId);
  if (!current) return devices;
  const next = new Map(devices);
  if (input.kind === "push_notification") {
    next.set(input.deviceId, { ...current, pushToken: null, updatedAt: input.now });
    return next;
  }
  if (!current.liveActivity) return devices;
  next.set(input.deviceId, {
    ...current,
    liveActivity: {
      ...current.liveActivity,
      activityPushToken: null,
      armedAt: null,
      endedAt: input.now,
      updatedAt: input.now,
    },
    updatedAt: input.now,
  });
  return next;
}

export function setApsEnvironment(
  devices: DeviceMap,
  input: {
    readonly deviceId: string;
    readonly apsEnvironment: RelayApnsEnvironment;
    readonly now: string;
  },
): DeviceMap {
  const current = devices.get(input.deviceId);
  if (!current || current.apsEnvironment === input.apsEnvironment) return devices;
  const next = new Map(devices);
  next.set(input.deviceId, {
    ...current,
    apsEnvironment: input.apsEnvironment,
    updatedAt: input.now,
  });
  return next;
}

/** Drops devices whose session ended and registrations the phone stopped refreshing. */
export function pruneDevices(
  devices: DeviceMap,
  input: {
    readonly removedSessionIds?: ReadonlySet<string>;
    readonly registeredBefore?: string;
  },
): DeviceMap {
  let next: Map<string, DeviceRecord> | null = null;
  for (const [id, device] of devices) {
    const sessionEnded =
      device.sessionId !== null && input.removedSessionIds?.has(device.sessionId) === true;
    const stale =
      input.registeredBefore !== undefined &&
      (device.registeredAt === null
        ? device.updatedAt < input.registeredBefore
        : device.registeredAt < input.registeredBefore);
    if (sessionEnded || stale) {
      next ??= new Map(devices);
      next.delete(id);
    }
  }
  return next ?? devices;
}

export class DeviceStorePersistenceError extends Schema.TaggedError<DeviceStorePersistenceError>()(
  "DeviceStorePersistenceError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to save the push device list to ${this.filePath}.`;
  }
}

export class DeviceStore extends Context.Service<
  DeviceStore,
  {
    readonly filePath: string;
    readonly list: Effect.Effect<ReadonlyArray<DeviceRecord>>;
    readonly get: (deviceId: string) => Effect.Effect<DeviceRecord | null>;
    /** Applies a transition and saves the result; a failed save keeps the change in memory. */
    readonly update: (
      transition: (devices: DeviceMap) => DeviceMap,
    ) => Effect.Effect<DeviceMap, DeviceStorePersistenceError>;
  }
>()("t3/storefront/push/DeviceStore") {}

const STORE_RELATIVE_PATH = ["storefront", "push-devices.json"] as const;

export const make = Effect.fn("storefront.push.DeviceStore.make")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const loaded = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeStoreFile),
    Effect.map((file) => new Map(file.devices.map((device) => [device.deviceId, device]))),
    Effect.catch((error) =>
      Effect.gen(function* () {
        const missing =
          typeof error === "object" &&
          error !== null &&
          "reason" in error &&
          (error.reason as { readonly _tag?: string })._tag === "NotFound";
        if (!missing) {
          yield* Effect.logWarning("push device list unreadable; starting empty", { filePath });
        }
        return new Map<string, DeviceRecord>();
      }),
    ),
  );
  let devices: DeviceMap = loaded;

  const persist = (next: DeviceMap) =>
    encodeStoreFile({ version: 1, devices: [...next.values()] }).pipe(
      Effect.flatMap((contents) =>
        fs
          .makeDirectory(path.dirname(filePath), { recursive: true, mode: 0o700 })
          .pipe(Effect.andThen(writeFileStringAtomically({ filePath, contents }))),
      ),
      Effect.provide(services),
      Effect.mapError((cause) => new DeviceStorePersistenceError({ filePath, cause })),
    );

  return DeviceStore.of({
    filePath,
    list: Effect.sync(() => [...devices.values()]),
    get: Effect.fnUntraced(function* (deviceId: string) {
      return yield* Effect.sync(() => devices.get(deviceId) ?? null);
    }),
    update: Effect.fnUntraced(function* (
      transition: (devices: DeviceMap) => DeviceMap,
    ): Effect.fn.Return<DeviceMap, DeviceStorePersistenceError> {
      return yield* lock.withPermit(
        Effect.suspend(() => {
          const next = transition(devices);
          if (next === devices) return Effect.succeed(devices);
          devices = next;
          return persist(next).pipe(Effect.as(next));
        }),
      );
    }),
  });
});

export const layer = Layer.effect(
  DeviceStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* make(path.join(config.stateDir, ...STORE_RELATIVE_PATH));
  }),
);
