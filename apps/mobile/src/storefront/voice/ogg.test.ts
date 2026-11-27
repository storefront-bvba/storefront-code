import { describe, expect, it } from "vite-plus/test";

import { createOggOpusMuxer, oggCrc32 } from "./ogg";

// The first page ffmpeg (libavformat 63, libopus, 16 kHz mono) wrote for /tmp/sc-opus-test/voice.ogg.
const FFMPEG_OPUS_HEAD_PAGE =
  "4f67675300020000000000000000ee63cadf0000000049a6f5ed01134f7075734865616401013801803e0000000000";
const FFMPEG_SERIAL = 0xdfca63ee;

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const packet = (length: number) => new Uint8Array(length).fill(length % 251);
const packets = (count: number, length = 40) => Array.from({ length: count }, () => packet(length));

function parsePages(bytes: Uint8Array) {
  const pages = [];
  let offset = 0;
  while (offset < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    expect(new TextDecoder().decode(bytes.subarray(offset, offset + 4))).toBe("OggS");
    const count = view.getUint8(26);
    const segments = [...bytes.subarray(offset + 27, offset + 27 + count)];
    const length = 27 + count + segments.reduce((sum, value) => sum + value, 0);
    const page = bytes.slice(offset, offset + length);
    const stored = view.getUint32(22, true);
    page.fill(0, 22, 26);
    pages.push({
      flags: view.getUint8(5),
      granule: view.getUint32(6, true) + view.getUint32(10, true) * 2 ** 32,
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      segments,
      body: bytes.subarray(offset + 27 + count, offset + length),
      crcMatches: oggCrc32(page) === stored,
    });
    offset += length;
  }
  return pages;
}

describe("oggCrc32", () => {
  it("is CRC-32/POSIX without the final XOR, and matches a page ffmpeg wrote", () => {
    expect(oggCrc32(new TextEncoder().encode("123456789"))).toBe(0x89a1897f);
    const page = fromHex(FFMPEG_OPUS_HEAD_PAGE);
    page.fill(0, 22, 26);
    expect(oggCrc32(page)).toBe(0xedf5a649);
  });
});

describe("createOggOpusMuxer", () => {
  it("writes OpusHead as ffmpeg does, then OpusTags with our vendor", () => {
    const muxer = createOggOpusMuxer({
      inputSampleRate: 16_000,
      preSkip: 312,
      serial: FFMPEG_SERIAL,
    });
    const headers = muxer.headers();
    expect(headers.subarray(0, 47)).toEqual(fromHex(FFMPEG_OPUS_HEAD_PAGE));
    const [head, tags] = parsePages(headers);
    expect(head?.flags).toBe(0x02);
    expect(tags).toMatchObject({ flags: 0, granule: 0, sequence: 1, crcMatches: true });
    const body = tags?.body ?? new Uint8Array();
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(new TextDecoder().decode(body.subarray(0, 8))).toBe("OpusTags");
    const vendorLength = view.getUint32(8, true);
    expect(new TextDecoder().decode(body.subarray(12, 12 + vendorLength))).toBe("Storefront Code");
    expect(view.getUint32(12 + vendorLength, true)).toBe(0);
    expect(body.length).toBe(12 + vendorLength + 4);
  });

  it("laces packets of 0, 255, 256 and 600 bytes", () => {
    const muxer = createOggOpusMuxer({ inputSampleRate: 16_000, preSkip: 312, serial: 7 });
    const sizes = [0, 255, 256, 600];
    const [page, ...rest] = parsePages(muxer.pages(sizes.map(packet), 320));
    expect(rest).toEqual([]);
    expect(page?.segments).toEqual([0, 255, 0, 255, 1, 255, 255, 90]);
    expect(page?.body).toEqual(Uint8Array.from(sizes.flatMap((size) => [...packet(size)])));
    expect(page).toMatchObject({ flags: 0, sequence: 2, serial: 7, crcMatches: true });
  });

  it("counts granules in 48 kHz samples and starts a new page after 255 segments", () => {
    const muxer = createOggOpusMuxer({ inputSampleRate: 16_000, preSkip: 312, serial: 7 });
    const first = parsePages(muxer.pages(packets(50), 320));
    const second = parsePages(muxer.pages(packets(300, 10), 320));
    expect(first.map(({ sequence, granule }) => ({ sequence, granule }))).toEqual([
      { sequence: 2, granule: 50 * 960 },
    ]);
    expect(
      second.map(({ sequence, granule, segments }) => [sequence, granule, segments.length]),
    ).toEqual([
      [3, 305 * 960, 255],
      [4, 350 * 960, 45],
    ]);
  });

  it("ends with an EOS page trimmed to the input, never into an earlier page", () => {
    const trimmed = createOggOpusMuxer({ inputSampleRate: 16_000, preSkip: 312, serial: 7 });
    trimmed.pages(packets(396), 320);
    const [last] = parsePages(trimmed.end(packets(2), { inputSamples: 126_787 }));
    expect(last).toMatchObject({ flags: 0x04, granule: 312 + 126_787 * 3, crcMatches: true });
    expect(() => trimmed.pages(packets(1), 320)).toThrow();

    const overTrimmed = createOggOpusMuxer({ inputSampleRate: 16_000, preSkip: 312, serial: 7 });
    overTrimmed.pages(packets(10), 320);
    expect(parsePages(overTrimmed.end(packets(1), { inputSamples: 320 }))[0]?.granule).toBe(
      10 * 960,
    );

    const empty = createOggOpusMuxer({ inputSampleRate: 16_000, preSkip: 312, serial: 7 });
    empty.pages(packets(10), 320);
    expect(parsePages(empty.end())).toMatchObject([
      { flags: 0x04, granule: 10 * 960, sequence: 3, segments: [], crcMatches: true },
    ]);
  });
});
