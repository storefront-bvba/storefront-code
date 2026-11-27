/**
 * Storefront Code (fork, see fork/GOAL.md): raw Opus packets from the StorefrontOpus module (iOS,
 * AudioToolbox's encoder), for the Ogg muxer in ./ogg. See fork/design/F2-opus-voice.md.
 */
import { requireOptionalNativeModule } from "expo";

export const OPUS_SAMPLE_RATE = 16_000;
export const OPUS_BIT_RATE = 24_000;
/** 20 ms at 16 kHz: the encoder's packet size. */
export const OPUS_SAMPLES_PER_PACKET = 320;

interface StorefrontOpusModule {
  createEncoder(sampleRate: number, bitRate: number): number;
  encode(id: number, pcm: Uint8Array): Uint8Array[];
  finish(id: number): Uint8Array[];
  preSkip(id: number): number;
  release(id: number): void;
}

export interface OpusEncoder {
  /** Encoder priming in 48 kHz samples, for OpusHead. */
  readonly preSkip: number;
  /** 16 kHz mono 16-bit PCM in; whole packets out, the rest waits for the next call. */
  encode(pcm: Int16Array): Uint8Array[];
  /** Pads the last packet with silence and drains the encoder. */
  finish(): Uint8Array[];
  release(): void;
}

/** Null without the module (an older dev client, Android) or an encoder: callers send PCM. */
export function createOpusEncoder(): OpusEncoder | null {
  const native = requireOptionalNativeModule<StorefrontOpusModule>("StorefrontOpus");
  if (!native) return null;
  let id: number;
  try {
    id = native.createEncoder(OPUS_SAMPLE_RATE, OPUS_BIT_RATE);
  } catch {
    return null;
  }
  return {
    preSkip: native.preSkip(id),
    encode: (pcm) => native.encode(id, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)),
    finish: () => native.finish(id),
    release: () => native.release(id),
  };
}
