import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";

import * as ServerSettings from "../../serverSettings.ts";
import * as SpeechService from "../../speech/SpeechService.ts";
import * as DeepgramSpeech from "./DeepgramSpeech.ts";
import { makeDeepgramTranscript } from "./deepgramRequest.ts";

const KEY = "test-deepgram-key-0123456789";
const options = {
  ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  speechCustomWords: [{ term: "README", aliases: ["readme"] }],
  speechHints: ["Storefront"],
};
const pcm = (...samples: number[]) => new Uint8Array(new Float32Array(samples).buffer);

const localSpeech = Layer.mock(SpeechService.SpeechService)({
  status: Effect.succeed({ supported: false, reason: "local models are not available" }),
  models: () => Effect.succeed({ models: [] }),
  transcribe: () => Effect.succeed("local transcript"),
});

type Seen = {
  url?: URL;
  authorization?: string | undefined;
  contentType?: string | undefined;
  audio: number[];
  body?: Uint8Array;
};

/** A stand-in for Deepgram's /v1/listen: records what it receives and answers like Deepgram. */
const fakeDeepgram = (seen: Seen, onAudio?: "close-with-error") =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/v1/listen",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        seen.url = new URL(request.url, "http://deepgram.test");
        seen.authorization = request.headers.authorization;
        const socket = yield* request.upgrade;
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        const result = (transcript: string, isFinal: boolean) =>
          JSON.stringify({
            type: "Results",
            is_final: isFinal,
            channel: { alternatives: [{ transcript }] },
          });
        while (true) {
          for (const frame of yield* reader.pull) {
            if (typeof frame !== "string") {
              const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
              for (let at = 0; at < frame.byteLength; at += 2)
                seen.audio.push(view.getInt16(at, true));
              if (onAudio === "close-with-error")
                return yield* writer.write(new Socket.CloseEvent(1011, "NET-0001"));
              continue;
            }
            if (JSON.parse(frame).type !== "CloseStream") continue;
            yield* writer.write(result("kan je de readme", false));
            yield* writer.write(result("Kan je de readme", true));
            yield* writer.write(result("ehm nog eens nakijken?", true));
            yield* writer.write(JSON.stringify({ type: "Metadata" }));
            return yield* writer.write(new Socket.CloseEvent(1000));
          }
        }
      }).pipe(Effect.scoped, Effect.ignore, Effect.as(HttpServerResponse.empty())),
    ),
    HttpRouter.add(
      "POST",
      "/v1/listen",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        seen.url = new URL(request.url, "http://deepgram.test");
        seen.authorization = request.headers.authorization;
        seen.contentType = request.headers["content-type"];
        seen.body = new Uint8Array(yield* request.arrayBuffer);
        return HttpServerResponse.jsonUnsafe({
          results: { channels: [{ alternatives: [{ transcript: "Check de readme." }] }] },
        });
      }),
    ),
  );

const deepgramSpeech = Effect.fn("test.deepgramSpeech")(function* (
  env: Record<string, string>,
  seen: Seen,
  onAudio?: "close-with-error",
) {
  yield* Layer.build(
    HttpRouter.serve(fakeDeepgram(seen, onAudio), { disableLogger: true, disableListenLog: true }),
  );
  const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
  const fileSystem = yield* FileSystem.FileSystem;
  const keyFile = `${yield* fileSystem.makeTempDirectoryScoped()}/deepgram-api-key`;
  yield* fileSystem.writeFileString(keyFile, `${KEY}\n`);
  const services = yield* Layer.build(
    DeepgramSpeech.override(localSpeech).pipe(
      Layer.provide(
        ServerSettings.layerTest({
          speechProjectCustomWords: [{ term: "Docker Compose", aliases: [] }],
        }),
      ),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              STOREFRONT_DEEPGRAM_KEY_FILE: keyFile,
              STOREFRONT_DEEPGRAM_URL: `http://127.0.0.1:${address.port}`,
              ...env,
            },
          }),
        ),
      ),
      Layer.provide(FetchHttpClient.layer),
    ),
  );
  return Context.get(services, SpeechService.SpeechService);
});

const testServices = Layer.merge(NodeHttpServer.layerTest, NodeServices.layer);

