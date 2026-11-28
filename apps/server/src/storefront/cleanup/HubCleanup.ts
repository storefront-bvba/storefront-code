/**
 * Storefront Code: with STOREFRONT_CLEANUP_MODEL set, transcript cleanup asks that model directly
 * through the Messages API at ANTHROPIC_BASE_URL (our CLIProxyAPI hub) with thinking off, instead
 * of starting a Claude Code session: under a second instead of four to six.
 */
import { DEFAULT_SPEECH_POST_PROCESSING_PROMPT, TextGenerationError } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { applySpeechAliases } from "../../speech/customWords.ts";
import { SpeechPostProcessing } from "../../speech/postProcessing.ts";
import { SpeechOperationError } from "../../speech/SpeechService.ts";
import { buildTranscriptionPostProcessingPrompt } from "../../textGeneration/TranscriptionPostProcessing.ts";
import { makeCleanupLog } from "./cleanupLog.ts";

const CleanupConfig = Config.all({
  model: Config.String("STOREFRONT_CLEANUP_MODEL").pipe(Config.option),
  baseUrl: Config.String("ANTHROPIC_BASE_URL").pipe(Config.option),
  token: Config.Redacted("ANTHROPIC_AUTH_TOKEN").pipe(Config.option),
});

export const FLEMISH_HINT = `The speaker usually talks Flemish (Dutch, nl-BE) with English IT terms mixed in. Keep each word in the language it was spoken in. Dutch self-corrections follow the same rule: "op de staging server, nee ik bedoel op de productieserver" becomes "op de productieserver"; "dinsdag, of nee, woensdag" becomes "woensdag". Drop Dutch fillers such as "euh", "ehm" and "allez" when they add nothing. Fix English IT terms the recognizer heard as Dutch words, such as "de beeld" for "de build".`;

// Sonnet 5.5 turns thinking off with between_tools and rejects disabled; Opus 5.5 and Fable cannot.
export const thinkingOff = (model: string) =>
  model.startsWith("claude-sonnet-5-5")
    ? { type: "between_tools" }
    : /^claude-(opus-5-5|fable|mythos)/.test(model)
      ? undefined
      : { type: "disabled" };

const MessagesResponse = Schema.Struct({
  stop_reason: Schema.NullOr(Schema.String),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});

const failure = (detail: string) =>
  new SpeechOperationError({
    operation: "post-processing",
    cause: new TextGenerationError({ operation: "storefrontCleanup", detail }),
  });

const make = Effect.gen(function* () {
  const inner = yield* SpeechPostProcessing;
  const config = yield* CleanupConfig;
  if (
    Option.isNone(config.model) ||
    Option.isNone(config.baseUrl) ||
    Option.isNone(config.token) ||
    config.model.value.trim() === ""
  )
    return inner;
  const model = config.model.value.trim();
  const url = `${config.baseUrl.value.trim().replace(/\/+$/, "")}/v1/messages`;
  const token = config.token.value;
  const thinking = thinkingOff(model);
  const http = yield* HttpClient.HttpClient;
  const log = yield* makeCleanupLog;

  return SpeechPostProcessing.of({
    process: Effect.fn("HubCleanup.process")(
      function* (input) {
        if (input.transcript.trim().length === 0) return { text: input.transcript };
        const { mode, customInstructions } = input.options.speechPostProcessingPrompt;
        const instructions =
          (mode === "custom" ? customInstructions.trim() : "") ||
          DEFAULT_SPEECH_POST_PROCESSING_PROMPT;
        const prompt = buildTranscriptionPostProcessingPrompt(
          `${instructions}\n\n${FLEMISH_HINT}`,
          input.transcript,
          input.draft,
          input.options.speechCorrectionWord,
        );
        const request = HttpClientRequest.post(url).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.setHeader("anthropic-version", "2023-06-01"),
          HttpClientRequest.bodyJsonUnsafe({
            model,
            max_tokens: 8192,
            ...(thinking ? { thinking } : {}),
            output_config: { effort: "low" },
            messages: [{ role: "user", content: prompt }],
          }),
        );
        const response = yield* http.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          // The request error carries the request, and with it the token.
          Effect.mapError(() => failure(`Cleanup could not reach ${new URL(url).host}.`)),
        );
        if (response.status < 200 || response.status >= 300)
          return yield* failure(`Cleanup model ${model} answered HTTP ${response.status}.`);
        const body = yield* HttpClientResponse.schemaBodyJson(MessagesResponse)(response).pipe(
          Effect.mapError(() => failure("Cleanup sent an unexpected response.")),
        );
        if (body.stop_reason !== "end_turn")
          return yield* failure(`Cleanup stopped early (${body.stop_reason ?? "no reason"}).`);
        const text = body.content
          .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
          .join("")
          .trim();
        return {
          text: text ? applySpeechAliases(text, input.options.speechCustomWords) : input.transcript,
        };
      },
      (effect) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.fail(failure("Cleanup took longer than 15 seconds.")),
          }),
        ),
      (effect, input) => log(model, input, effect),
    ),
  });
});

/** Replaces the environment's transcript cleanup with a direct model call when the host has one. */
export const override = <E, R>(inner: Layer.Layer<SpeechPostProcessing, E, R>) =>
  Layer.effect(SpeechPostProcessing, make).pipe(
    Layer.provide(inner),
    Layer.provide(FetchHttpClient.layer),
  );
