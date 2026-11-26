// Storefront Code (fork): APNs settings for host-sent push (fork/design/F5-host-push.md).
// They come from the service environment (`~/.t3/service.env`); push stays off without them.
// The key file is read at runtime only and never logged.
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const APNS_KEY_FILE_ENV = "STOREFRONT_APNS_KEY_FILE";
const APNS_KEY_ID_ENV = "STOREFRONT_APNS_KEY_ID";
const APNS_TEAM_ID_ENV = "STOREFRONT_APNS_TEAM_ID";
const APNS_TOPICS_ENV = "STOREFRONT_APNS_TOPICS";

export interface HostPushSettings {
  readonly keyFile: string;
  readonly keyId: string;
  readonly teamId: string;
  /** Bundle IDs the phone may register; each is an APNs topic of ours. */
  readonly topics: ReadonlyArray<string>;
}

export interface HostPushCredentials extends HostPushSettings {
  readonly privateKey: Redacted.Redacted<string>;
}

const APPLE_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

const optionalValue = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)?.trim() || undefined),
  );

export function parseTopics(value: string | undefined): ReadonlyArray<string> {
  if (value === undefined) return [];
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((topic) => topic.trim())
        .filter((topic) => BUNDLE_ID.test(topic)),
    ),
  ];
}

export const hostPushSettingsConfig: Config.Config<HostPushSettings | null> = Config.all({
  keyFile: optionalValue(APNS_KEY_FILE_ENV),
  keyId: optionalValue(APNS_KEY_ID_ENV),
  teamId: optionalValue(APNS_TEAM_ID_ENV),
  topics: optionalValue(APNS_TOPICS_ENV),
}).pipe(
  Config.map((values) => {
    const topics = parseTopics(values.topics);
    if (
      values.keyFile === undefined ||
      values.keyId === undefined ||
      values.teamId === undefined ||
      !APPLE_ID.test(values.keyId) ||
      !APPLE_ID.test(values.teamId) ||
      topics.length === 0
    ) {
      return null;
    }
    return { keyFile: values.keyFile, keyId: values.keyId, teamId: values.teamId, topics };
  }),
);

/** Null when any of the four variables is missing or malformed. */
export const readHostPushSettings: Effect.Effect<HostPushSettings | null> =
  hostPushSettingsConfig.pipe(Effect.orElseSucceed(() => null));

/** The descriptor flag the phone reads to start a Live Activity itself when you send. */
export const isHostPushConfigured: Effect.Effect<boolean> = readHostPushSettings.pipe(
  Effect.map((settings) => settings !== null),
);

export class HostPushKeyError extends Schema.TaggedError<HostPushKeyError>()("HostPushKeyError", {
  keyFile: Schema.String,
  reason: Schema.Literals(["unreadable", "not-a-private-key"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "unreadable"
      ? `The APNs key file ${this.keyFile} cannot be read.`
      : `The APNs key file ${this.keyFile} does not hold a PEM private key.`;
  }
}

export const loadHostPushCredentials = Effect.fn("storefront.push.loadCredentials")(function* (
  settings: HostPushSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  const pem = yield* fs
    .readFileString(settings.keyFile)
    .pipe(
      Effect.mapError(
        (cause) => new HostPushKeyError({ keyFile: settings.keyFile, reason: "unreadable", cause }),
      ),
    );
  if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(pem)) {
    return yield* new HostPushKeyError({ keyFile: settings.keyFile, reason: "not-a-private-key" });
  }
  const mode = yield* fs.stat(settings.keyFile).pipe(
    Effect.map((info) => info.mode & 0o777),
    Effect.orElseSucceed(() => 0o600),
  );
  if ((mode & 0o077) !== 0) {
    yield* Effect.logWarning("APNs key file is readable by other users; use mode 600", {
      keyFile: settings.keyFile,
    });
  }
  return { ...settings, privateKey: Redacted.make(pem.trim()) } satisfies HostPushCredentials;
});
