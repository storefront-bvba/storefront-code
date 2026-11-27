// Storefront Code (fork): the current recording as Ogg Opus, beside its PCM (F2b,
// fork/design/F2-opus-voice.md). Pages go to a host's Opus stream once it is open and are kept
// for an upload, so a dropped stream or a host that slept sends ~200 KB a minute instead of 3.8 MB.
import { createOggOpusMuxer, type OggOpusMuxer } from "./ogg";
import type { OpusEncoder } from "./opusEncoder";

const SAMPLE_RATE = 16_000;
const SAMPLES_PER_PACKET = 320;

type Feed = (bytes: Uint8Array) => void;

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const file = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    file.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return file;
};

export const liveOgg = (() => {
  let makeEncoder: (() => OpusEncoder | null) | null = null;
  let encoder: OpusEncoder | null = null;
  let muxer: OggOpusMuxer | null = null;
  let pages: Uint8Array[] = [];
  let frames = 0;
  let feed: Feed | null = null;
  let ended = false;
  const emit = (page: Uint8Array) => {
    if (page.byteLength === 0) return;
    pages.push(page);
    feed?.(page);
  };
  const release = () => {
    encoder?.release();
    encoder = null;
    muxer = null;
    pages = [];
    frames = 0;
    feed = null;
    ended = false;
  };
  return {
    /** The recorder hands in the native encoder; without one every recording stays PCM. */
    useEncoder(factory: () => OpusEncoder | null) {
      makeEncoder = factory;
    },
    begin() {
      release();
      encoder = makeEncoder?.() ?? null;
      if (!encoder) return;
      muxer = createOggOpusMuxer({ inputSampleRate: SAMPLE_RATE, preSkip: encoder.preSkip });
      emit(muxer.headers());
    },
    available: () => encoder !== null,
    push(samples: Int16Array, sampleRate: number) {
      if (!encoder || !muxer || ended || sampleRate !== SAMPLE_RATE) return;
      frames += samples.length;
      const packets = encoder.encode(samples);
      if (packets.length > 0) emit(muxer.pages(packets, SAMPLES_PER_PACKET));
    },
    /** Sends everything so far, the headers first, then each new page as it is made. */
    attach(next: Feed) {
      for (const page of pages) next(page);
      feed = next;
    },
    detach() {
      feed = null;
    },
    /** Ends the stream (its last page goes to an attached stream too) and returns the file. */
    finish(): Uint8Array | null {
      if (!encoder || !muxer) return null;
      if (!ended) {
        ended = true;
        emit(muxer.end(encoder.finish(), { inputSamples: frames }));
      }
      return concat(pages);
    },
    end: release,
  };
})();
