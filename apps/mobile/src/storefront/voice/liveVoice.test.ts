import type { EnvironmentSpeechStatus } from "@t3tools/contracts";
import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import { expect, it, vi } from "vite-plus/test";

import { livePcm, liveVoiceText, withLiveStream } from "./liveVoice";

const streaming = { supported: true, state: "ready", supportsStreaming: true } as const;
const upload: VoiceTranscriber = {
  prepare: async () => ({ locale: "auto", transcribe: async () => "uploaded recording" }),
};

function fakeStream(final: Promise<string>) {
  const fed: number[] = [];
  const open = vi.fn(
    (input: { onText: (text: { committed: string; tentative: string }) => void }) => {
      input.onText({ committed: "kan je", tentative: " de" });
      return {
        feed: (pcm: Float32Array) => fed.push(...pcm),
        finish: () => final,
        cancel: () => undefined,
      };
    },
  );
  return { fed, open };
}

it("streams audio recorded before the stream connected, in order, then returns its final text", async () => {
  const connected = Promise.withResolvers<string>();
  const stream = fakeStream(Promise.resolve("Kan je de README nakijken?"));
  const transcriber = withLiveStream(upload, {
    canSend: () => true,
    status: async () => streaming as EnvironmentSpeechStatus,
    streamUrl: () => connected.promise,
    openStream: stream.open as never,
  });
  const signal = new AbortController().signal;
  const recording = await transcriber.prepare({ signal });
  livePcm.push(new Int16Array([16384]), 16_000);
  livePcm.push(new Int16Array([-16384]), 16_000);
  connected.resolve("wss://environment/ws/voice");
  const text = recording.transcribe("file:///recording.wav", { signal });
  await expect(text).resolves.toBe("Kan je de README nakijken?");
  expect(stream.fed).toEqual([0.5, -0.5]);
  expect(liveVoiceText.get()).toBeNull();
});

it("uploads the recording when the live stream fails", async () => {
  const stream = fakeStream(Promise.reject(new Error("The voice connection closed.")));
  const transcriber = withLiveStream(upload, {
    canSend: () => true,
    status: async () => streaming as EnvironmentSpeechStatus,
    streamUrl: async () => "wss://environment/ws/voice",
    openStream: stream.open as never,
  });
  const signal = new AbortController().signal;
  const recording = await transcriber.prepare({ signal });
  livePcm.push(new Int16Array([16384]), 16_000);
  await expect(recording.transcribe("file:///recording.wav", { signal })).resolves.toBe(
    "uploaded recording",
  );
});

it("uploads when no microphone audio reached the stream, as with a file-only recorder", async () => {
  const stream = fakeStream(Promise.resolve(""));
  const transcriber = withLiveStream(upload, {
    canSend: () => true,
    status: async () => streaming as EnvironmentSpeechStatus,
    streamUrl: async () => "wss://environment/ws/voice",
    openStream: stream.open as never,
  });
  const signal = new AbortController().signal;
  const recording = await transcriber.prepare({ signal });
  await expect(recording.transcribe("file:///recording.m4a", { signal })).resolves.toBe(
    "uploaded recording",
  );
});

it("uploads without opening a stream when the environment can't stream", async () => {
  const stream = fakeStream(Promise.resolve("unexpected"));
  const transcriber = withLiveStream(upload, {
    canSend: () => true,
    status: async () => ({ ...streaming, supportsStreaming: false }) as EnvironmentSpeechStatus,
    streamUrl: async () => "wss://environment/ws/voice",
    openStream: stream.open as never,
  });
  const signal = new AbortController().signal;
  const recording = await transcriber.prepare({ signal });
  await expect(recording.transcribe("file:///recording.wav", { signal })).resolves.toBe(
    "uploaded recording",
  );
  expect(stream.open).not.toHaveBeenCalled();
});
