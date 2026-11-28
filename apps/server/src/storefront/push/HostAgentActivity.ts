// Storefront Code (fork): the relay's agent-activity service on the host (F5). Ported from
// upstream v0.1.12 (ca81b7b97a, MIT) infra/relay/src: AgentActivityPublisher.ts (770028f965),
// MobileRegistrations.ts and the worker.ts cron. Rows live in memory (rebuilt by the relay's
// catch-up); `node fork/scripts/check-push-port.mjs` flags upstream changes.
import type { ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivitySnapshotResponse,
  RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  isPermanentApnsTokenFailure,
  liveActivityAlertAtSend,
  pushNotificationAllowedAtSend,
  sendForTarget,
  skipContentlessEnd,
  type DeliverySender,
  type TargetRow,
} from "./deliveryPort.ts";
import * as DeviceStore from "./DeviceStore.ts";
import type { HostPushCredentials } from "./HostPushConfig.ts";
import {
  AgentActivityAggregate,
  AgentActivityPayloads,
  ApnsClient,
  type ApnsCredentials,
  type ApnsEnvironment,
  type ApnsNotificationPayload,
} from "./upstreamRelay.ts";

const { makeAggregateState, TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS } = AgentActivityAggregate;
const { isTerminalPhase, sanitizeAgentActivityAggregateState, sanitizeApnsNotificationPayload } =
  AgentActivityPayloads;

/** The relay keys rows by user; this host has one. */
const HOST_USER_ID = "host";
// worker.ts cron: finished rows stay 30 minutes, the sweep runs every 5 minutes.
const TERMINAL_ROW_RETENTION_MS = 30 * 60_000;
export const SWEEP_INTERVAL = "5 minutes";
// Storefront: iOS marks unfinished rows out of date 10 minutes after the last update (the stale
// date), so a card whose rows did not change is sent again while this host is alive.
export const REFRESH_INTERVAL = "1 minute";
const REFRESH_AFTER_MS = 4 * 60_000;
// A phone re-registers at least daily; one gone this long has left.
const REGISTRATION_TTL_MS = 14 * 24 * 60 * 60_000;
const ACTIVE_SESSIONS_CACHE_MS = 30_000;
// Transport failures, 429 and 5xx are retried here; the queue did that on the relay.
const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000] as const;

export type DeviceRegistrationOutcome =
  | "registered"
  | "disabled"
  | "topic-not-allowed"
  | "platform-not-supported";

export interface HostPushDeviceStatus {
  readonly registered: boolean;
  readonly hasPushToken: boolean;
  readonly hasLiveActivity: boolean;
  readonly apsEnvironment: ApnsEnvironment | null;
  readonly registeredAt: string | null;
}

export interface HostPushStatus {
  readonly enabled: boolean;
  readonly topics: ReadonlyArray<string>;
  readonly device: HostPushDeviceStatus | null;
}

export interface HostPushTestResult {
  readonly ok: boolean;
  readonly apnsStatus: number | null;
  readonly apnsReason: string | null;
}

