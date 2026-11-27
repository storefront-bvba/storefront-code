// Storefront Code (fork): Opus on the wire for dictation (fork/design/F2-opus-voice.md). Asks a
// host which formats it takes, finds its Opus stream and uploads a whole Ogg Opus recording.
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  STOREFRONT_VOICE_STREAM_PATH,
  type StorefrontVoiceFormats,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { executeAuthenticatedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { getEnvironmentSpeechStreamUrl } from "@t3tools/client-runtime/voice-input";
import { encodeSpeechPcmRequest } from "@t3tools/shared/speech";
import * as Effect from "effect/Effect";

const FORMATS_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;

// Our hosts are reached directly (Tailscale or LAN), so only the DPoP signer applies here; the
// remote authorization upstream adds is for hosts behind T3 Connect.
const auth = Effect.gen(function* () {
  return { signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner) };
});

/** What the host takes besides PCM; null for a host without our voice endpoints (PCM only). */
export const getStorefrontVoiceFormats = Effect.fn("storefrontVoice.formats")(
  function* (prepared: PreparedConnection) {
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      group: "storefrontVoice",
      prepared,
      ...(yield* auth),
      method: "GET",
      url: (urls) => urls.formats(),
      timeoutMs: FORMATS_TIMEOUT_MS,
      requestInit: { redirect: "error" },
      request: ({ client, headers }) => client.formats({ headers }),
    });
  },
  Effect.orElseSucceed((): StorefrontVoiceFormats | null => null),
);

/** The host's Opus stream, with a media ticket like upstream's `/ws/voice`. */
export const getStorefrontVoiceStreamUrl = (prepared: PreparedConnection) =>
  getEnvironmentSpeechStreamUrl(prepared).pipe(
    Effect.map((speechUrl) => {
      const url = new URL(speechUrl);
      url.pathname = STOREFRONT_VOICE_STREAM_PATH;
      return url.toString();
    }),
  );

/** Transcribes one whole Ogg Opus recording on the host. */
export const transcribeStorefrontOgg = Effect.fn("storefrontVoice.transcribe")(function* (
  prepared: PreparedConnection,
  ogg: Uint8Array,
) {
  const result = yield* executeAuthenticatedEnvironmentHttpRequest({
    group: "storefrontVoice",
    prepared,
    ...(yield* auth),
    method: "POST",
    url: (urls) => urls.transcribe(),
    timeoutMs: UPLOAD_TIMEOUT_MS,
    requestInit: { redirect: "error" },
    request: ({ client, headers }) =>
      client.transcribe({
        headers,
        payload: encodeSpeechPcmRequest(ogg, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
      }),
  });
  return result.text;
});
