// Storefront Code (fork): upstream's APNs delivery rules, copied from v0.1.12 (ca81b7b97a, MIT)
// infra/relay/src/agentActivity/ApnsDeliveries.ts (9b1ea43cc4): lines 56-89 and 130-318 verbatim
// but for types (deliveryEvent left out); 1045-1095 and send-time checks of 631-924 send at once.
// `node fork/scripts/check-push-port.mjs` fails when upstream changes these regions.
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
  RelayDeliveryKind,
} from "@t3tools/contracts/relay";
import {
  RelayAgentActivityAggregateState as RelayAgentActivityAggregateStateSchema,
  RelayAgentAwarenessPreferences as RelayAgentAwarenessPreferencesSchema,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  AgentActivityAggregate,
  AgentActivityAlerts,
  AgentActivityPayloads,
  type ApnsClient,
  type ApnsLiveActivityAlert,
  type ApnsNotificationPayload,
} from "./upstreamRelay.ts";

const { isExpiredAgentActivityState, notificationForActivity } = AgentActivityPayloads;
const { statusForPhase } = AgentActivityAggregate;
const {
  alertForAttentionTransition,
  alertForNewlyTerminal,
  alertForTerminalAggregate,
  rowPhasesChanged,
  shouldAlertForActivity,
} = AgentActivityAlerts;

/** The relay's `LiveActivities.TargetRow`: a device row joined with its Live Activity row. */
export interface TargetRow {
  readonly user_id: string;
  readonly device_id: string;
  readonly platform: "ios" | "android";
  readonly ios_major_version: number | null;
  readonly app_version: string | null;
  readonly bundle_id: string | null;
  readonly aps_environment: "sandbox" | "production" | null;
  readonly push_token: string | null;
  readonly push_to_start_token: string | null;
  readonly preferences_json: string;
  readonly activity_push_token: string | null;
  readonly remote_start_queued_at: string | null;
  readonly remote_started_at: string | null;
  readonly ended_at: string | null;
  readonly last_aggregate_json: string | null;
  readonly last_live_activity_delivery_at: string | null;
}

const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
const FRESHLY_ARMED_GRACE_MS = 2 * 60 * 1_000;
const PERMANENT_APNS_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

export type LiveActivityDeliveryKind = Extract<
  RelayDeliveryKind,
  "live_activity_update" | "live_activity_end"
>;

export type ChosenLiveActivityDelivery =
  | {
      readonly kind: "live_activity_update";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState;
      readonly alert: ApnsLiveActivityAlert | null;
    }
  | {
      readonly kind: "live_activity_end";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly alert: ApnsLiveActivityAlert | null;
    };

export type ChosenPushNotificationDelivery = {
  readonly kind: "push_notification";
  readonly token: string;
  readonly notification: ApnsNotificationPayload;
};

export type ChosenDelivery = ChosenLiveActivityDelivery | ChosenPushNotificationDelivery;

const decodeRelayAgentActivityAggregateStateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentActivityAggregateStateSchema),
);
const decodeRelayAgentAwarenessPreferencesJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferencesSchema),
);

function parseAggregate(value: string | null): RelayAgentActivityAggregateState | null {
  if (!value) {
    return null;
  }
  return Option.getOrNull(decodeRelayAgentActivityAggregateStateJson(value));
}

function parsePreferences(value: string): RelayAgentAwarenessPreferences | null {
  return Option.getOrNull(decodeRelayAgentAwarenessPreferencesJson(value));
}

function aggregateNeedsAttention(aggregate: RelayAgentActivityAggregateState): boolean {
  return aggregate.activities.some(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
}

function shouldUpdateLiveActivity(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly lastDeliveryAt: string | null;
  readonly nowMs: number;
}): boolean {
  if (!input.previousAggregate) {
    return true;
  }
  if (JSON.stringify(input.previousAggregate) === JSON.stringify(input.nextAggregate)) {
    return false;
  }
  if (input.previousAggregate.activeCount !== input.nextAggregate.activeCount) {
    return true;
  }
  if (aggregateNeedsAttention(input.nextAggregate)) {
    return true;
  }
  // Phase and row changes may be the last update until the next transition.
  // Throttling them would leave the card showing a stale state indefinitely.
  if (rowPhasesChanged(input.previousAggregate, input.nextAggregate)) {
    return true;
  }
  const lastDeliveryAtMs =
    input.lastDeliveryAt === null
      ? null
      : Option.match(DateTime.make(input.lastDeliveryAt), {
          onNone: () => Number.NaN,
          onSome: (dt) => dt.epochMilliseconds,
        });
  return (
    lastDeliveryAtMs === null ||
    Number.isNaN(lastDeliveryAtMs) ||
    input.nowMs - lastDeliveryAtMs >= MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS
  );
}

