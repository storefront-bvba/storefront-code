/**
 * Storefront Code: live words on the phone. While an environment that streams (Deepgram) records,
 * the microphone's PCM goes to it over the speech WebSocket and its text shows in the composer.
 * The recording file is kept, so a dropped stream still ends in an upload of the whole recording.
 * A host that takes Ogg Opus (F2b) gets that instead of PCM, live and as the upload.
 */
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  type EnvironmentSpeechStatus,
  type SpeechStreamText,
  type StorefrontVoiceFormats,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  getEnvironmentSpeechStatus,
  getEnvironmentSpeechStreamUrl,
  openSpeechStream,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";

import { liveOgg } from "./liveOgg";
import {
  getStorefrontVoiceFormats,
  getStorefrontVoiceStreamUrl,
  transcribeStorefrontOgg,
} from "./opusVoice";

/** The server's id for its Deepgram model (apps/server/src/storefront/deepgram). */
const DEEPGRAM_MODEL_ID = "storefront/deepgram";
const SAMPLE_RATE = 16_000;
const MAX_QUEUED_SAMPLES = SAMPLE_RATE * 60;

type Feed = (pcm: Float32Array) => void;

/** Microphone audio of the current recording, held until the live stream has connected. */
export const livePcm = (() => {
  let open = false;
  let held = false;
  let overflowed = false;
  let feed: Feed | null = null;
  let queued: Float32Array[] = [];
  let queuedSamples = 0;
  let heard = 0;
  const reset = () => {
    open = true;
    overflowed = false;
    feed = null;
    queued = [];
    queuedSamples = 0;
    heard = 0;
  };
  return {
    begin() {
      // A recording that waited for its environment to wake keeps what it held so far.
      if (held) {
        held = false;
        return;
      }
      reset();
      liveOgg.begin();
    },
    /** Starts holding audio for a live stream that can only open once the environment wakes. */
    hold() {
      reset();
      held = true;
      liveOgg.begin();
    },
    /** Samples of this recording that can stream; none means the recorder only writes a file. */
    heard: () => heard,
    /** Audio was dropped while waiting, so only the recording file has all of it. */
    overflowed: () => overflowed,
    push(samples: Int16Array, sampleRate: number) {
      if (!open || sampleRate !== SAMPLE_RATE) return;
      heard += samples.length;
      const pcm = new Float32Array(samples.length);
      for (let index = 0; index < samples.length; index++) pcm[index] = samples[index]! / 32768;
      if (feed) return feed(pcm);
      if (queuedSamples + pcm.length > MAX_QUEUED_SAMPLES) {
        overflowed = true;
        return;
      }
      queued.push(pcm);
      queuedSamples += pcm.length;
    },
    attach(next: Feed) {
      if (!open) return;
      for (const pcm of queued) next(pcm);
      queued = [];
      queuedSamples = 0;
      feed = next;
    },
    end() {
      open = false;
      held = false;
      feed = null;
      queued = [];
      queuedSamples = 0;
    },
  };
})();

