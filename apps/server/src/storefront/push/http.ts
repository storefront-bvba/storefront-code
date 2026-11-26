// Storefront Code (fork): the storefrontPush endpoints. The phone reaches them over its own
// authenticated connection (Tailscale or LAN), with the scope it already has to read threads.
import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import * as HostAgentActivity from "./HostAgentActivity.ts";
import * as HostPush from "./HostPush.ts";

const failStore = (error: unknown) => failEnvironmentInternal("internal_error", error);

/** The handlers alone; `layer` adds the one HostPush build the server shares. */
export const layerGroup = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "storefrontPush",
  Effect.fnUntraced(function* (handlers) {
    const activity = yield* HostAgentActivity.HostAgentActivity;

    return handlers
      .handle(
        "status",
        Effect.fn("environment.storefrontPush.status")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* activity.status({
            sessionId: session.sessionId,
            deviceId: args.query.deviceId,
          });
        }),
      )
      .handle(
        "registerDevice",
        Effect.fn("environment.storefrontPush.registerDevice")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          if (args.params.deviceId !== args.payload.deviceId) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }
          const outcome = yield* activity
            .registerDevice({ sessionId: session.sessionId, registration: args.payload })
            .pipe(Effect.catch(failStore));
          switch (outcome) {
            case "registered":
              return { ok: true };
            case "disabled":
              return { ok: false };
            case "platform-not-supported":
            case "topic-not-allowed":
              return yield* failEnvironmentInvalidRequest("invalid_command");
          }
        }),
      )
      .handle(
        "unregisterDevice",
        Effect.fn("environment.storefrontPush.unregisterDevice")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* activity.unregisterDevice(args.params.deviceId).pipe(Effect.catch(failStore));
          return { ok: true };
        }),
      )
      .handle(
        "testPush",
        Effect.fn("environment.storefrontPush.testPush")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* activity.testPush(args.params.deviceId);
        }),
      )
      .handle(
        "registerLiveActivity",
        Effect.fn("environment.storefrontPush.registerLiveActivity")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const ok = yield* activity
            .registerLiveActivity(args.payload)
            .pipe(Effect.catch(failStore));
          return { ok };
        }),
      )
      .handle(
        "agentActivity",
        Effect.fn("environment.storefrontPush.agentActivity")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* activity.snapshot;
        }),
      );
  }),
);

export const layer = layerGroup.pipe(Layer.provide(HostPush.layer));