// Aggregate rows may belong to unrelated threads; fallback pushes use the published state.
function notificationForState(input: {
  readonly target: TargetRow;
  readonly state?: RelayAgentActivityState | null;
  readonly nowMs: number;
}): ApnsNotificationPayload | null {
  const state = input.state;
  if (!input.target.push_token || !state || isExpiredAgentActivityState(state, input.nowMs)) {
    return null;
  }
  const preferences = parsePreferences(input.target.preferences_json);
  if (!shouldAlertForActivity({ ...state, preferences, nowMs: input.nowMs })) return null;
  return notificationForActivity({ ...state, status: statusForPhase(state.phase) });
}

// Suppressed Live Activity updates must not fall back to alert pushes or unchanged replays would ring.
function chooseLiveActivityDelivery(input: {
  readonly target: TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
  readonly replay?: boolean;
}): ChosenLiveActivityDelivery | "suppressed" | null {
  const preferences = parsePreferences(input.target.preferences_json);
  if (preferences?.liveActivitiesEnabled === false) {
    return input.target.activity_push_token
      ? {
          kind: "live_activity_end",
          token: input.target.activity_push_token,
          aggregate: null,
          alert: null,
        }
      : null;
  }
  if (!input.target.activity_push_token) {
    return null;
  }
  if (input.aggregate === null) {
    // Registration replay can precede a new thread's first publish; preserve a freshly armed card until state arrives.
    const armedAtMs = Option.match(
      input.target.remote_started_at === null
        ? Option.none()
        : DateTime.make(input.target.remote_started_at),
      { onNone: () => null, onSome: (dt) => dt.epochMilliseconds },
    );
    if (armedAtMs !== null && input.nowMs - armedAtMs < FRESHLY_ARMED_GRACE_MS) {
      return null;
    }
    return {
      kind: "live_activity_end",
      token: input.target.activity_push_token,
      aggregate: null,
      alert: null,
    };
  }
  const nextAggregate = input.aggregate;
  const previousAggregate = parseAggregate(input.target.last_aggregate_json);
  return shouldUpdateLiveActivity({
    previousAggregate,
    nextAggregate,
    lastDeliveryAt: input.target.last_live_activity_delivery_at,
    nowMs: input.nowMs,
  })
    ? {
        kind: "live_activity_update",
        token: input.target.activity_push_token,
        aggregate: nextAggregate,
        alert: input.replay
          ? null
          : (alertForAttentionTransition({
              previousAggregate,
              nextAggregate,
              preferences,
            }) ??
            alertForNewlyTerminal({
              previousAggregate,
              nextAggregate,
              preferences,
              nowMs: input.nowMs,
              includeUnobserved: true,
            })),
      }
    : "suppressed";
}

function chooseDelivery(input: {
  readonly target: TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly state?: RelayAgentActivityState | null;
  readonly nowMs: number;
  readonly replay?: boolean;
}): ChosenDelivery | null {
  const liveActivityDelivery = chooseLiveActivityDelivery(input);
  if (liveActivityDelivery === "suppressed") {
    return null;
  }
  if (liveActivityDelivery) {
    return liveActivityDelivery;
  }
  const notification = input.replay ? null : notificationForState(input);
  return notification && input.target.push_token
    ? {
        kind: "push_notification",
        token: input.target.push_token,
        notification,
      }
    : null;
}

export function isPermanentApnsTokenFailure(result: ApnsClient.ApnsDeliveryResult): boolean {
  return (
    !result.ok &&
    (result.status === 410 ||
      (result.status === 400 &&
        result.reason !== undefined &&
        PERMANENT_APNS_TOKEN_REASONS.has(result.reason)))
  );
}

