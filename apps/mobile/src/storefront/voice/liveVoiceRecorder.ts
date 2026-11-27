/**
 * Storefront Code: an environment recorder that hands its PCM to the live stream as it records.
 * Built on expo-audio's AudioStream (16 kHz mono 16-bit), which also writes the WAV file the
 * upload path reads when there is no live stream.
 */
import { AudioModule, type RecorderState, type RecordingStatus } from "expo-audio";
import { Platform } from "react-native";

import type { NativeVoiceRecorder } from "../../features/voice-input/lazyVoiceRecorder";
import { liveOgg } from "./liveOgg";
import { livePcm } from "./liveVoice";

// Loaded at start-up, long before the first dictation; without the module recordings stay PCM.
void import("./opusEncoder")
  .then(({ createOpusEncoder }) => liveOgg.useEncoder(createOpusEncoder))
  .catch(() => undefined);

const SAMPLE_RATE = 16_000;
const SILENCE_DB = -160;

/** Null where AudioStream is missing (an older dev client) or not yet tried (Android). */
export function createLiveVoiceRecorder(): NativeVoiceRecorder<
  RecordingStatus,
  RecorderState
> | null {
  if (Platform.OS !== "ios" || typeof AudioModule.AudioStream !== "function") return null;
  const stream = new AudioModule.AudioStream({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: "int16",
  });
  const listeners = new Set<(status: RecordingStatus) => void>();
  let uri: string | null = null;
  let capturing = false;
  let recording = false;
  let frames = 0;
  let sampleRate = SAMPLE_RATE;
  let metering = SILENCE_DB;
  let limit: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | null = null;

  const emit = (status: Pick<RecordingStatus, "isFinished" | "hasError">) => {
    const event: RecordingStatus = { id: stream.id, error: null, url: uri, ...status };
    for (const listener of listeners) listener(event);
  };
  stream.addListener("audioStreamBuffer", (buffer) => {
    if (!capturing) return;
    const samples = new Int16Array(buffer.data);
    sampleRate = buffer.sampleRate;
    frames += samples.length / Math.max(1, buffer.channels);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    const rms = samples.length ? Math.sqrt(energy / samples.length) / 32768 : 0;
    metering = rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
    if (buffer.channels === 1) {
      livePcm.push(samples, buffer.sampleRate);
      liveOgg.push(samples, buffer.sampleRate);
    }
  });
  stream.addListener("audioStreamStatus", ({ isStreaming }) => {
    // The stream stopping on its own (an interruption) ends the recording with an error.
    if (isStreaming || !capturing || stopping) return;
    capturing = false;
    recording = false;
    emit({ isFinished: false, hasError: true });
  });

  const stop = () =>
    (stopping ??= (async () => {
      clearTimeout(limit);
      recording = false;
      if (!capturing) return;
      capturing = false;
      try {
        await stream.stopFileRecordingAsync();
      } finally {
        stream.stop();
      }
    })());

  return {
    get uri() {
      return uri;
    },
    async prepareToRecordAsync() {
      await stopping?.catch(() => undefined);
      stopping = null;
      uri = null;
      frames = 0;
      metering = SILENCE_DB;
      await stream.start();
      capturing = true;
      try {
        uri = (await stream.startFileRecordingAsync({ format: "wav" })).uri;
      } catch (error) {
        capturing = false;
        stream.stop();
        throw error;
      }
    },
    record({ forDuration }) {
      recording = true;
      limit = setTimeout(
        () =>
          void stop().then(
            () => emit({ isFinished: true, hasError: false }),
            () => emit({ isFinished: false, hasError: true }),
          ),
        forDuration * 1_000,
      );
    },
    stop,
    getStatus: () => ({
      canRecord: true,
      isRecording: recording && capturing,
      durationMillis: Math.round((frames * 1_000) / sampleRate),
      fileSize: 0,
      mediaServicesDidReset: false,
      metering,
      url: uri,
    }),
    addListener(_event, listener) {
      listeners.add(listener);
      return { remove: () => void listeners.delete(listener) };
    },
    // AudioStream follows the audio session's route; it has no input picker of its own.
    getAvailableInputs: () => [],
    setInput: () => undefined,
    release() {
      void stop()
        .catch(() => undefined)
        .finally(() => stream.release());
    },
  };
}
