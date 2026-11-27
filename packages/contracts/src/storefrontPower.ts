// Storefront Code (fork): Stay awake and Sleep when done for a host, and the address of our wake
// relay so clients can reach it while the host sleeps (fork/design/F8-sleep-and-wake.md).
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

// Types only: environmentHttp.ts adds this group, so a value import would be a cycle.
import type * as EnvironmentHttp from "./environmentHttp.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

export const SLEEP_WHEN_DONE_UNDO_SECONDS = 10;

export const StorefrontPowerWaitingFor = Schema.Literals([
  "activeRun",
  "screenUnlocked",
  "inhibitor",
]);
export type StorefrontPowerWaitingFor = typeof StorefrontPowerWaitingFor.Type;

export const StorefrontSleepWhenDone = Schema.Struct({
  state: Schema.Literals(["off", "pending", "armed"]),
  /** End of the undo window while `pending`. */
  pendingUntil: Schema.NullOr(Schema.String),
});
export type StorefrontSleepWhenDone = typeof StorefrontSleepWhenDone.Type;

export const StorefrontWakeRelay = Schema.Struct({ url: Schema.String, token: Schema.String });
export type StorefrontWakeRelay = typeof StorefrontWakeRelay.Type;

export const StorefrontPowerStatus = Schema.Struct({
  /** Whether this host can hold sleep off and suspend itself (Linux with logind, macOS). */
  supported: Schema.Boolean,
  stayAwake: Schema.Boolean,
  sleepWhenDone: StorefrontSleepWhenDone,
  waitingFor: Schema.Array(StorefrontPowerWaitingFor),
  lastError: Schema.NullOr(Schema.String),
  relay: Schema.NullOr(StorefrontWakeRelay),
});
export type StorefrontPowerStatus = typeof StorefrontPowerStatus.Type;

export const StorefrontPowerToggle = Schema.Struct({ on: Schema.Boolean });
export type StorefrontPowerToggle = typeof StorefrontPowerToggle.Type;

/** What the wake relay reports for one host (`GET /v1/hosts`). */
export const StorefrontWakeRelayHost = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: Schema.Literals(["awake", "waking", "asleep", "unreachable", "unknown"]),
  canWake: Schema.Boolean,
  wakeNote: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lastSeenAt: Schema.NullOr(Schema.String),
  sleptAt: Schema.NullOr(Schema.String),
  wakeRequestedAt: Schema.NullOr(Schema.String),
  stayAwake: Schema.Boolean,
  sleepWhenDone: Schema.Boolean,
});
export type StorefrontWakeRelayHost = typeof StorefrontWakeRelayHost.Type;

export const StorefrontWakeRelayHosts = Schema.Struct({
  now: Schema.String,
  hosts: Schema.Array(StorefrontWakeRelayHost),
});
export type StorefrontWakeRelayHosts = typeof StorefrontWakeRelayHosts.Type;

export interface StorefrontPowerHttpApiDependencies {
  readonly auth: typeof EnvironmentHttp.EnvironmentAuthenticatedAuth;
  readonly requestInvalid: typeof EnvironmentHttp.EnvironmentRequestInvalidError;
  readonly scopeRequired: typeof EnvironmentHttp.EnvironmentScopeRequiredError;
  readonly internal: typeof EnvironmentHttp.EnvironmentInternalError;
}

/** Built by environmentHttp.ts with its own middleware and errors, so both sides share them. */
export const makeStorefrontPowerHttpApi = (deps: StorefrontPowerHttpApiDependencies) => {
  const errors = [deps.requestInvalid, deps.scopeRequired, deps.internal] as const;
  return HttpApiGroup.make("storefrontPower")
    .add(
      HttpApiEndpoint.get("status", "/api/storefront/power", {
        headers: OptionalBearerHeaders,
        success: StorefrontPowerStatus,
        error: errors,
      }).middleware(deps.auth),
    )
    .add(
      HttpApiEndpoint.put("setStayAwake", "/api/storefront/power/stay-awake", {
        headers: OptionalBearerHeaders,
        payload: StorefrontPowerToggle,
        success: StorefrontPowerStatus,
        error: errors,
      }).middleware(deps.auth),
    )
    .add(
      HttpApiEndpoint.put("setSleepWhenDone", "/api/storefront/power/sleep-when-done", {
        headers: OptionalBearerHeaders,
        payload: StorefrontPowerToggle,
        success: StorefrontPowerStatus,
        error: errors,
      }).middleware(deps.auth),
    );
};