export class HostAgentActivity extends Context.Service<
  HostAgentActivity,
  {
    readonly enabled: boolean;
    readonly topics: ReadonlyArray<string>;
    readonly publish: (input: {
      readonly environmentId: string;
      readonly threadId: ThreadId;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<void>;
    readonly registerDevice: (input: {
      readonly sessionId: string;
      readonly registration: RelayDeviceRegistrationRequest;
    }) => Effect.Effect<DeviceRegistrationOutcome, DeviceStore.DeviceStorePersistenceError>;
    readonly unregisterDevice: (
      deviceId: string,
    ) => Effect.Effect<void, DeviceStore.DeviceStorePersistenceError>;
    readonly registerLiveActivity: (input: {
      readonly deviceId: string;
      readonly activityPushToken: string;
    }) => Effect.Effect<boolean, DeviceStore.DeviceStorePersistenceError>;
    readonly snapshot: Effect.Effect<RelayAgentActivitySnapshotResponse>;
    readonly status: (input: {
      readonly sessionId: string;
      readonly deviceId: string | undefined;
    }) => Effect.Effect<HostPushStatus>;
    readonly testPush: (deviceId: string) => Effect.Effect<HostPushTestResult>;
    readonly sweep: Effect.Effect<void>;
    readonly pruneSessions: (sessionIds: ReadonlySet<string>) => Effect.Effect<void>;
    /** Storefront: sends unfinished cards again once their last update is a few minutes old. */
    readonly refresh: Effect.Effect<void>;
    /** Storefront: every card learns that this host goes to sleep (true) or woke up (false). */
    readonly hostAsleep: (asleep: boolean) => Effect.Effect<void>;
  }
>()("t3/storefront/push/HostAgentActivity") {}

function rowKey(environmentId: string, threadId: string): string {
  return JSON.stringify([environmentId, threadId]);
}

function epochMillis(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function targetForDevice(device: DeviceStore.DeviceRecord): TargetRow | null {
  const registration = device.registration;
  if (registration === null) return null;
  const liveActivity = device.liveActivity;
  return {
    user_id: HOST_USER_ID,
    device_id: device.deviceId,
    platform: registration.platform,
    ios_major_version: registration.iosMajorVersion ?? null,
    app_version: registration.appVersion ?? null,
    bundle_id: device.bundleId,
    aps_environment: device.apsEnvironment,
    push_token: device.pushToken,
    push_to_start_token: null,
    preferences_json: JSON.stringify(registration.preferences),
    activity_push_token: liveActivity?.activityPushToken ?? null,
    remote_start_queued_at: null,
    remote_started_at: liveActivity?.armedAt ?? null,
    ended_at: liveActivity?.endedAt ?? null,
    last_aggregate_json: liveActivity?.lastAggregate
      ? JSON.stringify(liveActivity.lastAggregate)
      : null,
    last_live_activity_delivery_at: liveActivity?.lastDeliveryAt ?? null,
  };
}

interface ApnsResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string;
  readonly apnsId: string | null;
}

export const make = Effect.fn("storefront.push.HostAgentActivity.make")(function* (options: {
  readonly credentials: HostPushCredentials | null;
  readonly retryDelaysMs?: ReadonlyArray<number>;
}) {
  const store = yield* DeviceStore.DeviceStore;
  const apns = yield* ApnsClient.ApnsClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const credentials = options.credentials;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const topics = credentials?.topics ?? [];
  // One delivery at a time keeps each card's updates in order, as the relay's per-device queue did.
  const lock = yield* Semaphore.make(1);
  const rows = new Map<string, RelayAgentActivityState>();
  // Storefront: set while the host sleeps; cards then carry `hostAsleepAt` for the widget.
  let asleepSince: string | null = null;

  let activeSessions: { readonly at: number; readonly ids: ReadonlySet<string> } | null = null;
  const activeSessionIds = Effect.gen(function* () {
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    if (activeSessions !== null && nowMs - activeSessions.at < ACTIVE_SESSIONS_CACHE_MS) {
      return activeSessions.ids;
    }
    const listed = yield* auth.listSessions().pipe(
      Effect.map((sessions) => new Set<string>(sessions.map((session) => session.sessionId))),
      Effect.tapError((error) =>
        Effect.logWarning("push: active sessions unavailable; using the last list", {
          error: error._tag,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (listed === null) return activeSessions?.ids ?? null;
    activeSessions = { at: nowMs, ids: listed };
    return listed;
  });

  // `AgentActivityRows.listForUser`, newest first.
  const listRows = () =>
    [...rows.values()].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // `LiveActivities.listTargets`, limited to phones whose session on this host still lives.
  const listTargets = Effect.gen(function* () {
    const sessionIds = yield* activeSessionIds;
    const devices = yield* store.list;
    return devices.flatMap((device) => {
      if (sessionIds !== null && (device.sessionId === null || !sessionIds.has(device.sessionId))) {
        return [];
      }
      if (device.bundleId !== null && !topics.includes(device.bundleId)) return [];
      const target = targetForDevice(device);
      return target === null ? [] : [target];
    });
  });

  const saveOrLog = (transition: (devices: DeviceStore.DeviceMap) => DeviceStore.DeviceMap) =>
    store.update(transition).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logWarning("push: device list not saved", { error: error.message }),
      ),
    );

  const credentialsFor = (
    key: HostPushCredentials,
    target: TargetRow,
    environment: ApnsEnvironment,
  ): ApnsCredentials => ({
    teamId: key.teamId,
    keyId: key.keyId,
    privateKey: key.privateKey,
    bundleId: target.bundle_id ?? topics[0] ?? "",
    environment,
  });

  const isTransient = (result: ApnsResult) =>
    !result.ok && (result.status === 0 || result.status === 429 || result.status >= 500);

  const attempt = Effect.fnUntraced(function* (
    target: TargetRow,
    environment: ApnsEnvironment,
    request: (credentials: ApnsCredentials) => Effect.Effect<ApnsResult, ApnsClient.ApnsError>,
  ) {
    let result: ApnsResult = {
      ok: false,
      status: 0,
      reason: "Push is not configured.",
      apnsId: null,
    };
    if (credentials === null) return result;
    for (let index = 0; index <= retryDelaysMs.length; index += 1) {
      result = yield* request(credentialsFor(credentials, target, environment)).pipe(
        Effect.catch((error) =>
          Effect.logWarning("push: APNs request failed", {
            deviceId: target.device_id,
            error: error._tag,
          }).pipe(
            Effect.as<ApnsResult>({ ok: false, status: 0, reason: error._tag, apnsId: null }),
          ),
        ),
      );
      const delay = retryDelaysMs[index];
      if (!isTransient(result) || delay === undefined) break;
      yield* Effect.sleep(delay);
    }
    if (!result.ok) {
      yield* Effect.logInfo("push: APNs refused a delivery", {
        deviceId: target.device_id,
        status: result.status,
        reason: result.reason ?? null,
        environment,
      });
    }
    return result;
  });

  // The phone says sandbox or production; a token from the other one answers BadDeviceToken,
  // so try the other once and remember it when it works.
  const deliver = Effect.fnUntraced(function* (
    target: TargetRow,
    request: (credentials: ApnsCredentials) => Effect.Effect<ApnsResult, ApnsClient.ApnsError>,
  ) {
    const environment: ApnsEnvironment = target.aps_environment ?? "production";
    const result = yield* attempt(target, environment, request);
    if (result.status !== 400 || result.reason !== "BadDeviceToken") return result;
    const other: ApnsEnvironment = environment === "production" ? "sandbox" : "production";
    const retried = yield* attempt(target, other, request);
    if (retried.ok) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* saveOrLog((devices) =>
        DeviceStore.setApsEnvironment(devices, {
          deviceId: target.device_id,
          apsEnvironment: other,
          now,
        }),
      );
    }
    return retried;
  });

  const hasContentToShow = (nowMs: number) =>
    makeAggregateState({ activeStates: listRows(), terminalState: null, nowMs }) !== null;

  // ApnsDeliveries.sendLiveActivity without the queue's claim and staleness bookkeeping.
  const sendLiveActivity: DeliverySender<never>["liveActivity"] = Effect.fnUntraced(
    function* (input) {
      const now = yield* DateTime.now;
      const nowMs = now.epochMilliseconds;
      const nowIso = DateTime.formatIso(now);
      const epochSeconds = Math.floor(nowMs / 1_000);
      const aggregate =
        input.aggregate === null ? null : sanitizeAgentActivityAggregateState(input.aggregate);
      const alert = liveActivityAlertAtSend({
        target: input.target,
        aggregate,
        alert: input.alert,
        nowMs,
      });
      if (
        skipContentlessEnd({
          target: input.target,
          kind: input.kind,
          aggregate,
          hasContentToShow: hasContentToShow(nowMs),
        })
      ) {
        return;
      }
      const base = { token: input.token, nowEpochSeconds: epochSeconds, nowIso };
      const shown =
        aggregate !== null && asleepSince !== null
          ? { ...aggregate, hostAsleepAt: asleepSince }
          : aggregate;
      const request =
        input.kind === "live_activity_update" && shown !== null
          ? apns.makeLiveActivityRequest({ ...base, event: "update", state: shown, alert })
          : apns.makeLiveActivityRequest({ ...base, event: "end", state: aggregate, alert });
      const result = yield* deliver(input.target, (credentials) =>
        apns.sendLiveActivityRequest({ credentials, request, issuedAtUnixSeconds: epochSeconds }),
      );
      if (result.ok) {
        yield* saveOrLog((devices) =>
          DeviceStore.markDelivery(devices, {
            deviceId: input.target.device_id,
            kind: input.kind,
            aggregate,
            deliveredAt: nowIso,
          }),
        );
      } else if (isPermanentApnsTokenFailure(result)) {
        yield* saveOrLog((devices) =>
          DeviceStore.invalidateToken(devices, {
            deviceId: input.target.device_id,
            kind: input.kind,
            now: nowIso,
          }),
        );
      }
    },
  );

  const sendPushNotification = Effect.fnUntraced(function* (input: {
    readonly target: TargetRow;
    readonly token: string;
    readonly notification: ApnsNotificationPayload;
    readonly force?: boolean;
  }) {
    const now = yield* DateTime.now;
    const nowMs = now.epochMilliseconds;
    const epochSeconds = Math.floor(nowMs / 1_000);
    const notification = sanitizeApnsNotificationPayload(input.notification);
    if (
      input.force !== true &&
      !pushNotificationAllowedAtSend({ target: input.target, notification, nowMs })
    ) {
      return null;
    }
    const built = apns.makePushNotificationRequest({ token: input.token, notification });
    // Wouter (2026-11-27): a finished thread only rings; the card shows what is done, never a banner.
    const request =
      notification.phase === "completed"
        ? {
            ...built,
            payload: {
              aps: { sound: "default" },
              body: {
                environmentId: notification.environmentId,
                threadId: notification.threadId,
                deepLink: notification.deepLink,
              },
            },
          }
        : built;
    const result = yield* deliver(input.target, (credentials) =>
      apns.sendPushNotificationRequest({ credentials, request, issuedAtUnixSeconds: epochSeconds }),
    );
    if (isPermanentApnsTokenFailure(result)) {
      yield* saveOrLog((devices) =>
        DeviceStore.invalidateToken(devices, {
          deviceId: input.target.device_id,
          kind: "push_notification",
          now: DateTime.formatIso(now),
        }),
      );
    }
    return result;
  });

  const sender: DeliverySender<never> = {
    pushNotification: (input) => sendPushNotification(input).pipe(Effect.asVoid),
    liveActivity: sendLiveActivity,
  };

  const deliverSafely = <A>(effect: Effect.Effect<A>) =>
    credentials === null
      ? Effect.void
      : lock.withPermit(effect).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("push: delivery failed", { cause: String(cause) }),
          ),
        );

  // AgentActivityPublisher.publish and publishForDeliveryUser.
  const publish: HostAgentActivity["Service"]["publish"] = (input) =>
    deliverSafely(
      Effect.gen(function* () {
        const key = rowKey(input.environmentId, input.threadId);
        // Retain terminal rows until the sweep so completed threads stay beside active ones.
        if (input.state) rows.set(key, input.state);
        else rows.delete(key);
        const nowMs = (yield* DateTime.now).epochMilliseconds;
        const targets = yield* listTargets;
        // Only iOS targets with a running Live Activity read the aggregate.
        const aggregate = targets.some(
          (target) => target.platform !== "android" && target.activity_push_token,
        )
          ? makeAggregateState({
              activeStates: listRows(),
              terminalState: input.state && isTerminalPhase(input.state) ? input.state : null,
              nowMs,
            })
          : null;
        yield* Effect.forEach(
          targets.filter((target) => target.platform === "ios"),
          (target) => sendForTarget({ target, aggregate, state: input.state, nowMs }, sender),
          { discard: true },
        );
      }),
    );

  // AgentActivityPublisher.replayForLiveActivityRegistration.
  const replay = (deviceId: string) =>
    deliverSafely(
      Effect.gen(function* () {
        const target = (yield* listTargets).find((row) => row.device_id === deviceId) ?? null;
        if (target === null || target.platform !== "ios") return;
        const nowMs = (yield* DateTime.now).epochMilliseconds;
        const aggregate = makeAggregateState({
          activeStates: listRows(),
          terminalState: null,
          nowMs,
        });
        yield* sendForTarget({ target, aggregate, nowMs, replay: true }, sender);
      }),
    );

  const registerDevice: HostAgentActivity["Service"]["registerDevice"] = Effect.fnUntraced(
    function* (input) {
      if (credentials === null) return "disabled" as const;
      if (input.registration.platform !== "ios") return "platform-not-supported" as const;
      const bundleId = input.registration.bundleId;
      if (bundleId === undefined || !topics.includes(bundleId)) {
        return "topic-not-allowed" as const;
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* store.update((devices) =>
        DeviceStore.registerDevice(devices, {
          sessionId: input.sessionId,
          registration: input.registration,
          now,
        }),
      );
      yield* replay(input.registration.deviceId);
      return "registered" as const;
    },
  );

  const registerLiveActivity: HostAgentActivity["Service"]["registerLiveActivity"] =
    Effect.fnUntraced(function* (input) {
      if (credentials === null) return false;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* store.update((devices) =>
        DeviceStore.registerLiveActivity(devices, { ...input, now }),
      );
      yield* replay(input.deviceId);
      return true;
    });

  const snapshot = Effect.gen(function* () {
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    return {
      aggregate: makeAggregateState({ activeStates: listRows(), terminalState: null, nowMs }),
    } satisfies { readonly aggregate: RelayAgentActivityAggregateState | null };
  });

  const status: HostAgentActivity["Service"]["status"] = Effect.fnUntraced(function* (input) {
    if (input.deviceId === undefined) {
      return { enabled: credentials !== null, topics, device: null };
    }
    const device = yield* store.get(input.deviceId);
    return {
      enabled: credentials !== null,
      topics,
      device: {
        registered:
          device !== null && device.registration !== null && device.sessionId === input.sessionId,
        hasPushToken: device?.pushToken != null,
        hasLiveActivity: device?.liveActivity?.activityPushToken != null,
        apsEnvironment: device?.apsEnvironment ?? null,
        registeredAt: device?.registeredAt ?? null,
      },
    };
  });

  const testPush: HostAgentActivity["Service"]["testPush"] = Effect.fnUntraced(
    function* (deviceId) {
      if (credentials === null) {
        return { ok: false, apnsStatus: null, apnsReason: "Push is not configured on this host." };
      }
      const device = yield* store.get(deviceId);
      const target = device === null ? null : targetForDevice(device);
      if (target === null || target.push_token === null) {
        return { ok: false, apnsStatus: null, apnsReason: "This device has no push token here." };
      }
      const token = target.push_token;
      const result = yield* lock.withPermit(
        sendPushNotification({
          target,
          token,
          force: true,
          notification: {
            title: "Storefront Code",
            body: "Test notification from your host.",
            environmentId: "",
            threadId: "",
            deepLink: "/",
          },
        }),
      );
      return {
        ok: result?.ok ?? false,
        apnsStatus: result === null || result.status === 0 ? null : result.status,
        apnsReason: result?.reason ?? null,
      };
    },
  );

  // worker.ts cron, AgentActivityPublisher.endIdleLiveActivities and the 14-day expiry.
  const sweep = deliverSafely(
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowMs = now.epochMilliseconds;
      for (const [key, state] of rows) {
        const updatedAtMs = epochMillis(state.updatedAt);
        if (isTerminalPhase(state) && nowMs - updatedAtMs > TERMINAL_ROW_RETENTION_MS) {
          rows.delete(key);
        }
      }
      const deliveredBefore = nowMs - TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS;
      const idleDeviceIds = new Set(
        (yield* store.list)
          .filter((device) => {
            const liveActivity = device.liveActivity;
            if (!liveActivity?.activityPushToken) return false;
            const lastMs = epochMillis(
              liveActivity.lastDeliveryAt ?? liveActivity.armedAt ?? liveActivity.updatedAt,
            );
            return lastMs < deliveredBefore;
          })
          .map((device) => device.deviceId),
      );
      if (
        idleDeviceIds.size > 0 &&
        makeAggregateState({ activeStates: listRows(), terminalState: null, nowMs }) === null
      ) {
        const targets = (yield* listTargets).filter((target) =>
          idleDeviceIds.has(target.device_id),
        );
        yield* Effect.forEach(
          targets,
          (target) => sendForTarget({ target, aggregate: null, nowMs, replay: true }, sender),
          { discard: true },
        );
      }
      const registeredBefore = DateTime.formatIso(
        DateTime.subtract(now, { milliseconds: REGISTRATION_TTL_MS }),
      );
      yield* saveOrLog((devices) => DeviceStore.pruneDevices(devices, { registeredBefore }));
    }),
  );

  const liveCards = Effect.map(listTargets, (targets) =>
    targets.flatMap((target) =>
      target.platform === "ios" && target.activity_push_token
        ? [{ target, token: target.activity_push_token }]
        : [],
    ),
  );
  // The relay skips a card that did not change; these send it regardless.
  const resend = (target: TargetRow, token: string, aggregate: RelayAgentActivityAggregateState) =>
    sendLiveActivity({ target, kind: "live_activity_update", token, aggregate, alert: null });

  const refresh = deliverSafely(
    Effect.gen(function* () {
      if (asleepSince !== null) return;
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const aggregate = makeAggregateState({
        activeStates: listRows(),
        terminalState: null,
        nowMs,
      });
      // Finished rows keep their look when the card goes stale; only unfinished ones need this.
      if (
        aggregate === null ||
        aggregate.activities.every((row) => row.phase === "completed" || row.phase === "failed")
      ) {
        return;
      }
      for (const { target, token } of yield* liveCards) {
        const lastMs = epochMillis(target.last_live_activity_delivery_at);
        if (nowMs - lastMs >= REFRESH_AFTER_MS) yield* resend(target, token, aggregate);
      }
    }),
  );

  const hostAsleep: HostAgentActivity["Service"]["hostAsleep"] = (asleep) =>
    deliverSafely(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        asleepSince = asleep ? (asleepSince ?? DateTime.formatIso(now)) : null;
        const nowMs = now.epochMilliseconds;
        const aggregate = makeAggregateState({
          activeStates: listRows(),
          terminalState: null,
          nowMs,
        });
        // Before sleep the network is about to go: reach every card at once.
        yield* Effect.forEach(
          yield* liveCards,
          ({ target, token }) =>
            aggregate !== null
              ? resend(target, token, aggregate)
              : asleep
                ? Effect.void
                : sendForTarget({ target, aggregate: null, nowMs, replay: true }, sender),
          { concurrency: "unbounded", discard: true },
        );
      }),
    );

  const pruneSessions: HostAgentActivity["Service"]["pruneSessions"] = (sessionIds) =>
    Effect.suspend(() => {
      activeSessions = null;
      return saveOrLog((devices) =>
        DeviceStore.pruneDevices(devices, { removedSessionIds: sessionIds }),
      );
    });

  return HostAgentActivity.of({
    enabled: credentials !== null,
    topics,
    publish,
    registerDevice,
    unregisterDevice: Effect.fnUntraced(function* (deviceId: string) {
      yield* store.update((devices) => DeviceStore.unregisterDevice(devices, deviceId));
    }),
    registerLiveActivity,
    snapshot,
    status,
    testPush,
    sweep,
    pruneSessions,
    refresh,
    hostAsleep,
  });
});
