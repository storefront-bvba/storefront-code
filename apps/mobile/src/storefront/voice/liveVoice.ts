/**
 * Storefront Code: live words on the phone. While an environment that streams (Deepgram) records,
 * the microphone's PCM goes to it over the speech WebSocket and its text shows in the composer.
 * The recording file is kept, so a dropped stream still ends in an upload of the whole recording.
 */
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  type EnvironmentSpeechStatus,
  type SpeechStreamText,
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

/** The server's id for its Deepgram model (apps/server/src/storefront/deepgram). */
const DEEPGRAM_MODEL_ID = "storefront/deepgram";
const SAMPLE_RATE = 16_000;
const MAX_QUEUED_SAMPLES = SAMPLE_RATE * 60;

type Feed = (pcm: Float32Array) => void;

/** Microphone audio of the current recording, held until the live stream has connected. */
export const livePcm = (() => {
  let open = false;
  let feed: Feed | null = null;
  let queued: Float32Array[] = [];
  let queuedSamples = 0;
  let heard = 0;
  return {
    begin() {
      open = true;
      feed = null;
      queued = [];
      queuedSamples = 0;
      heard = 0;
    },
    /** Samples of this recording that can stream; none means the recorder only writes a file. */
    heard: () => heard,
    push(samples: Int16Array, sampleRate: number) {
      if (!open || sampleRate !== SAMPLE_RATE) return;
      heard += samples.length;
      const pcm = new Float32Array(samples.length);
      for (let index = 0; index < samples.length; index++) pcm[index] = samples[index]! / 32768;
      if (feed) return feed(pcm);
      if (queuedSamples + pcm.length > MAX_QUEUED_SAMPLES) return;
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

/** Whether the environment's last status said it transcribes through Deepgram. */
export const transcribesWithDeepgram = (prepared: PreparedConnection) =>
  deepgramEnvironments.get(prepared) === true;

type LiveStreamDependencies = {
  readonly status: (signal: AbortSignal) => Promise<EnvironmentSpeechStatus>;
  readonly streamUrl: (signal: AbortSignal) => Promise<string>;
  readonly canSend: () => boolean;
  readonly openStream?: typeof openSpeechStream;
  readonly onStatus?: (status: EnvironmentSpeechStatus) => void;
};

/** Streams to the environment while recording when it can, and uploads the recording otherwise. */
export function withLiveStream(
  inner: VoiceTranscriber,
  dependencies: LiveStreamDependencies,
): VoiceTranscriber {
  const open = dependencies.openStream ?? openSpeechStream;
  const connect = async (signal: AbortSignal) => {
    const status = await dependencies.status(signal);
    dependencies.onStatus?.(status);
    if (!status.supported || status.state === "missing-model" || !status.supportsStreaming)
      return null;
    const url = await dependencies.streamUrl(signal);
    throwIfVoiceTranscriptionAborted(signal);
    const stream = open({
      url,
      options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      signal,
      canSend: dependencies.canSend,
      onText: (text) => liveVoiceText.set(text),
      onError: () => livePcm.end(),
    });
    livePcm.attach((pcm) => stream.feed(pcm));
    return stream;
  };
  return {
    async prepare(options) {
      const prepared = await inner.prepare(options);
      livePcm.begin();
      liveVoiceText.set(null);
      const stop = () => {
        livePcm.end();
        liveVoiceText.set(null);
      };
      options.signal.addEventListener("abort", stop, { once: true });
      const live = connect(options.signal).catch(() => null);
      void live.then((stream) => stream ?? livePcm.end());
      return {
        get locale() {
          return prepared.locale;
        },
        ...(prepared.start ? { start: prepared.start } : {}),
        async transcribe(uri, transcription) {
          const stream = await live;
          try {
            if (stream && livePcm.heard() > 0) return await stream.finish();
            stream?.cancel();
          } catch (error) {
            throwIfVoiceTranscriptionAborted(transcription.signal);
            if (!dependencies.canSend()) throw error;
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
        onStatus: (current) =>
          deepgramEnvironments.set(
            prepared,
            current.supported && current.modelId === DEEPGRAM_MODEL_ID,
          ),
      }),
  };
}