/** The words heard so far in the current recording, for the composer's dictation row. */
export const liveVoiceText = (() => {
  let text: SpeechStreamText | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => text,
    set(next: SpeechStreamText | null) {
      if (next === text) return;
      text = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
})();

const deepgramEnvironments = new WeakMap<PreparedConnection, boolean>();
// Asked once per connection; a reconnect is a new PreparedConnection and asks again.
const voiceFormats = new WeakMap<PreparedConnection, Promise<StorefrontVoiceFormats | null>>();

/** Whether the environment's last status said it transcribes through Deepgram. */
export const transcribesWithDeepgram = (prepared: PreparedConnection) =>
  deepgramEnvironments.get(prepared) === true;

type LiveStreamDependencies = {
  readonly status: (signal: AbortSignal) => Promise<EnvironmentSpeechStatus>;
  readonly streamUrl: (signal: AbortSignal) => Promise<string>;
  readonly canSend: () => boolean;
  readonly openStream?: typeof openSpeechStream;
  readonly onStatus?: (status: EnvironmentSpeechStatus) => void;
  /** What the host takes besides PCM; null or absent: PCM only (F2b). */
  readonly formats?: (signal: AbortSignal) => Promise<StorefrontVoiceFormats | null>;
  readonly opusStreamUrl?: (signal: AbortSignal) => Promise<string>;
  readonly uploadOgg?: (ogg: Uint8Array, signal: AbortSignal) => Promise<string>;
};

/** Streams to the environment while recording when it can, and uploads the recording otherwise. */
export function withLiveStream(
  inner: VoiceTranscriber,
  dependencies: LiveStreamDependencies,
): VoiceTranscriber {
  const open = dependencies.openStream ?? openSpeechStream;
  const formatsOf = (signal: AbortSignal) =>
    dependencies.formats?.(signal).catch(() => null) ?? Promise.resolve(null);
  const connect = async (signal: AbortSignal) => {
    const status = await dependencies.status(signal);
    dependencies.onStatus?.(status);
    if (!status.supported || status.state === "missing-model" || !status.supportsStreaming)
      return null;
    // Only a phone that can encode Opus asks; the others keep upstream's requests as they are.
    const formats = liveOgg.available() ? await formatsOf(signal) : null;
    const opus =
      liveOgg.available() &&
      dependencies.opusStreamUrl !== undefined &&
      formats?.stream.includes("ogg-opus") === true;
    const url = await (opus ? dependencies.opusStreamUrl!(signal) : dependencies.streamUrl(signal));
    throwIfVoiceTranscriptionAborted(signal);
    const stream = open({
      url,
      options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      signal,
      canSend: dependencies.canSend,
      onText: (text) => liveVoiceText.set(text),
      onError: () => {
        livePcm.end();
        liveOgg.detach();
      },
    });
    if (opus) liveOgg.attach((bytes) => stream.feed(bytes));
    else livePcm.attach((pcm) => stream.feed(pcm));
    return { stream, opus, formats };
  };
  return {
    async prepare(options) {
      const prepared = await inner.prepare(options);
      livePcm.begin();
      liveVoiceText.set(null);
      const stop = () => {
        livePcm.end();
        liveOgg.end();
        liveVoiceText.set(null);
      };
      options.signal.addEventListener("abort", stop, { once: true });
      const live = connect(options.signal).catch(() => null);
      void live.then((connected) => connected ?? livePcm.end());
      return {
        get locale() {
          return prepared.locale;
        },
        ...(prepared.start ? { start: prepared.start } : {}),
        async transcribe(uri, transcription) {
          const connected = await live;
          try {
            try {
              if (connected && livePcm.heard() > 0 && (connected.opus || !livePcm.overflowed())) {
                // The last Ogg page goes out before the stream is told to finish.
                if (connected.opus) liveOgg.finish();
                return await connected.stream.finish();
              }
              connected?.stream.cancel();
            } catch (error) {
              throwIfVoiceTranscriptionAborted(transcription.signal);
              if (!dependencies.canSend()) throw error;
            }
            // A host that slept or dropped the stream gets the whole recording as Ogg Opus.
            const formats =
              connected?.formats ??
              (liveOgg.available() ? await formatsOf(transcription.signal) : null);
            const ogg = formats?.upload.includes("ogg-opus") ? liveOgg.finish() : null;
            if (ogg && dependencies.uploadOgg && livePcm.heard() > 0) {
              try {
                return await dependencies.uploadOgg(ogg, transcription.signal);
              } catch (error) {
                throwIfVoiceTranscriptionAborted(transcription.signal);
                if (!dependencies.canSend()) throw error;
              }
            }
          } finally {
            stop();
          }
          return prepared.transcribe(uri, transcription);
        },
      };
    },
  };
}

/**
 * Live words for one environment. The upstream transcriber asks `status` for the environment's
 * status; the live stream reuses that answer, so a recording costs no extra request.
 */
export function liveEnvironment(
  prepared: PreparedConnection,
  canSend: () => boolean,
  run: <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient>,
    signal?: AbortSignal,
    canSend?: () => boolean,
  ) => Promise<A>,
) {
  let latest: Promise<EnvironmentSpeechStatus> | null = null;
  const status = (signal: AbortSignal) => {
    const request = run(getEnvironmentSpeechStatus(prepared), signal, canSend);
    latest = request;
    return request;
  };
  return {
    status,
    wrap: (inner: VoiceTranscriber) =>
      withLiveStream(inner, {
        canSend,
        status: (signal) => {
          const shared = latest;
          latest = null;
          return shared ?? status(signal);
        },
        streamUrl: (signal) => run(getEnvironmentSpeechStreamUrl(prepared), signal, canSend),
        formats: (signal) => {
          const known = voiceFormats.get(prepared);
          if (known) return known;
          const asked = run(getStorefrontVoiceFormats(prepared), signal, canSend);
          voiceFormats.set(prepared, asked);
          return asked;
        },
        opusStreamUrl: (signal) => run(getStorefrontVoiceStreamUrl(prepared), signal, canSend),
        uploadOgg: (ogg, signal) => run(transcribeStorefrontOgg(prepared, ogg), signal, canSend),
        onStatus: (current) =>
          deepgramEnvironments.set(
            prepared,
            current.supported && current.modelId === DEEPGRAM_MODEL_ID,
          ),
      }),
  };
}
