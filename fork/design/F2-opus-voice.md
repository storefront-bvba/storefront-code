# F2b: Opus on the wire for dictation

Design of 2026-11-27 (base upstream v0.1.12), asked for by Wouter on 2026-11-27 ("bouw
Opus-ondersteuning", a flexible system that picks the format by what each side can do). See F2 in
[../GOAL-CURRENT-STATUS.md](../GOAL-CURRENT-STATUS.md).

## Why

Upstream's speech protocol carries raw Float32 PCM: 64 KB/s, about 3.8 MB a minute, live over
`/ws/voice` and again for an upload (`/api/voice/transcribe`; the phone decodes its recording to
PCM first). Our hosts transcribe with Deepgram, which takes Opus. Measured on 2026-11-27 with a
7.9 s Flemish sentence through `api.eu.deepgram.com` (nova-3, our query options):

|                                   | Bytes  | Upload answer | Transcript       |
| --------------------------------- | ------ | ------------- | ---------------- |
| 16-bit WAV                        | 253 KB | 1326 ms       | right            |
| Ogg Opus, 24 kbit/s, 20 ms frames | 23 KB  | 193 ms        | the same quality |

Live, Ogg Opus sent in 0.1 s pieces at real time gave 9 interim results and the full sentence, with
and without `encoding=ogg-opus`. So Opus is about 1/20 of today's wire bytes, saves radio time (and
battery) on cellular, and makes a recording that waited for a sleeping host arrive quickly.

## The rule

Each side says what it can do; the best format both sides support is used, PCM otherwise. An older
app or an older host keeps today's PCM path. Nobody configures anything.

## Wire (fork; upstream's PCM endpoints stay as they are)

- **Capability:** `GET /api/storefront/voice/formats` (group `storefrontVoice`, contract
  `packages/contracts/src/storefrontVoice.ts`, scope `orchestration:operate`) answers
  `{ stream: ["ogg-opus"], upload: ["ogg-opus"] }` when the host transcribes with Deepgram and
  `{ stream: [], upload: [] }` otherwise. A host without the group answers 404: PCM.
- **Live:** WebSocket `/ws/storefront-voice?wsTicket=…`. The ticket comes from upstream's
  `webSocketTicketFor({ use: "media" })`, checked like `/ws/voice` (media ticket, operate scope).
  The protocol is `/ws/voice`'s exactly (`SpeechStreamCommand` in, `SpeechStreamEvent` out:
  start with `SpeechTranscriptionOptions`, binary frames, finish; ready, update, finished, error).
  Only the binary frames differ: they are consecutive pieces of one Ogg Opus stream (16 kHz mono).
  The host passes them to Deepgram live unchanged, without `encoding` (containerized audio), with
  the same query options as its PCM stream.
- **Upload:** `POST /api/storefront/voice/transcribe`, body framed like upstream's transcribe
  request (4-byte little-endian options length, options JSON, audio) where the audio is one whole
  Ogg Opus file. The host sends it to Deepgram's pre-recorded API as `audio/ogg`.

## Phone

- **Encoder:** a local Expo module `apps/mobile/modules/storefront-opus` (Swift). `AVAudioConverter`
  from 16 kHz mono Int16 PCM to `kAudioFormatOpus` (16 kHz, 320-frame packets = 20 ms, 24 kbit/s),
  giving raw Opus packets. Hardware-friendly and part of iOS; no third-party codec.
- **Ogg:** a small TypeScript muxer (`apps/mobile/src/storefront/voice/ogg.ts`, RFC 7845): OpusHead
  and OpusTags pages, then audio pages with granule positions in 48 kHz units, Ogg CRC-32.
- **Recording:** the live recorder keeps writing its WAV file (the last resort). Its PCM goes to the
  encoder; the Ogg pages go to the live socket once it is open and are kept in memory for the
  upload, so a dropped stream or a host that was asleep uploads about 180 KB a minute.
- **Choice:** per environment, from `formats` (asked once per connection) and whether the encoder
  module exists (an older app or Android: no). Otherwise today's PCM path.

## Web (later)

Browsers encode Opus natively (`MediaRecorder`, `audio/webm;codecs=opus`). The host would add
`webm-opus` to `stream` and `upload` and pass WebM the same way. Not in the first round.

## Upstream

Not a bug fix, so no PR. An Idea in Discussions with the numbers above, as a draft for Wouter: a
format the client and host negotiate, PCM as the floor.
