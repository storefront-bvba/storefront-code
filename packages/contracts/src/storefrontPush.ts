// Storefront Code (fork): the phone registers its push and Live Activity tokens with the host it
// is paired with, and the host sends them to Apple itself (fork/design/F5-host-push.md). The
// bodies are T3's relay schemas, so the phone sends what it sent the relay before.
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
// Types only: environmentHttp.ts adds this group, so a value import would be a cycle.
import type * as EnvironmentHttp from "./environmentHttp.ts";
import {
  RelayAgentActivitySnapshotResponse,
  RelayApnsEnvironment,
  RelayDeviceRegistrationRequest,
  RelayLiveActivityRegistrationRequest,
  RelayOkResponse,
} from "./relay.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const StorefrontPushDeviceParams = Schema.Struct({ deviceId: TrimmedNonEmptyString });

export const StorefrontPushStatusQuery = Schema.Struct({
  deviceId: Schema.optionalKey(TrimmedNonEmptyString),
});

export const StorefrontPushDeviceStatus = Schema.Struct({
  registered: Schema.Boolean,
  hasPushToken: Schema.Boolean,
  hasLiveActivity: Schema.Boolean,
  apsEnvironment: Schema.NullOr(RelayApnsEnvironment),
  registeredAt: Schema.NullOr(Schema.String),
});
export type StorefrontPushDeviceStatus = typeof StorefrontPushDeviceStatus.Type;

export const StorefrontPushStatus = Schema.Struct({
  enabled: Schema.Boolean,
  /** Bundle IDs this host may push to (`STOREFRONT_APNS_TOPICS`). */
  topics: Schema.Array(Schema.String),
  device: Schema.NullOr(StorefrontPushDeviceStatus),
});
export type StorefrontPushStatus = typeof StorefrontPushStatus.Type;

export const StorefrontPushTestResult = Schema.Struct({
  ok: Schema.Boolean,
  apnsStatus: Schema.NullOr(Schema.Number),
  apnsReason: Schema.NullOr(Schema.String),
});
export type StorefrontPushTestResult = typeof StorefrontPushTestResult.Type;

export interface StorefrontPushHttpApiDependencies {
  readonly auth: typeof EnvironmentHttp.EnvironmentAuthenticatedAuth;
  readonly requestInvalid: typeof EnvironmentHttp.EnvironmentRequestInvalidError;
  readonly scopeRequired: typeof EnvironmentHttp.EnvironmentScopeRequiredError;
  readonly internal: typeof EnvironmentHttp.EnvironmentInternalError;
}

/** Built by environmentHttp.ts with its own middleware and errors, so both sides share them. */
export const makeStorefrontPushHttpApi = (deps: StorefrontPushHttpApiDependencies) => {
  const errors = [deps.requestInvalid, deps.scopeRequired, deps.internal] as const;
  return HttpApiGroup.make("storefrontPush")
    .add(
      HttpApiEndpoint.get("status", "/api/storefront/push/status", {
        headers: OptionalBearerHeaders,
        query: StorefrontPushStatusQuery,
        success: StorefrontPushStatus,
        error: errors,
      }).middleware(deps.auth),
    )
    .add(
      HttpApiEndpoint.put("registerDevice", "/api/storefront/push/devices/:deviceId", {
        headers: OptionalBearerHeaders,
        params: StorefrontPushDeviceParams,
        payload: RelayDeviceRegistrationRequest,
        success: RelayOkResponse,
        error: errors,
      }).middleware(deps.auth),
    )
    .add(
      HttpApiEndpoint.delete("unregisterDevice", "/api/storefront/push/devices/:deviceId", {
        headers: OptionalBearerHeaders,
        params: StorefrontPushDeviceParams,
        success: RelayOkResponse,
        error: errors,
      }).middleware(deps.auth),
    )
    .add(
      HttpApiEndpoint.post("testPush", "/api/storefront/push/devices/:deviceId/test", {
        headers: OptionalBearerHeaders,
        params: StorefrontPushDeviceParams,
        success: StorefrontPushTestResult,
        error: errors,
      }).middleware(deps.auth),
    )
    .add(
      HttpApiEndpoint.post("registerLiveActivity", "/api/storefront/push/live-activities", {
        headers: OptionalBearerHeaders,
        payload: RelayLiveActivityRegistrationRequest,
        success: RelayOkResponse,
        error: errors,
      }).middleware(deps.auth),
    )
    .add(
      HttpApiEndpoint.get("agentActivity", "/api/storefront/push/agent-activity", {
        headers: OptionalBearerHeaders,
        success: RelayAgentActivitySnapshotResponse,
        error: errors,
      }).middleware(deps.auth),
    );
};
