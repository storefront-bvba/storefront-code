// Storefront Code (fork): follows logind's PrepareForSleep, so this host tells its devices it goes
// to sleep however the suspend started (a menu, hypridle, a key), and that it woke up. A delay
// lock makes logind wait for that message; it is released once the message is out.
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { holdWhileWanted } from "../../background/KeepAwake.ts";
import {
  parsePrepareForSleep,
  type PowerCommand,
  SLEEP_SIGNALS_COMMAND,
  sleepDelayCommand,
} from "./powerCommands.ts";

// Stock logind waits at most 5 seconds for delay locks (InhibitDelayMaxSec).
const ANNOUNCE_TIMEOUT = "4 seconds";
const RESTART_AFTER = "30 seconds";

export const watchSleepSignals = Effect.fn("HostPower.watchSleepSignals")(function* (input: {
  readonly onSleep: Effect.Effect<void>;
  readonly onWake: Effect.Effect<void>;
  readonly serverPid: number;
  readonly signals?: PowerCommand;
  readonly delay?: PowerCommand;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Runs a command again whenever it exits (or cannot start), half a minute later.
  const runUntilExit = Effect.fn("HostPower.runUntilExit")(
    function* (command: PowerCommand, onLine?: (line: string) => Effect.Effect<void>) {
      const child = yield* spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          stdin: "ignore",
          stdout: onLine ? "pipe" : "ignore",
          stderr: "ignore",
        }),
      );
      if (onLine) {
        yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(onLine));
      }
      yield* child.exitCode;
    },
    (effect) =>
      effect.pipe(
        Effect.scoped,
        Effect.ignore,
        Effect.andThen(Effect.sleep(RESTART_AFTER)),
        Effect.forever,
      ),
  );

  const awake = yield* SubscriptionRef.make(true);
  const delay = input.delay ?? sleepDelayCommand(input.serverPid);
  // `changes` starts with the next change; the lock is wanted from the start.
  const wanted = Stream.concat(Stream.make(true), SubscriptionRef.changes(awake));
  yield* Effect.forkChild(holdWhileWanted(wanted, runUntilExit(delay), 0));

  const onLine = (line: string) => {
    const sleeping = parsePrepareForSleep(line);
    if (sleeping === null) return Effect.void;
    return sleeping
      ? input.onSleep.pipe(
          Effect.timeout(ANNOUNCE_TIMEOUT),
          Effect.ignore,
          Effect.andThen(SubscriptionRef.set(awake, false)),
        )
      : SubscriptionRef.set(awake, true).pipe(
          Effect.andThen(Effect.forkDetach(input.onWake)),
          Effect.asVoid,
        );
  };
  return yield* runUntilExit(input.signals ?? SLEEP_SIGNALS_COMMAND, onLine);
}, Effect.scoped);
