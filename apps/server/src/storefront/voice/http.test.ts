import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { encodeSpeechPcmRequest } from "@t3tools/shared/speech";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  SpeechStreamEvent,
  STOREFRONT_VOICE_STREAM_PATH,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SpeechService from "../../speech/SpeechService.ts";
import * as StorefrontVoiceHttp from "./http.ts";
import * as StorefrontVoice from "./StorefrontVoice.ts";

const KEY = "test-deepgram-key-0123456789";
const options = {
  ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  speechCustomWords: [{ term: "README", aliases: ["read me"] }],
  speechHints: ["Storefront"],
};
// Starts like an Ogg page; the bytes after it only have to arrive unchanged.
const OGG = Uint8Array.from({ length: 600 }, (_, index) =>
  index < 4 ? [0x4f, 0x67, 0x67, 0x53][index]! : index % 251,
);
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechStreamEvent));
const decodeSessionId = Schema.decodeUnknownSync(AuthSessionId);

type Seen = {
  url?: URL;
  authorization?: string | undefined;
  contentType?: string | undefined;
  frames: Uint8Array[];
  body?: Uint8Array;
};

/** A stand-in for Deepgram's /v1/listen that keeps what it receives, or rejects the key. */
const fakeDeepgram = (seen: Seen, reject: boolean) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/v1/listen",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        seen.url = new URL(request.url, "http://deepgram.test");
        seen.authorization = request.headers.authorization;
        if (reject) return HttpServerResponse.empty({ status: 401 });
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
              seen.frames.push(Uint8Array.from(frame));
              continue;
            }
            if (JSON.parse(frame).type !== "CloseStream") continue;
            yield* writer.write(result("Kan je de read me", true));
            yield* writer.write(result("ehm nog eens nakijken?", true));
            yield* writer.write(JSON.stringify({ type: "Metadata" }));
            yield* writer.write(new Socket.CloseEvent(1000));
            return HttpServerResponse.empty();
          }
        }
      }).pipe(Effect.scoped),
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
        if (reject) return HttpServerResponse.text("Invalid credentials.", { status: 401 });
        return HttpServerResponse.jsonUnsafe({
          results: { channels: [{ alternatives: [{ transcript: "Check de read me." }] }] },
        });
      }),
    ),
  );

/** Config as the host would have it: with a key file and our Deepgram, or without either. */
const hostConfig = Effect.fn("test.hostConfig")(function* (withKey: boolean) {
  if (!withKey) return ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));
  const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
  const fileSystem = yield* FileSystem.FileSystem;
  const keyFile = `${yield* fileSystem.makeTempDirectoryScoped()}/deepgram-api-key`;
  yield* fileSystem.writeFileString(keyFile, `${KEY}\n`);
  return ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        STOREFRONT_DEEPGRAM_KEY_FILE: keyFile,
        STOREFRONT_DEEPGRAM_URL: `http://127.0.0.1:${address.port}`,
      },
    }),
  );
});

const hostDependencies = Layer.mergeAll(
  ServerSettings.layerTest({ speechProjectCustomWords: [{ term: "Docker Compose", aliases: [] }] }),
  FetchHttpClient.layer,
);

/** The voice endpoints and Deepgram on one local server, for a session with these scopes. */
const serveHost = Effect.fn("test.serveHost")(function* (input: {
  readonly withKey: boolean;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly seen?: Seen;
}) {
  const scopes = input.scopes ?? [AuthOrchestrationOperateScope];
  const session = {
    sessionId: decodeSessionId("voice-test"),
    subject: "test",
    method: "bearer-access-token" as const,
  };
  const routes = Layer.mergeAll(
    fakeDeepgram(input.seen ?? { frames: [] }, false),
    HttpApiBuilder.layer(
      HttpApi.make("environment").add(EnvironmentHttpApi.groups.storefrontVoice),
    ).pipe(
      Layer.provide(StorefrontVoiceHttp.layer),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          effect.pipe(
            Effect.provideService(EnvironmentAuthenticatedPrincipal, {
              ...session,
              scopes: new Set(scopes),
            }),
          ),
        ),
      ),
    ),
    StorefrontVoiceHttp.streamRouteLayer.pipe(
      Layer.provide(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateWebSocketUpgrade: () => Effect.succeed({ ...session, scopes }),
        }),
      ),
    ),
  ).pipe(Layer.provide(hostDependencies), Layer.provide(yield* hostConfig(input.withKey)));
  yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
  const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
  return `http://127.0.0.1:${address.port}`;
});

/** Dictates over the Ogg Opus socket and collects every event until the socket closes. */
const dictate = (url: string, pieces: ReadonlyArray<Uint8Array>) =>
  Effect.promise(
    () =>
      new Promise<SpeechStreamEvent[]>((resolve) => {
        const events: SpeechStreamEvent[] = [];
        const socket = new WebSocket(url);
        socket.addEventListener("open", () =>
          socket.send(JSON.stringify({ type: "start", options })),
        );
        socket.addEventListener("message", ({ data }) => {
          const event = decodeEvent(data);
          events.push(event);
          if (event.type !== "ready") return;
          for (const piece of pieces) socket.send(piece);
          socket.send(JSON.stringify({ type: "finish" }));
        });
        socket.addEventListener("close", () => resolve(events));
      }),
  );

const testServices = Layer.mergeAll(
  NodeHttpServer.layerTest,
  NodeServices.layer,
  FetchHttpClient.layer,
);