export interface DeliverySender<E> {
  readonly pushNotification: (input: {
    readonly target: TargetRow;
    readonly token: string;
    readonly notification: ApnsNotificationPayload;
  }) => Effect.Effect<void, E>;
  readonly liveActivity: (
    input:
      | {
          readonly target: TargetRow;
          readonly kind: "live_activity_update";
          readonly token: string;
          readonly aggregate: RelayAgentActivityAggregateState;
          readonly alert: ApnsLiveActivityAlert | null;
        }
      | {
          readonly target: TargetRow;
          readonly kind: "live_activity_end";
          readonly token: string;
          readonly aggregate: RelayAgentActivityAggregateState | null;
          readonly alert: ApnsLiveActivityAlert | null;
        },
  ) => Effect.Effect<void, E>;
}

/** ApnsDeliveries.ts:1045-1095, sending at once where the relay enqueued. */
export const sendForTarget = Effect.fnUntraced(function* <E>(
  input: {
    readonly target: TargetRow;
    readonly aggregate: RelayAgentActivityAggregateState | null;
    readonly state?: RelayAgentActivityState | null;
    readonly nowMs: number;
    readonly replay?: boolean;
  },
  send: DeliverySender<E>,
) {
  const delivery = chooseDelivery(input);
  if (!delivery) {
    return;
  }
  if (delivery.kind === "push_notification") {
    yield* send.pushNotification({
      target: input.target,
      token: delivery.token,
      notification: delivery.notification,
    });
    return;
  }
  const notification = input.replay ? null : notificationForState(input);
  // Use the end alert only when no companion notification will ring, preserving feedback for Live-Activity-only users.
  const alert = input.replay
    ? null
    : delivery.kind === "live_activity_end"
      ? notification && input.target.push_token
        ? null
        : alertForTerminalAggregate({
            aggregate: delivery.aggregate,
            preferences: parsePreferences(input.target.preferences_json),
          })
      : delivery.alert;
  yield* delivery.kind === "live_activity_update"
    ? send.liveActivity({
        target: input.target,
        kind: delivery.kind,
        token: delivery.token,
        aggregate: delivery.aggregate,
        alert,
      })
    : send.liveActivity({
        target: input.target,
        kind: delivery.kind,
        token: delivery.token,
        aggregate: delivery.aggregate,
        alert,
      });
  if (delivery.kind === "live_activity_end" && notification && input.target.push_token) {
    yield* send.pushNotification({
      target: input.target,
      token: input.target.push_token,
      notification,
    });
  }
});

/** ApnsDeliveries.ts:691-709: the alert is re-derived from current preferences and card. */
export function liveActivityAlertAtSend(input: {
  readonly target: TargetRow;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly alert: ApnsLiveActivityAlert | null;
  readonly nowMs: number;
}): ApnsLiveActivityAlert | null {
  if (!input.alert) return null;
  const preferences = parsePreferences(input.target.preferences_json);
  const previousAggregate = parseAggregate(input.target.last_aggregate_json);
  const aggregate = input.aggregate;
  return !preferences?.notificationsEnabled || !aggregate
    ? null
    : (alertForAttentionTransition({
        previousAggregate,
        nextAggregate: aggregate,
        preferences,
      }) ??
        alertForNewlyTerminal({
          previousAggregate,
          nextAggregate: aggregate,
          preferences,
          nowMs: input.nowMs,
          includeUnobserved: true,
        }));
}

/** ApnsDeliveries.ts:723-736: a contentless end must not retire a card newer work owns. */
export function skipContentlessEnd(input: {
  readonly target: TargetRow;
  readonly kind: LiveActivityDeliveryKind;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly hasContentToShow: boolean;
}): boolean {
  return (
    input.kind === "live_activity_end" &&
    input.aggregate === null &&
    parsePreferences(input.target.preferences_json)?.liveActivitiesEnabled !== false &&
    input.hasContentToShow
  );
}

/** ApnsDeliveries.ts:873-890: the alert check made when the notification is sent. */
export function pushNotificationAllowedAtSend(input: {
  readonly target: TargetRow;
  readonly notification: ApnsNotificationPayload;
  readonly nowMs: number;
}): boolean {
  const notification = input.notification;
  const preferences = parsePreferences(input.target.preferences_json);
  return notification.phase !== undefined && notification.updatedAt !== undefined
    ? shouldAlertForActivity({
        ...notification,
        phase: notification.phase,
        updatedAt: notification.updatedAt,
        preferences,
        nowMs: input.nowMs,
      })
    : preferences?.notificationsEnabled === true;
}
