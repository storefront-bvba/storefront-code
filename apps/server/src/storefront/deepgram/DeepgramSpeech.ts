/**
 * Storefront Code: with STOREFRONT_DEEPGRAM_KEY_FILE set, this environment transcribes through
 * Deepgram instead of a local model, live over the speech stream and in one request otherwise.
 */
import type {
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as SpeechService from "../../speech/SpeechService.ts";
import { makeDeepgramClient } from "./DeepgramClient.ts";
import { baseLanguage, type DeepgramSettings, pcm16, wav16 } from "./deepgramRequest.ts";

export const DEEPGRAM_MODEL_ID = "storefront/deepgram";

const isInvalidAudio = Schema.is(SpeechService.SpeechInvalidAudioError);

function deepgramModel(settings: DeepgramSettings): EnvironmentSpeechModel {
  return {
    id: DEEPGRAM_MODEL_ID,
    name: `Deepgram ${settings.model.replace(/^nova-/i, "Nova-")}`,
    description: `Live transcription by Deepgram (${settings.languages.join(", ")})`,
    size: 0,
    languages: [...new Set(settings.languages.map(baseLanguage))],
    accuracy: 0,
    speed: 0,
    recommended: false,
    supportsStreaming: true,
    supportsLanguageDetection: settings.languages.length > 1,
    supportsTranslation: false,
    active: true,
    state: "installed",
  };
}

type Models = { readonly models: ReadonlyArray<EnvironmentSpeechModel> };

const make = Effect.gen(function* () {
  const inner = yield* SpeechService.SpeechService;
  const client = yield* makeDeepgramClient;
  if (Option.isNone(client)) return inner;
  const { settings, readKey } = client.value;
  const model = deepgramModel(settings);
  yield* Effect.logInfo("voice transcription uses Deepgram", {
    model: settings.model,
    languages: settings.languages,
    endpoint: settings.baseUrl,
  });

  const decodePcm = (pcm: Uint8Array) =>
    Effect.try({
      try: () => SpeechService.decodeSpeechPcm(pcm),
      catch: (cause) =>
        isInvalidAudio(cause)
          ? cause
          : new SpeechService.SpeechInvalidAudioError({
              byteLength: pcm.byteLength,
              message: "Invalid PCM audio.",
            }),
    });

  const status: Effect.Effect<EnvironmentSpeechStatus, SpeechService.SpeechError> = Effect.gen(
    function* () {
      const key = yield* readKey("status").pipe(
        Effect.tapError((error) => Effect.logWarning(error.cause)),
        Effect.option,
      );
      // The key file's path is a host path, so clients only hear that it failed.
      if (Option.isNone(key))
        return { supported: false, reason: "the Deepgram key on this environment can't be read" };
      const local = yield* inner.status.pipe(
        Effect.map((value) => (value.supported ? value : undefined)),
        Effect.orElseSucceed(() => undefined),
      );
      return {
        supported: true,
        state: "ready",
        modelId: model.id,
        model: model.name,
        size: 0,
        supportsStreaming: true,
        supportsTranslation: false,
        languages: model.languages,
        supportsLanguageDetection: model.supportsLanguageDetection,
        acceleration: local?.acceleration ?? "auto",
        benchmarkTier: local?.benchmarkTier ?? "accelerated",
        modelUnloadTimeout: local?.modelUnloadTimeout ?? "never",
        gpuDevices: local?.gpuDevices ?? [],
      };
    },
  );

  // Local models stay listed so they can be managed, but none transcribes while Deepgram does.
  const withDeepgram = <A extends Models>(result: A): A => ({
    ...result,
    models: [model, ...result.models.map((entry) => ({ ...entry, active: false }))],
  });
  const listed = <A extends Models>(effect: Effect.Effect<A, SpeechService.SpeechError>) =>
    effect.pipe(Effect.map(withDeepgram));
  const models = (includeBenchmarks: boolean): Effect.Effect<Models, SpeechService.SpeechError> =>
    inner.models(includeBenchmarks).pipe(
      Effect.map(withDeepgram),
      Effect.orElseSucceed(() => ({ models: [model] })),
    );

  const transcribe = Effect.fn("DeepgramSpeech.transcribe")(function* (
    pcmBytes: Uint8Array,
    options: SpeechTranscriptionOptions,
  ) {
    const samples = yield* decodePcm(pcmBytes);
    return yield* client.value.transcribe(wav16(samples), "audio/wav", options);
  });

  const startStream = (options: SpeechTranscriptionOptions) =>
    client.value.startStream(options, "linear16", (bytes) =>
      decodePcm(bytes).pipe(Effect.map(pcm16)),
    );

  return SpeechService.SpeechService.of({
    ...inner,
    status,
    models,
    prepareModel: Effect.void,
    transcribe,
    startStream,
    downloadModel: Effect.fn("DeepgramSpeech.downloadModel")((modelId: string) =>
      listed(inner.downloadModel(modelId)),
    ),
    selectModel: Effect.fn("DeepgramSpeech.selectModel")((modelId: string) =>
      modelId === DEEPGRAM_MODEL_ID ? models(false) : listed(inner.selectModel(modelId)),
    ),
    cancelDownload: Effect.fn("DeepgramSpeech.cancelDownload")((modelId: string) =>
      listed(inner.cancelDownload(modelId)),
    ),
    removeModel: Effect.fn("DeepgramSpeech.removeModel")((modelId: string) =>
      modelId === DEEPGRAM_MODEL_ID ? models(false) : listed(inner.removeModel(modelId)),
    ),
    linkModels: Effect.fn("DeepgramSpeech.linkModels")((source: string) =>
      listed(inner.linkModels(source)),
    ),
  });
});

/** Replaces the environment's own transcription with Deepgram when the host is set up for it. */
export const override = <E, R>(inner: Layer.Layer<SpeechService.SpeechService, E, R>) =>
  Layer.effect(SpeechService.SpeechService, make).pipe(Layer.provide(inner));
