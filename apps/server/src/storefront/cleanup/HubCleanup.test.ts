import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import {
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  type EnvironmentSpeechPostProcessingRequest,
  TextGenerationError,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";

import { SpeechPostProcessing } from "../../speech/postProcessing.ts";
import { SpeechOperationError } from "../../speech/SpeechService.ts";
import * as HubCleanup from "./HubCleanup.ts";

const TOKEN = "test-hub-token-0123456789";
const isTextGenerationError = Schema.is(TextGenerationError);
const request: EnvironmentSpeechPostProcessingRequest = {
  transcript: "euh check de readme op de staging server, nee ik bedoel op productie",
  draft: { text: "", selection: { start: 0, end: 0 } },
  options: {
    speechCustomWords: [{ term: "README", aliases: ["readme"] }],
    speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
  },
};

const agentCleanup = Layer.mock(SpeechPostProcessing)({
  process: () => Effect.succeed({ text: "from the coding agent" }),
});

type Seen = { authorization?: string | undefined; path?: string; body?: Record<string, unknown> };

/** A stand-in for the hub's /v1/messages: records the request and answers like the Messages API. */
const fakeHub = (seen: Seen, status: number) =>
  HttpRouter.add(
    "POST",
    "/v1/messages",
    Effect.gen(function* () {
      const incoming = yield* HttpServerRequest.HttpServerRequest;
      seen.authorization = incoming.headers.authorization;
      seen.path = new URL(incoming.url, "http://hub.test").pathname;
      seen.body = (yield* incoming.json) as Record<string, unknown>;
      if (status !== 200) return HttpServerResponse.jsonUnsafe({ error: {} }, { status });
      return HttpServerResponse.jsonUnsafe({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Check de readme op productie." }],
      });
    }),
  );

const hubCleanup = Effect.fn("test.hubCleanup")(function* (
  env: Record<string, string>,
  seen: Seen,
  status = 200,
) {
  yield* Layer.build(
    HttpRouter.serve(fakeHub(seen, status), { disableLogger: true, disableListenLog: true }),
  );
  const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
  const services = yield* Layer.build(
    HubCleanup.override(agentCleanup).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/`,
              ANTHROPIC_AUTH_TOKEN: TOKEN,
              ...env,
            },
          }),
        ),
      ),
    ),
  );
  return Context.get(services, SpeechPostProcessing);
});

it.live("asks the configured model directly, thinking off and low effort", () =>
  Effect.gen(function* () {
    const seen: Seen = {};
    const cleanup = yield* hubCleanup({ STOREFRONT_CLEANUP_MODEL: "claude-sonnet-5-5" }, seen);
    expect(yield* cleanup.process(request)).toEqual({ text: "Check de README op productie." });

    expect(seen.path).toBe("/v1/messages");
    expect(seen.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen.body).toMatchObject({
      model: "claude-sonnet-5-5",
      thinking: { type: "between_tools" },
      output_config: { effort: "low" },
    });
    const prompt = (seen.body!.messages as Array<{ content: string }>)[0]!.content;
    expect(prompt).toContain(DEFAULT_SPEECH_POST_PROCESSING_PROMPT);
    expect(prompt).toContain(HubCleanup.FLEMISH_HINT);
    expect(prompt).toContain(request.transcript);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("tells the user why when the hub refuses, without the token", () =>
  Effect.gen(function* () {
    const cleanup = yield* hubCleanup({ STOREFRONT_CLEANUP_MODEL: "claude-haiku-5-5" }, {}, 429);
    const error = yield* Effect.flip(cleanup.process(request));
    expect(error).toBeInstanceOf(SpeechOperationError);
    expect(isTextGenerationError(error.cause)).toBe(true);
    expect((error.cause as TextGenerationError).detail).toBe(
      "Cleanup model claude-haiku-5-5 answered HTTP 429.",
    );
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("leaves cleanup to the coding agent without a cleanup model", () =>
  Effect.gen(function* () {
    const seen: Seen = {};
    const cleanup = yield* hubCleanup({}, seen);
    expect(yield* cleanup.process(request)).toEqual({ text: "from the coding agent" });
    expect(seen.body).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it("turns thinking off the way each model accepts", () => {
  expect(HubCleanup.thinkingOff("claude-sonnet-5-5")).toEqual({ type: "between_tools" });
  expect(HubCleanup.thinkingOff("claude-haiku-5-5")).toEqual({ type: "disabled" });
  expect(HubCleanup.thinkingOff("claude-opus-5-5")).toBeUndefined();
});
