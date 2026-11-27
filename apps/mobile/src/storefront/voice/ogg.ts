/**
 * Storefront Code (fork, see fork/GOAL.md): an Ogg Opus muxer (RFC 7845 on RFC 3533) for the raw
 * Opus packets the StorefrontOpus module encodes. See fork/design/F2-opus-voice.md.
 */

const OPUS_RATE = 48_000;
const MAX_SEGMENTS = 255;
const HEADER_BYTES = 27;
const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;
const VENDOR = "Storefront Code";

export interface OggOpusMuxerOptions {
  /** The PCM rate the encoder was fed; written to OpusHead and used to scale granule positions. */
  readonly inputSampleRate: number;
  /** Encoder priming in 48 kHz samples, which a decoder drops from the start. */
  readonly preSkip: number;
  readonly serial?: number;
}

export interface OggOpusEndOptions {
  /** Defaults to the value of the previous `pages` call. */
  readonly samplesPerPacket?: number;
  /** PCM frames the encoder was fed: trims the silence padding the last packet carries. */
  readonly inputSamples?: number;
}

export interface OggOpusMuxer {
  /** The OpusHead page (beginning of stream) and the OpusTags page. */
  headers(): Uint8Array;
  /** Audio pages holding every packet given, each page ending on a whole packet. */
  pages(packets: ReadonlyArray<Uint8Array>, samplesPerPacket: number): Uint8Array;
  /** The final page, flagged end of stream; empty when no packets remain and none are given. */
  end(lastPackets?: ReadonlyArray<Uint8Array>, options?: OggOpusEndOptions): Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 0x8000_0000 ? (value << 1) ^ 0x04c1_1db7 : value << 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32: polynomial 0x04C11DB7, not reflected, initial value 0, no final XOR. */
export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
  }
  return crc;
}

/** Lacing values for one packet: runs of 255 closed by a value below 255 (0 after an exact multiple). */
export function oggLacing(packetLength: number): number[] {
  const values = Array.from<number>({ length: Math.floor(packetLength / 255) }).fill(255);
  values.push(packetLength % 255);
  return values;
}

function oggPage(input: {
  readonly flags: number;
  readonly granule: number;
  readonly serial: number;
  readonly sequence: number;
  readonly packets: ReadonlyArray<Uint8Array>;
}): Uint8Array {
  const lacing = input.packets.flatMap((packet) => oggLacing(packet.length));
  if (lacing.length > MAX_SEGMENTS) throw new RangeError("Ogg page holds at most 255 segments");
  const bodyLength = input.packets.reduce((sum, packet) => sum + packet.length, 0);
  const page = new Uint8Array(HEADER_BYTES + lacing.length + bodyLength);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  page[5] = input.flags;
  view.setUint32(6, input.granule % 2 ** 32, true);
  view.setUint32(10, Math.floor(input.granule / 2 ** 32), true);
  view.setUint32(14, input.serial, true);
  view.setUint32(18, input.sequence, true);
  page[26] = lacing.length;
  page.set(lacing, HEADER_BYTES);
  let offset = HEADER_BYTES + lacing.length;
  for (const packet of input.packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggCrc32(page), true);
  return page;
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function opusHead(inputSampleRate: number, preSkip: number): Uint8Array {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1;
  head[9] = 1;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  return head;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode(VENDOR);
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  return tags;
}

/** Splits packets into runs that each fit one page. */
function pageRuns(packets: ReadonlyArray<Uint8Array>): Uint8Array[][] {
  const runs: Uint8Array[][] = [];
  let run: Uint8Array[] = [];
  let segments = 0;
  for (const packet of packets) {
    const needed = Math.floor(packet.length / 255) + 1;
    if (needed > MAX_SEGMENTS) throw new RangeError("Opus packet too large for one Ogg page");
    if (segments + needed > MAX_SEGMENTS) {
      runs.push(run);
      run = [];
      segments = 0;
    }
    run.push(packet);
    segments += needed;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

export function createOggOpusMuxer(options: OggOpusMuxerOptions): OggOpusMuxer {
  const { inputSampleRate, preSkip } = options;
  const serial = (options.serial ?? Math.floor(Math.random() * 2 ** 32)) >>> 0;
  /** Audio pages start after the two header pages. */
  let sequence = 2;
  /** PCM frames (at the input rate) the packets so far decode to, priming included. */
  let decodedInputSamples = 0;
  let lastSamplesPerPacket = inputSampleRate / 50;
  let ended = false;

  const granule = () => Math.round((decodedInputSamples * OPUS_RATE) / inputSampleRate);

  const audioPages = (
    packets: ReadonlyArray<Uint8Array>,
    samplesPerPacket: number,
    last: { readonly inputSamples: number | undefined } | null,
  ): Uint8Array => {
    if (ended) throw new Error("Ogg Opus stream already ended");
    lastSamplesPerPacket = samplesPerPacket;
    const runs = pageRuns(packets);
    if (last && runs.length === 0) runs.push([]);
    return concat(
      runs.map((run, index) => {
        const final = last !== null && index === runs.length - 1;
        const before = granule();
        decodedInputSamples += run.length * samplesPerPacket;
        let position = granule();
        if (final && last.inputSamples !== undefined) {
          // End trimming (RFC 7845 section 4.4) may only cut into the samples of this last page.
          const trimmed = preSkip + Math.round((last.inputSamples * OPUS_RATE) / inputSampleRate);
          position = Math.min(position, Math.max(before, trimmed));
        }
        return oggPage({
          flags: final ? FLAG_EOS : 0,
          granule: position,
          serial,
          sequence: sequence++,
          packets: run,
        });
      }),
    );
  };

  return {
    headers: () =>
      concat([
        oggPage({
          flags: FLAG_BOS,
          granule: 0,
          serial,
          sequence: 0,
          packets: [opusHead(inputSampleRate, preSkip)],
        }),
        oggPage({ flags: 0, granule: 0, serial, sequence: 1, packets: [opusTags()] }),
      ]),
    pages: (packets, samplesPerPacket) => audioPages(packets, samplesPerPacket, null),
    end: (lastPackets = [], endOptions = {}) => {
      const page = audioPages(lastPackets, endOptions.samplesPerPacket ?? lastSamplesPerPacket, {
        inputSamples: endOptions.inputSamples,
      });
      ended = true;
      return page;
    },
  };
}
