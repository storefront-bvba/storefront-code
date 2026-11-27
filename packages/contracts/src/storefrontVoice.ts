// Storefront Code (fork): dictation as Ogg Opus instead of Float32 PCM, about 1/20 of the bytes
// (fork/design/F2-opus-voice.md). The host says which formats it takes; PCM stays the floor.
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

// Types only: environmentHttp.ts adds this group, so a value import would be a cycle.
import type * as EnvironmentHttp from "./environmentHttp.ts";
import { EnvironmentSpeechTranscriptionResult } from "./speech.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

/** `/ws/voice`'s protocol, with binary frames that are consecutive pieces of one Ogg Opus stream. */
export const STOREFRONT_VOICE_STREAM_PATH = "/ws/storefront-voice";

export const StorefrontVoiceFormat = Schema.Literal("ogg-opus");
export type StorefrontVoiceFormat = typeof StorefrontVoiceFormat.Type;

export const StorefrontVoiceFormats = Schema.Struct({
  stream: Schema.Array(StorefrontVoiceFormat),
  upload: Schema.Array(StorefrontVoiceFormat),
});
export type StorefrontVoiceFormats = typeof StorefrontVoiceFormats.Type;

export interface StorefrontVoiceHttpApiDependencies {
  readonly auth: typeof EnvironmentHttp.EnvironmentAuthenticatedAuth;
  readonly bodyLimit: typeof EnvironmentHttp.EnvironmentVoiceBodyLimit;
  readonly requestInvalid: typeof EnvironmentHttp.EnvironmentRequestInvalidError;
  readonly scopeRequired: typeof EnvironmentHttp.EnvironmentScopeRequiredError;
  readonly internal: typeof EnvironmentHttp.EnvironmentInternalError;
}

/** Built by environmentHttp.ts with its own middleware and errors, so both sides share them. */
export const makeStorefrontVoiceHttpApi = (deps: StorefrontVoiceHttpApiDependencies) =>
  HttpApiGroup.make("storefrontVoice")
    .add(
      HttpApiEndpoint.get("formats", "/api/storefront/voice/formats", {
        headers: OptionalBearerHeaders,
        success: StorefrontVoiceFormats,
        error: [deps.scopeRequired, deps.internal],
      }).middleware(deps.auth),
    )
    .add(
      // Framed like `/api/voice/transcribe`: options length (u32 LE), options JSON, one Ogg Opus file.
      HttpApiEndpoint.post("transcribe", "/api/storefront/voice/transcribe", {
        headers: OptionalBearerHeaders,
        payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
        success: EnvironmentSpeechTranscriptionResult,
        error: [deps.scopeRequired, deps.internal, deps.requestInvalid],
      })
        .middleware(deps.bodyLimit)
        .middleware(deps.auth),
    );