it.live("streams Ogg Opus to Deepgram unchanged and returns the corrected finals", () =>
  Effect.gen(function* () {
    const seen: Seen = { frames: [] };
    const origin = yield* serveHost({ withKey: true, seen });
    const pieces = [OGG.subarray(0, 200), OGG.subarray(200, 450), OGG.subarray(450)];
    const events = yield* dictate(
      `${origin.replace(/^http/, "ws")}${STOREFRONT_VOICE_STREAM_PATH}`,
      pieces,
    );

    expect(events.map((event) => event.type)).toEqual([
      "ready",
      "update",
      "update",
      "update",
      "finished",
    ]);
    expect(events.at(-1)).toEqual({
      type: "finished",
      text: "Kan je de README nog eens nakijken?",
    });
    expect(seen.frames).toEqual(pieces.map((piece) => Uint8Array.from(piece)));
    expect(seen.authorization).toBe(`Token ${KEY}`);
    const query = seen.url!.searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      model: "nova-3",
      language: "multi",
      smart_format: "true",
      interim_results: "true",
      endpointing: "100",
      mip_opt_out: "true",
      redact_usage: "true",
    });
    for (const raw of ["encoding", "sample_rate", "channels"]) expect(query.has(raw)).toBe(false);
    expect(query.getAll("language_hint")).toEqual(["nl-BE", "en"]);
    expect(query.getAll("keyterm")).toEqual(["Storefront", "README", "Docker Compose"]);
    expect(seen.url!.toString()).not.toContain(KEY);
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.live("offers Ogg Opus and transcribes an uploaded Ogg file as audio/ogg", () =>
  Effect.gen(function* () {
    const seen: Seen = { frames: [] };
    const origin = yield* serveHost({ withKey: true, seen });
    const http = yield* HttpClient.HttpClient;
    const formats = yield* http.get(`${origin}/api/storefront/voice/formats`);
    expect(yield* formats.json).toEqual({ stream: ["ogg-opus"], upload: ["ogg-opus"] });

    const upload = (audio: Uint8Array) =>
      http.execute(
        HttpClientRequest.post(`${origin}/api/storefront/voice/transcribe`).pipe(
          HttpClientRequest.bodyUint8Array(
            encodeSpeechPcmRequest(audio, options),
            "application/octet-stream",
          ),
        ),
      );
    const answer = yield* upload(OGG);
    expect(answer.status).toBe(200);
    expect(yield* answer.json).toEqual({ text: "Check de README." });
    expect(seen.contentType).toBe("audio/ogg");
    expect(seen.body).toEqual(OGG);
    expect(seen.authorization).toBe(`Token ${KEY}`);
    const query = seen.url!.searchParams;
    expect(query.get("mip_opt_out")).toBe("true");
    expect(query.get("redact_usage")).toBe("true");
    expect(query.has("encoding")).toBe(false);
    expect(query.has("interim_results")).toBe(false);
    expect(seen.url!.toString()).not.toContain(KEY);

    delete seen.body;
    const notOgg = yield* upload(new Uint8Array(new Float32Array([0.5, -0.5]).buffer));
    expect(notOgg.status).toBe(400);
    expect(seen.body).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.live("offers nothing and refuses Opus without a Deepgram key", () =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const withoutKey = yield* serveHost({ withKey: false });
    const formats = yield* http.get(`${withoutKey}/api/storefront/voice/formats`);
    expect(yield* formats.json).toEqual({ stream: [], upload: [] });
    expect((yield* http.get(`${withoutKey}${STOREFRONT_VOICE_STREAM_PATH}`)).status).toBe(409);
    const upload = yield* http.execute(
      HttpClientRequest.post(`${withoutKey}/api/storefront/voice/transcribe`).pipe(
        HttpClientRequest.bodyUint8Array(
          encodeSpeechPcmRequest(OGG, options),
          "application/octet-stream",
        ),
      ),
    );
    expect(upload.status).toBe(400);
    expect(yield* upload.json).toMatchObject({ reason: "speech_unavailable" });
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.live("refuses a session without the operate scope", () =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const origin = yield* serveHost({ withKey: true, scopes: [] });
    expect((yield* http.get(`${origin}/api/storefront/voice/formats`)).status).toBe(403);
    expect((yield* http.get(`${origin}${STOREFRONT_VOICE_STREAM_PATH}`)).status).toBe(403);
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);

it.live("keeps the key out of the errors when Deepgram rejects it", () =>
  Effect.gen(function* () {
    const seen: Seen = { frames: [] };
    yield* Layer.build(
      HttpRouter.serve(fakeDeepgram(seen, true), { disableLogger: true, disableListenLog: true }),
    );
    const services = yield* Layer.build(
      StorefrontVoice.layer.pipe(
        Layer.provide(hostDependencies),
        Layer.provide(yield* hostConfig(true)),
      ),
    );
    const voice = Context.get(services, StorefrontVoice.StorefrontVoice);
    const uploadError = yield* Effect.flip(voice.transcribe(OGG, options));
    const streamError = yield* Effect.flip(
      Effect.gen(function* () {
        const stream = yield* voice.startStream(options);
        yield* stream.feed(OGG);
        return yield* stream.finish;
      }),
    );
    for (const error of [uploadError, streamError]) {
      expect(error).toBeInstanceOf(SpeechService.SpeechOperationError);
      const cause = error._tag === "SpeechOperationError" ? error.cause : undefined;
      expect(`${error.message} ${String(cause)} ${JSON.stringify(error)}`).not.toContain(KEY);
    }
    expect(seen.authorization).toBe(`Token ${KEY}`);
  }).pipe(Effect.scoped, Effect.provide(testServices)),
);
