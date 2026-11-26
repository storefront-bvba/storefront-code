/**
 * Storefront Code: with STOREFRONT_DEEPGRAM_KEY_FILE set, this environment transcribes through
 * Deepgram instead of a local model, live over the speech stream and in one request otherwise.
 * The key stays on this host and is read from its file for every recording.
 */
import type {
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSettings from "../../serverSettings.ts";
import { applySpeechAliases } from "../../speech/customWords.ts";
import { removeSpeechFillerWords } from "../../speech/fillerWords.ts";
import * as SpeechService from "../../speech/SpeechService.ts";
import {
  baseLanguage,
  DeepgramBatchResponse,
  deepgramKeyterms,
  deepgramLanguages,
  deepgramQuery,
  type DeepgramSettings,
  makeDeepgramTranscript,
  pcm16,
  wav16,
} from "./deepgramRequest.ts";

export const DEEPGRAM_MODEL_ID = "storefront/deepgram";

const DeepgramConfig = Config.all({
  keyFile: Config.String("STOREFRONT_DEEPGRAM_KEY_FILE").pipe(Config.option),
  // Several codes mean code-switching: Deepgram's multilingual model with each code as a hint.
  languages: Config.String("STOREFRONT_DEEPGRAM_LANGUAGE").pipe(Config.withDefault("nl-BE,en")),
  model: Config.String("STOREFRONT_DEEPGRAM_MODEL").pipe(Config.withDefault("nova-3")),
  // The EU endpoint keeps audio in the EU; same keys and prices as api.deepgram.com.
  baseUrl: Config.String("STOREFRONT_DEEPGRAM_URL").pipe(
    Config.withDefault("https://api.eu.deepgram.com"),
  ),
});

const isInvalidAudio = Schema.is(SpeechService.SpeechInvalidAudioError);
const API_KEY = /^[\x21-\x7e]{16,512}$/;
const KEEPALIVE_INTERVAL = "4 seconds";
const KEEP_ALIVE_MESSAGE = '{"type":"KeepAlive"}';
const CLOSE_STREAM_MESSAGE = '{"type":"CloseStream"}';

const failure = (operation: string, message: string) =>
  new SpeechService.SpeechOperationError({ operation, cause: new Error(message) });

// Effect drops its listeners before closing a socket that is still connecting, and `ws` then
// emits an `error` nobody handles, which exits the server.
const webSocketConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = make(url, options);
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));

