import type {
  SpeechCustomWords,
  SpeechStreamText,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { normalizeSpeechCustomWords, speechRecognitionWords } from "../../speech/customWords.ts";

export type DeepgramSettings = {
  readonly baseUrl: string;
  readonly model: string;
  /** One code transcribes only that language; several switch to `multi` with each as a hint. */
  readonly languages: ReadonlyArray<string>;
};

/** Live audio as 16 kHz mono 16-bit samples, or in a container Deepgram reads itself (Ogg Opus). */
export type DeepgramLiveAudio = "linear16" | "container";

export const baseLanguage = (code: string) => code.split(/[-_]/, 1)[0]!.toLowerCase();

/** The host's languages, unless the person picked one the host does not list. */
export function deepgramLanguages(settings: DeepgramSettings, requested: string) {
  if (
    requested === "auto" ||
    settings.languages.some((code) => baseLanguage(code) === baseLanguage(requested))
  )
    return settings.languages;
  return [requested];
}

/** The host's keyterms file: one term per line; a line starting with `#` is a comment. */
export const hostKeyterms = (text: string): SpeechCustomWords =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((term) => ({ term, aliases: [] }));

// Deepgram takes at most 100 keyterms and 500 tokens; long lists also dilute the boost.
const MAX_KEYTERMS = 50;
const MAX_KEYTERM_CHARACTERS = 1_200;

export function deepgramKeyterms(
  options: SpeechTranscriptionOptions,
  environmentWords: SpeechCustomWords,
): string[] {
  const dictionary = normalizeSpeechCustomWords([
    ...options.speechCustomWords,
    ...environmentWords,
  ]);
  const seen = new Set<string>();
  const terms: string[] = [];
  let characters = 0;
  for (const term of speechRecognitionWords(
    options.speechHints,
    dictionary.map(({ term }) => term),
  )) {
    const value = term.replace(/\s+/g, " ").trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    if (terms.length >= MAX_KEYTERMS || characters + value.length > MAX_KEYTERM_CHARACTERS) break;
    seen.add(key);
    terms.push(value);
    characters += value.length;
  }
  return terms;
}

export function deepgramQuery(
  settings: DeepgramSettings,
  options: SpeechTranscriptionOptions,
  keyterms: ReadonlyArray<string>,
  mode: "batch" | `live-${DeepgramLiveAudio}`,
) {
  const languages = deepgramLanguages(settings, options.speechLanguage);
  const query = new URLSearchParams({ model: settings.model });
  if (languages.length === 1) query.set("language", languages[0]!);
  else {
    query.set("language", "multi");
    for (const language of languages) query.append("language_hint", language);
  }
  query.set("smart_format", "true");
  if (mode !== "batch") {
    // A container carries its own encoding, rate and channels.
    if (mode === "live-linear16") {
      query.set("encoding", "linear16");
      query.set("sample_rate", "16000");
      query.set("channels", "1");
    }
    query.set("interim_results", "true");
    // Deepgram's value for code-switching; it only splits finals, the person decides when to stop.
    query.set("endpointing", languages.length === 1 ? "300" : "100");
  }
  for (const term of keyterms) query.append("keyterm", term);
  // No audio or transcript for Deepgram's model training, and no keyterms in its usage logs.
  query.set("mip_opt_out", "true");
  query.set("redact_usage", "true");
  return query;
}

export function pcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function wav16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const pcm = pcm16(samples);
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at);
  tag(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(pcm, 44);
  return bytes;
}

const Alternatives = Schema.Array(Schema.Struct({ transcript: Schema.String }));

export const DeepgramBatchResponse = Schema.Struct({
  results: Schema.Struct({
    channels: Schema.Array(Schema.Struct({ alternatives: Alternatives })),
  }),
});

const DeepgramLiveMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("Results"),
    is_final: Schema.optionalKey(Schema.Boolean),
    channel: Schema.Struct({ alternatives: Alternatives }),
  }),
  Schema.Struct({ type: Schema.Literal("Metadata") }),
]);
const decodeLiveMessage = Schema.decodeUnknownOption(Schema.fromJsonString(DeepgramLiveMessage));

/** Joins Deepgram's final segments and shows the latest interim one after them. */
export function makeDeepgramTranscript(correct: (text: string) => string) {
  const finals: string[] = [];
  let interim = "";
  let revision = 0;
  let reported = 0;
  return {
    /** Returns true once Deepgram reported that it has sent everything. */
    accept(frame: string | Uint8Array): boolean {
      const message = decodeLiveMessage(
        typeof frame === "string" ? frame : new TextDecoder().decode(frame),
      );
      if (Option.isNone(message)) return false;
      if (message.value.type === "Metadata") return true;
      const text = message.value.channel.alternatives[0]?.transcript.trim() ?? "";
      if (message.value.is_final) {
        if (text) finals.push(text);
        interim = "";
      } else interim = text;
      revision += 1;
      return false;
    },
    /** The text for the next acknowledgement, or null when nothing changed since the last one. */
    update(): { readonly revision: number; readonly text: SpeechStreamText | null } {
      if (reported === revision) return { revision, text: null };
      reported = revision;
      const committed = correct(finals.join(" "));
      const tentative = correct(interim);
      return {
        revision,
        text: { committed: committed && tentative ? `${committed} ` : committed, tentative },
      };
    },
    final: () => finals.join(" "),
  };
}
