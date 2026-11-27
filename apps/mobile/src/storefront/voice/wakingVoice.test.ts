import { EnvironmentId } from "@t3tools/contracts";
import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { livePcm, withLiveStream } from "./liveVoice";
import {
  keepsRecordingOnRouteChange,
  markVoiceRoute,
  voiceWake,
  wakingTranscriber,
} from "./wakingVoice";

const omarchy = EnvironmentId.make("env-omarchy");

function sleepingEnvironment() {
  let connection: string | null = null;
  const listeners = new Set<() => void>();
  const nudged: string[] = [];
  const prepared: string[] = [];
  const real: VoiceTranscriber = {
    prepare: async () => {
      prepared.push(connection ?? "none");
      return { locale: "nl", transcribe: async (uri) => `text of ${uri} via ${connection}` };
    },
  };
  return {
    nudged,
    prepared,
    wake(next: string) {
      connection = next;
      for (const listener of listeners) listener();
    },
    transcriber: wakingTranscriber({
      environmentId: omarchy,
      name: "Omarchy",
      connection: () => connection,
      onConnection: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      nudge: (id) => nudged.push(id),
      transcriber: () => real,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  livePcm.end();
  voiceWake.set(null);
});

it("records at once, wakes the environment and transcribes once it is awake", async () => {
  const host = sleepingEnvironment();
  const prepared = await host.transcriber.prepare({ signal: new AbortController().signal });
  expect(voiceWake.get()).toEqual({ name: "Omarchy" });
  expect(host.nudged).toEqual([omarchy]);
  expect(prepared.start).toBeUndefined();

  const text = prepared.transcribe("file://recording.wav", {
    signal: new AbortController().signal,
  });
  host.wake("connection-1");
  expect(await text).toBe("text of file://recording.wav via connection-1");
  expect(host.prepared).toEqual(["connection-1"]);
  expect(voiceWake.get()).toBeNull();
});

it("keeps nudging every few seconds and gives up with a clear message", async () => {
  vi.useFakeTimers();
  const host = sleepingEnvironment();
  const prepared = await host.transcriber.prepare({ signal: new AbortController().signal });
  const text = prepared.transcribe("file://recording.wav", {
    signal: new AbortController().signal,
  });
  const failure = expect(text).rejects.toThrow("Omarchy did not wake up");
  await vi.advanceTimersByTimeAsync(15_000);
  expect(host.nudged.length).toBe(4);
  await vi.advanceTimersByTimeAsync(3 * 60_000);
  await failure;
  expect(voiceWake.get()).toBeNull();
});

it("holds the audio spoken before the environment woke for its live stream", () => {
  const fed: number[] = [];
  livePcm.hold();
  livePcm.push(new Int16Array([16384, -16384]), 16_000);
  livePcm.begin();
  livePcm.attach((pcm) => fed.push(...pcm));
  livePcm.push(new Int16Array([8192]), 16_000);
  expect(fed).toEqual([0.5, -0.5, 0.25]);
  expect(livePcm.overflowed()).toBe(false);
});

it("uploads the whole recording when more was said than the phone could hold", async () => {
  const upload: VoiceTranscriber = {
    prepare: async () => ({ locale: "auto", transcribe: async () => "the whole recording" }),
  };
  const transcriber = withLiveStream(upload, {
    canSend: () => true,
    status: async () =>
      ({
        supported: true,
        state: "ready",
        supportsStreaming: true,
      }) as never,
    streamUrl: async () => "wss://host/ws/voice",
    openStream: () =>
      ({
        feed: () => undefined,
        finish: async () => "only the first minute",
        cancel: () => undefined,
      }) as never,
  });
  livePcm.hold();
  livePcm.push(new Int16Array(16_000 * 61), 16_000);
  const prepared = await transcriber.prepare({ signal: new AbortController().signal });
  expect(livePcm.overflowed()).toBe(true);
  expect(
    await prepared.transcribe("file://recording.wav", { signal: new AbortController().signal }),
  ).toBe("the whole recording");
});

it("keeps a recording when the environment it waits for wakes up, not on other changes", () => {
  const grant = { id: "grant-1" };
  const other = { id: "grant-2" };
  const waking = { transcriber: markVoiceRoute(sleepingEnvironment().transcriber, grant) };
  const connected = (owner: object) => ({
    transcriber: markVoiceRoute({ prepare: async () => ({}) as never }, owner),
  });
  expect(keepsRecordingOnRouteChange(waking, connected(grant))).toBe(true);
  expect(keepsRecordingOnRouteChange(waking, { transcriber: null })).toBe(true);
  expect(keepsRecordingOnRouteChange(waking, connected(other))).toBe(false);
  expect(keepsRecordingOnRouteChange(waking, null)).toBe(false);
  expect(keepsRecordingOnRouteChange(connected(grant), waking)).toBe(false);
});
