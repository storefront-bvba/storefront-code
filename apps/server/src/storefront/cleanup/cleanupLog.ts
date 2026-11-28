/**
 * Storefront Code: a temporary record of what transcript cleanup changes, to judge whether step 2
 * of dictation earns its wait. With STOREFRONT_CLEANUP_LOG naming a file, each cleanup appends one
 * JSON line to it (mode 600). It never leaves this host; unset the variable and delete the file
 * once the review is done.
 */
import {
  type EnvironmentSpeechPostProcessingRequest,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);

const CleanupLogEntry = Schema.Struct({
  at: Schema.String,
  ms: Schema.Number,
  model: Schema.String,
  raw: Schema.String,
  cleaned: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  draft: Schema.String,
});
const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(CleanupLogEntry));

/** HubCleanup's own reason, such as "answered HTTP 429", else the first line of the cause. */
const failureReason = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  const inner = error instanceof Error ? error.cause : undefined;
  return isTextGenerationError(inner)
    ? inner.detail
    : (Cause.pretty(cause).split("\n", 1)[0] ?? "");
};

export const makeCleanupLog = Effect.gen(function* () {
  const file = (yield* Config.String("STOREFRONT_CLEANUP_LOG").pipe(Config.withDefault(""))).trim();
  const fs = yield* FileSystem.FileSystem;
  return <E, R>(
    model: string,
    input: EnvironmentSpeechPostProcessingRequest,
    cleanup: Effect.Effect<{ readonly text: string }, E, R>,
  ) =>
    !file || input.transcript.trim() === ""
      ? cleanup
      : Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);
          const started = yield* Clock.currentTimeMillis;
          return yield* cleanup.pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const entry = {
                  at,
                  ms: (yield* Clock.currentTimeMillis) - started,
                  model,
                  raw: input.transcript,
                  ...(Exit.isSuccess(exit)
                    ? { cleaned: exit.value.text }
                    : { error: failureReason(exit.cause) }),
                  draft: input.draft.text,
                };
                yield* encodeEntry(entry).pipe(
                  Effect.flatMap((line) =>
                    fs.writeFileString(file, `${line}\n`, { flag: "a", mode: 0o600 }),
                  ),
                  Effect.catch(() =>
                    Effect.logWarning(`The cleanup log ${file} can't be written.`),
                  ),
                );
              }),
            ),
          );
        });
});
