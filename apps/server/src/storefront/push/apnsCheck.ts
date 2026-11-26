// Storefront Code (fork): one APNs request with upstream's client, our key and our HTTP/2
// transport, for `fork/scripts/apns-check.mjs`. A made-up device token answers 400
// BadDeviceToken when Apple accepts the key, team and JWT (403 means it does not).
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { loadHostPushCredentials, readHostPushSettings } from "./HostPushConfig.ts";
import * as Http2HttpClient from "./http2HttpClient.ts";
import { ApnsClient, ApnsProviderTokens, type ApnsEnvironment } from "./upstreamRelay.ts";

export interface ApnsCheckResult {
  readonly environment: ApnsEnvironment;
  readonly bundleId: string;
  readonly status: number;
  readonly reason: string | null;
  readonly apnsId: string | null;
}

export class ApnsCheckNotConfigured extends Schema.TaggedError<ApnsCheckNotConfigured>()(
  "ApnsCheckNotConfigured",
  {},
) {
  override get message(): string {
    return "STOREFRONT_APNS_KEY_FILE, _KEY_ID, _TEAM_ID and _TOPICS must be set.";
  }
}

const checkApns = Effect.fn("storefront.push.checkApns")(
  function* (input: {
    readonly environment: ApnsEnvironment;
    readonly deviceToken: string;
    readonly bundleId?: string;
  }) {
    const settings = yield* readHostPushSettings;
    if (settings === null) return yield* new ApnsCheckNotConfigured();
    const credentials = yield* loadHostPushCredentials(settings);
    const bundleId = input.bundleId ?? settings.topics[0] ?? "";
    const apns = yield* ApnsClient.ApnsClient;
    const request = apns.makePushNotificationRequest({
      token: input.deviceToken,
      notification: {
        title: "Storefront Code",
        body: "APNs check",
        environmentId: "",
        threadId: "",
        deepLink: "/",
      },
    });
    const result = yield* apns.sendPushNotificationRequest({
      credentials: {
        teamId: credentials.teamId,
        keyId: credentials.keyId,
        privateKey: credentials.privateKey,
        bundleId,
        environment: input.environment,
      },
      request,
      issuedAtUnixSeconds: Math.floor((yield* DateTime.now).epochMilliseconds / 1_000),
    });
    return {
      environment: input.environment,
      bundleId,
      status: result.status,
      reason: result.reason ?? null,
      apnsId: result.apnsId,
    } satisfies ApnsCheckResult;
  },
  Effect.provide(
    Layer.merge(
      ApnsClient.layer.pipe(
        Layer.provide(ApnsProviderTokens.layer),
        Layer.provide(Http2HttpClient.layer),
      ),
      NodeServices.layer,
    ),
  ),
);

/** @public Run by fork/scripts/apns-check.mjs. */
export const runApnsCheck = (input: Parameters<typeof checkApns>[0]) =>
  Effect.runPromise(Effect.scoped(checkApns(input)));
