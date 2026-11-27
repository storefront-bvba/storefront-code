import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { liveOgg } from "./liveOgg";
import { livePcm, withLiveStream } from "./liveVoice";
import type { OpusEncoder } from "./opusEncoder";

/** One fake packet per 20 ms of input, so pages can be counted. */
function fakeEncoder(): OpusEncoder {
  let pending = 0;
  return {
    preSkip: 312,
    encode(pcm) {
      pending += pcm.length;
      const packets: Uint8Array[] = [];
      while (pending >= 320) {
        pending -= 320;
        packets.push(new Uint8Array([0x48, packets.length]));
      }
      return packets;
    },
    finish: () => (pending > 0 ? [new Uint8Array([0x48, 0xff])] : []),
    release: () => undefined,
  };
}

const upload: VoiceTranscriber = {
  prepare: async () => ({ locale: "auto", transcribe: async () => "uploaded WAV" }),
};
const streaming = async () =>
  ({ supported: true, state: "ready", supportsStreaming: true }) as never;
const opusHost = async () => ({ stream: ["ogg-opus" as const], upload: ["ogg-opus" as const] });
const isOgg = (bytes: Uint8Array) => String.fromCharCode(...bytes.subarray(0, 4)) === "OggS";

function fakeStream(final: () => Promise<string>) {
  const fed: Uint8Array[] = [];
  const order: string[] = [];
  const open = vi.fn(() => ({
    feed: (chunk: Float32Array | Uint8Array) => {
      order.push("feed");
      fed.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    },
    finish: () => {
      order.push("finish");
      return final();
    },
    cancel: () => undefined,
  }));
  return { fed, order, open };
}

const speak = (samples: number) => {
  const pcm = new Int16Array(samples);
  livePcm.push(pcm, 16_000);
  liveOgg.push(pcm, 16_000);
};

afterEach(() => {
  livePcm.end();
  liveOgg.end();
  liveOgg.useEncoder(() => null);
});

it("streams Ogg Opus to a host that takes it, the last page before finish", async () => {
  liveOgg.useEncoder(fakeEncoder);
  const stream = fakeStream(async () => "Kan je de README nakijken?");
  const transcriber = withLiveStream(upload, {
    canSend: () => true,
    status: streaming,
    streamUrl: async () => "wss://host/ws/voice",
    opusStreamUrl: async () => "wss://host/ws/storefront-voice",
    formats: opusHost,
    openStream: stream.open as never,
  });
  const prepared = await transcriber.prepare({ signal: new AbortController().signal });
  await vi.waitFor(() => expect(stream.open).toHaveBeenCalled());
  speak(640);

  const text = await prepared.transcribe("file://r.wav", { signal: new AbortController().signal });
  expect(text).toBe("Kan je de README nakijken?");
  expect((stream.open.mock.calls[0] as unknown as [{ url: string }])[0].url).toBe(
    "wss://host/ws/storefront-voice",
  );
  expect(stream.fed.every(isOgg)).toBe(true);
  expect(stream.order.at(-1)).toBe("finish");
  expect(stream.order.at(-2)).toBe("feed");
});

it("uploads the whole recording as Ogg Opus when the stream failed", async () => {
  liveOgg.useEncoder(fakeEncoder);
  const uploaded: Uint8Array[] = [];
  const stream = fakeStream(async () => {
    throw new Error("socket closed");
  });
  const transcriber = withLiveStream(upload, {
    canSend: () => true,
    status: streaming,
    streamUrl: async () => "wss://host/ws/voice",
    opusStreamUrl: async () => "wss://host/ws/storefront-voice",
    formats: opusHost,
    uploadOgg: async (ogg) => {
      uploaded.push(ogg);
      return "uploaded Ogg";
    },
    openStream: stream.open as never,
  });
  const prepared = await transcriber.prepare({ signal: new AbortController().signal });
  speak(16_000);
  expect(await prepared.transcribe("file://r.wav", { signal: new AbortController().signal })).toBe(
    "uploaded Ogg",
  );
  expect(uploaded).toHaveLength(1);
  expect(isOgg(uploaded[0]!)).toBe(true);
});

it("keeps PCM for a host without our formats, or a phone without the encoder", async () => {
  liveOgg.useEncoder(fakeEncoder);
  const stream = fakeStream(async () => "pcm text");
  const formats = vi.fn(async () => null);
  const transcriber = withLiveStream(upload, {
    canSend: () => true,
    status: streaming,
    streamUrl: async () => "wss://host/ws/voice",
    opusStreamUrl: async () => "wss://host/ws/storefront-voice",
    formats,
    openStream: stream.open as never,
  });
  const prepared = await transcriber.prepare({ signal: new AbortController().signal });
  await vi.waitFor(() => expect(stream.open).toHaveBeenCalled());
  speak(320);
  expect(await prepared.transcribe("file://r.wav", { signal: new AbortController().signal })).toBe(
    "pcm text",
  );
  expect((stream.open.mock.calls[0] as unknown as [{ url: string }])[0].url).toBe(
    "wss://host/ws/voice",
  );
  expect(stream.fed[0]!.byteLength).toBe(320 * 4);

  liveOgg.useEncoder(() => null);
  formats.mockClear();
  await withLiveStream(upload, {
    canSend: () => true,
    status: streaming,
    streamUrl: async () => "wss://host/ws/voice",
    formats,
    openStream: fakeStream(async () => "").open as never,
  }).prepare({ signal: new AbortController().signal });
  expect(formats).not.toHaveBeenCalled();
});

it("sends what was said while the host slept, headers first, once its stream opens", () => {
  liveOgg.useEncoder(fakeEncoder);
  livePcm.hold();
  speak(960);
  livePcm.begin();
  const fed: Uint8Array[] = [];
  liveOgg.attach((page) => fed.push(page));
  speak(320);
  expect(fed.length).toBeGreaterThanOrEqual(3);
  expect(fed.every(isOgg)).toBe(true);
  // OpusHead comes first, in a page flagged as the beginning of the stream.
  expect(fed[0]![5]).toBe(0x02);
  expect(String.fromCharCode(...fed[0]!.subarray(28, 36))).toBe("OpusHead");
});