const describeSocketError = (error: Socket.SocketError) => {
  const reason = error.reason;
  if (reason._tag === "SocketCloseError")
    return `Deepgram closed the stream (${reason.code}${reason.closeReason ? ` ${reason.closeReason}` : ""}).`;
  const cause =
    "cause" in reason && reason.cause instanceof Error ? ` ${reason.cause.message}` : "";
  return `Deepgram stream failed (${reason._tag}).${cause}`;
};

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
  const config = yield* DeepgramConfig;
  if (Option.isNone(config.keyFile)) return inner;
  const keyFile = config.keyFile.value;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
  const settings: DeepgramSettings = {
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ""),
    model: config.model.trim(),
    languages: config.languages
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean),
  };
  const model = deepgramModel(settings);
  yield* Effect.logInfo("voice transcription uses Deepgram", {
    model: settings.model,
    languages: settings.languages,
    endpoint: settings.baseUrl,
  });

  const readKey = (operation: string) =>
    fileSystem.readFileString(keyFile).pipe(
      Effect.mapError(() => failure(operation, `The Deepgram key file ${keyFile} can't be read.`)),
      Effect.map((text) => text.trim()),
      Effect.filterOrFail(
        (key) => API_KEY.test(key),
        () => failure(operation, `The Deepgram key file ${keyFile} holds no valid key.`),
      ),
      Effect.map(Redacted.make),
    );
  const environmentWords = serverSettings.getSettings.pipe(
    Effect.map((current) => current.speechProjectCustomWords),
    Effect.orElseSucceed(() => []),
  );
  const finalText = (text: string, options: SpeechTranscriptionOptions) => {
    const corrected = applySpeechAliases(text, options.speechCustomWords);
    const language = baseLanguage(deepgramLanguages(settings, options.speechLanguage)[0] ?? "");
    return (
      options.speechRemoveFillerWords
        ? removeSpeechFillerWords(corrected, language, options.speechCorrectionWord)
        : corrected
    ).trim();
  };
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

  const transcribe = Effect.fn("DeepgramSpeech.transcribe")(
    function* (pcmBytes: Uint8Array, options: SpeechTranscriptionOptions) {
      const operation = "deepgram transcription";
      const samples = yield* decodePcm(pcmBytes);
      const key = yield* readKey(operation);
      const keyterms = deepgramKeyterms(options, yield* environmentWords);
      const query = deepgramQuery(settings, options, keyterms, "batch");
      const request = HttpClientRequest.post(`${settings.baseUrl}/v1/listen?${query}`).pipe(
        HttpClientRequest.setHeader("authorization", `Token ${Redacted.value(key)}`),
        HttpClientRequest.bodyUint8Array(wav16(samples), "audio/wav"),
      );
      const response = yield* http.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        // The request error carries the request, and with it the key.
        Effect.mapError(() => failure(operation, "Deepgram could not be reached.")),
      );
      if (response.status < 200 || response.status >= 300)
        return yield* failure(operation, `Deepgram answered HTTP ${response.status}.`);
      const body = yield* HttpClientResponse.schemaBodyJson(DeepgramBatchResponse)(response).pipe(
        Effect.mapError(() => failure(operation, "Deepgram sent an unexpected response.")),
      );
      return finalText(body.results.channels[0]?.alternatives[0]?.transcript ?? "", options);
    },
    (effect) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: "2 minutes",
          orElse: () => Effect.fail(failure("deepgram transcription", "Deepgram timed out.")),
        }),
      ),
  );

  const startStream = Effect.fn("DeepgramSpeech.startStream")(function* (
    options: SpeechTranscriptionOptions,
  ) {
    const operation = "deepgram streaming transcription";
    const key = yield* readKey(operation);
    const keyterms = deepgramKeyterms(options, yield* environmentWords);
    const query = deepgramQuery(settings, options, keyterms, "live");
    const socket = yield* Socket.makeWebSocket(
      `${settings.baseUrl.replace(/^http/, "ws")}/v1/listen?${query}`,
      { openTimeout: "10 seconds", headers: { authorization: `Token ${Redacted.value(key)}` } },
    ).pipe(Effect.provide(webSocketConstructor));
    const reader = yield* socket.reader.pipe(
      Effect.mapError((error) => failure(operation, describeSocketError(error))),
    );
    const writer = yield* socket.writer;
    const transcript = makeDeepgramTranscript((text) =>
      applySpeechAliases(text, options.speechCustomWords),
    );
    const ended = yield* Deferred.make<void, SpeechService.SpeechOperationError>();
    yield* Effect.gen(function* () {
      while (true) {
        for (const frame of yield* reader.pull) {
          if (transcript.accept(frame)) yield* Deferred.succeed(ended, undefined);
        }
      }
    }).pipe(
      Effect.catch((error) =>
        error.reason._tag === "SocketCloseError" && error.reason.code === 1000
          ? Deferred.succeed(ended, undefined)
          : Effect.logWarning("Deepgram stream failed", {
              reason: describeSocketError(error),
            }).pipe(
              Effect.andThen(Deferred.fail(ended, failure(operation, describeSocketError(error)))),
            ),
      ),
      Effect.forkScoped,
    );
    // Deepgram closes a stream that hears nothing for 10 seconds, such as while a client stalls.
    let received = 0;
    yield* Effect.gen(function* () {
      let heard = received;
      while (true) {
        yield* Effect.sleep(KEEPALIVE_INTERVAL);
        if (received === heard) yield* writer.write(KEEP_ALIVE_MESSAGE).pipe(Effect.ignore);
        heard = received;
      }
    }).pipe(Effect.forkScoped);
    const stopped = Deferred.isDone(ended);
    return {
      feed: Effect.fn("DeepgramSpeech.feed")(function* (bytes: Uint8Array) {
        if (yield* stopped) {
          yield* Deferred.await(ended);
          return yield* failure(operation, "Deepgram ended the stream early.");
        }
        if (received + bytes.byteLength > SpeechService.MAX_SPEECH_BYTES)
          return yield* new SpeechService.SpeechInvalidAudioError({
            byteLength: bytes.byteLength,
            message: "Speech stream audio limit exceeded.",
          });
        const samples = yield* decodePcm(bytes);
        received += bytes.byteLength;
        yield* writer
          .write(pcm16(samples))
          .pipe(Effect.mapError((error) => failure(operation, describeSocketError(error))));
        return transcript.update();
      }),
      finish: Effect.gen(function* () {
        if (!(yield* stopped)) {
          yield* writer
            .write(CLOSE_STREAM_MESSAGE)
            .pipe(Effect.mapError((error) => failure(operation, describeSocketError(error))));
        }
        yield* Deferred.await(ended).pipe(
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.fail(failure(operation, "Deepgram did not finish the stream.")),
          }),
        );
        return finalText(transcript.final(), options);
      }),
    } satisfies SpeechService.SpeechStream;
  });

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
