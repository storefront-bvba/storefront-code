// Storefront Code (fork): the storefrontPower endpoints. They change whether this host may sleep
// and hand out the wake relay's client token, so they need the operate scope.
import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../../auth/http.ts";
import * as HostPower from "./HostPower.ts";

const layerGroup = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "storefrontPower",
  Effect.fnUntraced(function* (handlers) {
    const power = yield* HostPower.HostPower;
    return handlers
      .handle(
        "status",
        Effect.fn("environment.storefrontPower.status")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* power.status;
        }),
      )
      .handle(
        "setStayAwake",
        Effect.fn("environment.storefrontPower.setStayAwake")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* power.setStayAwake(args.payload.on);
        }),
      )
      .handle(
        "setSleepWhenDone",
        Effect.fn("environment.storefrontPower.setSleepWhenDone")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* power.setSleepWhenDone(args.payload.on);
        }),
      );
  }),
);

export const layer = layerGroup.pipe(Layer.provide(HostPower.layer));
