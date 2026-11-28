// Storefront Code (fork): builds host-sent push once per server (layers memoize by reference),
// for AgentAwarenessRelay (the sink) and the storefrontPush endpoints (fork/design/F5-host-push.md).
// Without STOREFRONT_APNS_* the sink stays null and nothing changes.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SessionStore from "../../auth/SessionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { AgentActivitySink } from "./AgentActivitySink.ts";
import * as DeviceStore from "./DeviceStore.ts";
import * as HostAgentActivity from "./HostAgentActivity.ts";
import { loadHostPushCredentials, readHostPushSettings } from "./HostPushConfig.ts";
import * as Http2HttpClient from "./http2HttpClient.ts";
import { ApnsClient, ApnsProviderTokens } from "./upstreamRelay.ts";

/** @public fork/scripts/apns-check.mjs proves the key with it, without a phone. */
export { runApnsCheck } from "./apnsCheck.ts";

// The HTTP/2 client serves APNs only; it is not the server's HttpClient.
const layerApns = ApnsClient.layer.pipe(
  Layer.provide(ApnsProviderTokens.layer),
  Layer.provide(Http2HttpClient.layer),
);

const make = Effect.gen(function* () {
  const settings = yield* readHostPushSettings;
  const credentials =
    settings === null
      ? null
      : yield* loadHostPushCredentials(settings).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`Storefront host push off: ${error.message}`).pipe(Effect.as(null)),
          ),
        );
  const activity = yield* HostAgentActivity.make({ credentials });
  if (credentials === null) {
    yield* Effect.logInfo("Storefront host push off; STOREFRONT_APNS_* not configured");
  } else {
    const sessions = yield* SessionStore.SessionStore;
    yield* Effect.logInfo("Storefront host push enabled", {
      keyId: credentials.keyId,
      teamId: credentials.teamId,
      topics: credentials.topics,
    });
    yield* forkParked(
      Effect.forever(
        Effect.sleep(HostAgentActivity.SWEEP_INTERVAL).pipe(Effect.andThen(activity.sweep)),
      ),
    );
    yield* forkParked(
      Effect.forever(
        Effect.sleep(HostAgentActivity.REFRESH_INTERVAL).pipe(Effect.andThen(activity.refresh)),
      ),
    );
    // A paired client the host removed stops receiving pushes at once.
    yield* forkParked(
      Stream.runForEach(sessions.streamChanges, (change) =>
        change.type === "clientRemoved"
          ? activity.pruneSessions(new Set([change.sessionId]))
          : Effect.void,
      ),
    );
  }
  return Context.make(HostAgentActivity.HostAgentActivity, activity).pipe(
    Context.add(AgentActivitySink, credentials === null ? null : { publish: activity.publish }),
  );
});

export const layer = Layer.effectContext(make).pipe(
  Layer.provide(Layer.merge(DeviceStore.layer, layerApns)),
);
