// Storefront Code (fork): the storefrontVoice endpoints and the Ogg Opus speech socket. Both take
// dictation, so they need the operate scope, like upstream's /api/voice/transcribe and /ws/voice.
import { decodeSpeechPcmRequest } from "@t3tools/shared/speech";
import {
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  EnvironmentVoiceBodyLimit,
  SPEECH_MAX_OPTIONS_BYTES,
  STOREFRONT_VOICE_STREAM_PATH,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import * as SpeechService from "../../speech/SpeechService.ts";
import { runSpeechSocket } from "../../speech/stream.ts";
import * as StorefrontVoice from "./StorefrontVoice.ts";

const MAX_TRANSCRIBE_BODY_BYTES = SpeechService.MAX_SPEECH_BYTES + SPEECH_MAX_OPTIONS_BYTES + 4;
// The framing is upstream's; only the audio after the options differs.
const parseUpload = Option.liftThrowable(decodeSpeechPcmRequest);

const bodyLimit = Layer.succeed(EnvironmentVoiceBodyLimit, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"]) > MAX_TRANSCRIBE_BODY_BYTES)
      return yield* failEnvironmentInvalidRequest("invalid_audio");
    return yield* effect.pipe(
      Effect.provideService(
        HttpServerRequest.MaxBodySize,
        ByteSize.bytes(MAX_TRANSCRIBE_BODY_BYTES),
      ),
    );
  }),
);

const layerGroup = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "storefrontVoice",
  Effect.fnUntraced(function* (handlers) {
    const voice = yield* StorefrontVoice.StorefrontVoice;
    return handlers
      .handle(
        "formats",
        Effect.fn("environment.storefrontVoice.formats")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return voice.formats;
        }),
      )
      .handle(
        "transcribe",
        Effect.fn("environment.storefrontVoice.transcribe")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (!voice.formats.upload.includes("ogg-opus"))
            return yield* failEnvironmentInvalidRequest("speech_unavailable");
          const upload = parseUpload(args.payload);
          if (Option.isNone(upload)) return yield* failEnvironmentInvalidRequest("invalid_audio");
          const text = yield* voice.transcribe(upload.value.pcm, upload.value.options).pipe(
            Effect.catchTags({
              SpeechInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
              SpeechOperationError: (error) => failEnvironmentInternal("internal_error", error),
            }),
          );
          return { text };
        }),
      );
  }),
);

export const layer = layerGroup.pipe(
  Layer.provide(bodyLimit),
  Layer.provide(StorefrontVoice.layer),
);

/** Checked exactly like upstream's /ws/voice: a media ticket and the operate scope. */
export const streamRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const voice = yield* StorefrontVoice.StorefrontVoice;
    return HttpRouter.add(
      "GET",
      STOREFRONT_VOICE_STREAM_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth
          .authenticateWebSocketUpgrade(request, "media")
          .pipe(Effect.result);
        if (session._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
        if (!session.success.scopes.includes(AuthOrchestrationOperateScope))
          return HttpServerResponse.empty({ status: 403 });
        // The client then streams PCM over /ws/voice instead.
        if (!voice.formats.stream.includes("ogg-opus"))
          return HttpServerResponse.empty({ status: 409 });
        const socket = yield* request.upgrade;
        yield* runSpeechSocket(socket, voice).pipe(Effect.scoped);
        return HttpServerResponse.empty();
      }),
    );
  }),
).pipe(Layer.provide(StorefrontVoice.layer));
