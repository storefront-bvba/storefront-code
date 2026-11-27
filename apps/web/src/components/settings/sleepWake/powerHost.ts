// Storefront Code (fork): Stay awake and Sleep when done on one host, over this client's own
// connection to it. A host without the storefrontPower endpoints (an upstream build) answers 404.
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { StorefrontPowerStatus, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HttpClientResponse } from "effect/http";

const REQUEST_TIMEOUT_MS = 10_000;

export type PowerRead =
  | { readonly _tag: "Ok"; readonly status: StorefrontPowerStatus }
  | { readonly _tag: "Unsupported" };

export class PowerHostRefused extends Schema.TaggedError<PowerHostRefused>()("PowerHostRefused", {
  status: Schema.Number,
}) {}

const decodeStatus = Schema.decodeUnknownEffect(StorefrontPowerStatus);

const answer = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  if (response.status === 404) return { _tag: "Unsupported" } satisfies PowerRead as PowerRead;
  if (response.status !== 200) return yield* new PowerHostRefused({ status: response.status });
  const status = yield* decodeStatus(yield* response.json);
  return { _tag: "Ok", status } satisfies PowerRead as PowerRead;
});

type PowerRequest<E> = Parameters<
  typeof executeConnectedEnvironmentHttpRequest<
    "storefrontPower",
    HttpClientResponse.HttpClientResponse,
    E,
    never
  >
>[0];

const send = <E>(
  environmentId: EnvironmentId,
  input: Pick<PowerRequest<E>, "method" | "url" | "request">,
) =>
  Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) =>
    registry.run(
      environmentId,
      executeConnectedEnvironmentHttpRequest({
        ...input,
        group: "storefrontPower",
        timeoutMs: REQUEST_TIMEOUT_MS,
        requestInit: { redirect: "error" },
        isUnauthorizedResponse: (response) => response.status === 401,
      }),
    ),
  ).pipe(Effect.flatMap(answer));

export const readPowerStatus = (environmentId: EnvironmentId) =>
  send(environmentId, {
    method: "GET",
    url: (urls) => urls.status(),
    request: ({ client, headers }) => client.status({ headers, responseMode: "response-only" }),
  });

export type PowerSwitch = "stayAwake" | "sleepWhenDone";

export const writePowerSwitch = (input: {
  readonly environmentId: EnvironmentId;
  readonly which: PowerSwitch;
  readonly on: boolean;
}) => {
  const payload = { on: input.on };
  return input.which === "stayAwake"
    ? send(input.environmentId, {
        method: "PUT",
        url: (urls) => urls.setStayAwake(),
        request: ({ client, headers }) =>
          client.setStayAwake({ headers, payload, responseMode: "response-only" }),
      })
    : send(input.environmentId, {
        method: "PUT",
        url: (urls) => urls.setSleepWhenDone(),
        request: ({ client, headers }) =>
          client.setSleepWhenDone({ headers, payload, responseMode: "response-only" }),
      });
};
