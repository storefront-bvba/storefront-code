/**
 * Storefront Code: dictation as Ogg Opus (fork/design/F2-opus-voice.md). Deepgram reads Ogg
 * itself, so the audio goes through unchanged, live and as a whole recording.
 */
import type { SpeechTranscriptionOptions, StorefrontVoiceFormats } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import * as SpeechService from "../../speech/SpeechService.ts";
import { makeDeepgramClient } from "../deepgram/DeepgramClient.ts";

const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53]; // "OggS"

export class StorefrontVoice extends Context.Service<
  StorefrontVoice,
  {
    /** What this host takes besides upstream's PCM; empty lists mean PCM only. */
    readonly formats: StorefrontVoiceFormats;
    /** One whole Ogg Opus recording. */
    readonly transcribe: (
      ogg: Uint8Array,
      options: SpeechTranscriptionOptions,
    ) => Effect.Effect<
      string,
      SpeechService.SpeechInvalidAudioError | SpeechService.SpeechOperationError
    >;
    /** `/ws/voice`'s stream, fed with consecutive pieces of one Ogg Opus stream. */
    readonly startStream: (
      options: SpeechTranscriptionOptions,
    ) => Effect.Effect<SpeechService.SpeechStream, SpeechService.SpeechError, Scope.Scope>;
  }
>()("t3/storefront/voice/StorefrontVoice") {}

// Transports check `formats` first; this only answers a caller that did not.
const unavailable = () =>
  new SpeechService.SpeechOperationError({
    operation: "ogg opus transcription",
    cause: new Error("This host does not transcribe Ogg Opus."),
  });

const make = Effect.gen(function* () {
  const client = yield* makeDeepgramClient;
  if (Option.isNone(client))
    return StorefrontVoice.of({
      formats: { stream: [], upload: [] },
      transcribe: Effect.fn("StorefrontVoice.transcribe")(() => Effect.fail(unavailable())),
      startStream: Effect.fn("StorefrontVoice.startStream")(() => Effect.fail(unavailable())),
    });
  const deepgram = client.value;
  return StorefrontVoice.of({
    formats: { stream: ["ogg-opus"], upload: ["ogg-opus"] },
    transcribe: Effect.fn("StorefrontVoice.transcribe")(function* (ogg, options) {
      if (
        ogg.byteLength > SpeechService.MAX_SPEECH_BYTES ||
        !OGG_MAGIC.every((byte, index) => ogg[index] === byte)
      )
        return yield* new SpeechService.SpeechInvalidAudioError({
          byteLength: ogg.byteLength,
          message: "audio must be one Ogg Opus file",
        });
      return yield* deepgram.transcribe(ogg, "audio/ogg", options);
    }),
    startStream: Effect.fn("StorefrontVoice.startStream")((options) =>
      deepgram.startStream(options, "container", Effect.succeed),
    ),
  });
});

export const layer = Layer.effect(StorefrontVoice, make);