it.live("streams 16-bit audio to Deepgram and returns the joined, corrected finals", () =>
  Effect.gen(function* () {
    const seen: Seen = { audio: [] };
    const speech = yield* deepgramSpeech({}, seen);
    const stream = yield* speech.startStream(options);
    yield* stream.feed(pcm(0.5, -0.5, 0.25));
    expect(yield* stream.finish).toBe("Kan je de README nog eens nakijken?");

    expect(seen.authorization).toBe(`Token ${KEY}`);
    expect(seen.audio).toEqual([16384, -16384, 8192]);
    const query = seen.url!.searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      model: "nova-3",
      language: "multi",
      encoding: "linear16",
      sample_rate: "16000",
      interim_results: "true",
      smart_format: "true",
      mip_opt_out: "true",
      redact_usage: "true",
    });
    expect(query.getAll("language_hint")).toEqual(["nl-BE", "en"]);
    expect(query.getAll("keyterm")).toEqual(["Storefront", "README", "Docker Compose"]);
    expect(seen.url!.toString()).not.toContain(KEY);
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.live("fails the recording when Deepgram drops the stream", () =>
  Effect.gen(function* () {
    const seen: Seen = { audio: [] };
    const speech = yield* deepgramSpeech(
      { STOREFRONT_DEEPGRAM_LANGUAGE: "nl-BE" },
      seen,
      "close-with-error",
    );
    const stream = yield* speech.startStream(options);
    yield* stream.feed(pcm(0.5));
    const error = yield* Effect.flip(stream.finish);
    expect(error).toBeInstanceOf(SpeechService.SpeechOperationError);
    expect(seen.url!.searchParams.get("language")).toBe("nl-BE");
    expect(seen.url!.searchParams.has("language_hint")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.live("transcribes a whole recording as WAV with the same privacy options", () =>
  Effect.gen(function* () {
    const seen: Seen = { audio: [] };
    const speech = yield* deepgramSpeech({}, seen);
    expect(yield* speech.transcribe(pcm(0.5, -0.5), options)).toBe("Check de README.");
    expect(seen.authorization).toBe(`Token ${KEY}`);
    expect(seen.contentType).toBe("audio/wav");
    expect(new TextDecoder().decode(seen.body!.subarray(0, 4))).toBe("RIFF");
    expect(seen.body!.byteLength).toBe(44 + 4);
    expect(seen.url!.searchParams.get("mip_opt_out")).toBe("true");
    expect(seen.url!.searchParams.has("encoding")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.live("reports Deepgram as the environment's only active model", () =>
  Effect.gen(function* () {
    const speech = yield* deepgramSpeech({}, { audio: [] });
    expect(yield* speech.status).toMatchObject({
      supported: true,
      state: "ready",
      modelId: DeepgramSpeech.DEEPGRAM_MODEL_ID,
      supportsStreaming: true,
      languages: ["nl", "en"],
    });
    expect((yield* speech.models(false)).models.map((model) => model.active)).toEqual([true]);
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.effect("leaves local transcription untouched without a key file", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      DeepgramSpeech.override(localSpeech).pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(NodeServices.layer),
      ),
    );
    const speech = Context.get(services, SpeechService.SpeechService);
    expect(yield* speech.transcribe(pcm(0.5), options)).toBe("local transcript");
  }).pipe(Effect.scoped),
);

it("shows finals as committed text and the latest interim result after them", () => {
  const transcript = makeDeepgramTranscript((text) => text.replace("readme", "README"));
  const result = (text: string, isFinal: boolean) =>
    JSON.stringify({
      type: "Results",
      is_final: isFinal,
      channel: { alternatives: [{ transcript: text }] },
    });
  transcript.accept(result("kan je", false));
  expect(transcript.update()).toEqual({
    revision: 1,
    text: { committed: "", tentative: "kan je" },
  });
  expect(transcript.update()).toEqual({ revision: 1, text: null });
  transcript.accept(result("Kan je de readme", true));
  transcript.accept(result("nog", false));
  expect(transcript.update().text).toEqual({ committed: "Kan je de README ", tentative: "nog" });
  expect(transcript.accept(JSON.stringify({ type: "Metadata" }))).toBe(true);
  expect(transcript.final()).toBe("Kan je de readme");
});
