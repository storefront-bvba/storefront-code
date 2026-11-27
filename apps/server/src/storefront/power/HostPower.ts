// Storefront Code (fork): Stay awake and Sleep when done for this host, and its heartbeat to our
// wake relay (fork/design/F8-sleep-and-wake.md). State lives in `<stateDir>/storefront/power.json`.
import {
  SLEEP_WHEN_DONE_UNDO_SECONDS,
  type StorefrontPowerStatus,
  type StorefrontPowerWaitingFor,
  type StorefrontWakeRelay,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { holdWhileWanted } from "../../background/KeepAwake.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  CAN_SUSPEND_COMMAND,
  LOGIND_LOCKED_COMMAND,
  MAC_SESSION_COMMAND,
  macScreenLocked,
  OMARCHY_LOCKED_COMMAND,
  parseCanSuspend,
  type PowerCommand,
  stayAwakeCommand,
  suspendCommand,
} from "./powerCommands.ts";

const UNDO_MS = SLEEP_WHEN_DONE_UNDO_SECONDS * 1000;
const CHECK_INTERVAL = "5 seconds";
const HEARTBEAT_INTERVAL = "20 seconds";
const STORE_RELATIVE_PATH = ["storefront", "power.json"] as const;

const PowerFile = Schema.Struct({
  version: Schema.Literal(1),
  stayAwake: Schema.Boolean,
  sleepWhenDoneArmedAt: Schema.NullOr(Schema.Number),
});
const decodePowerFile = Schema.decodeUnknownEffect(Schema.fromJsonString(PowerFile));
const encodePowerFile = Schema.encodeEffect(Schema.fromJsonString(PowerFile));

const RelayConfig = Config.all({
  url: Config.String("STOREFRONT_WAKE_RELAY_URL").pipe(Config.option),
  hostTokenFile: Config.String("STOREFRONT_WAKE_RELAY_HOST_TOKEN_FILE").pipe(Config.option),
  clientTokenFile: Config.String("STOREFRONT_WAKE_RELAY_CLIENT_TOKEN_FILE").pipe(Config.option),
});

export interface PowerState {
  readonly stayAwake: boolean;
  /** When Sleep when done was armed (epoch ms); it goes off once the host suspends. */
  readonly armedAt: number | null;
  readonly waitingFor: ReadonlyArray<StorefrontPowerWaitingFor>;
  readonly lastError: string | null;
}

const powerStatus = (
  state: PowerState,
  now: number,
  supported: boolean,
  relay: StorefrontWakeRelay | null,
): StorefrontPowerStatus => ({
  supported,
  stayAwake: state.stayAwake,
  sleepWhenDone:
    state.armedAt === null
      ? { state: "off", pendingUntil: null }
      : now < state.armedAt + UNDO_MS
        ? {
            state: "pending",
            pendingUntil: DateTime.formatIso(DateTime.makeUnsafe(state.armedAt + UNDO_MS)),
          }
        : { state: "armed", pendingUntil: null },
  waitingFor: state.armedAt === null ? [] : state.waitingFor,
  lastError: state.lastError,
  relay,
});

/** Stay awake and Sleep when done exclude each other: turning one on turns the other off. */
const withStayAwake = (state: PowerState, on: boolean): PowerState => ({
  ...state,
  stayAwake: on,
  armedAt: on ? null : state.armedAt,
  lastError: null,
});

const withSleepWhenDone = (state: PowerState, on: boolean, now: number): PowerState => ({
  stayAwake: on ? false : state.stayAwake,
  armedAt: on ? now : null,
  waitingFor: [],
  lastError: null,
});

export class HostPower extends Context.Service<
  HostPower,
  {
    readonly status: Effect.Effect<StorefrontPowerStatus>;
    readonly setStayAwake: (on: boolean) => Effect.Effect<StorefrontPowerStatus>;
    readonly setSleepWhenDone: (on: boolean) => Effect.Effect<StorefrontPowerStatus>;
  }
>()("t3/storefront/power/HostPower") {}

export const makeHostPower = Effect.fn("HostPower.make")(function* (input: {
  readonly filePath: string;
  readonly environmentId: string;
  readonly hasActiveRun: Effect.Effect<boolean>;
}) {
  const { filePath, environmentId, hasActiveRun } = input;
  const platform = yield* HostProcess.Platform;
  const supported = platform === "linux" || platform === "darwin";
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
  const relayConfig = yield* RelayConfig;
  const relayUrl = Option.map(relayConfig.url, (url) => url.trim().replace(/\/+$/, ""));

  const stored = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodePowerFile),
    Effect.orElseSucceed(() => null),
  );
  const ref = yield* SubscriptionRef.make<PowerState>({
    stayAwake: stored?.stayAwake ?? false,
    armedAt: stored?.sleepWhenDoneArmedAt ?? null,
    waitingFor: [],
    lastError: null,
  });
  const lock = yield* Semaphore.make(1);

  const persist = (state: PowerState) =>
    encodePowerFile({
      version: 1,
      stayAwake: state.stayAwake,
      sleepWhenDoneArmedAt: state.armedAt,
    }).pipe(
      Effect.flatMap((contents) =>
        fs
          .makeDirectory(path.dirname(filePath), { recursive: true, mode: 0o700 })
          .pipe(Effect.andThen(writeFileStringAtomically({ filePath, contents }))),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) => Effect.logWarning("power state not saved", { filePath, cause })),
    );

  const update = (transition: (state: PowerState) => PowerState) =>
    lock.withPermit(
      Effect.gen(function* () {
        const before = yield* SubscriptionRef.get(ref);
        const next = transition(before);
        if (next === before) return next;
        yield* SubscriptionRef.set(ref, next);
        if (next.stayAwake !== before.stayAwake || next.armedAt !== before.armedAt) {
          yield* persist(next);
        }
        return next;
      }),
    );

  const run = Effect.fn("HostPower.run")(
    function* (command: PowerCommand) {
      const child = yield* spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode: Number(exitCode), output: `${stdout}${stderr}`.trim() };
    },
    Effect.scoped,
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => ({ exitCode: -1, output: "" })),
  );

  // Read once: a new token takes a server restart.
  const readToken = (file: Option.Option<string>) =>
    Option.isNone(file)
      ? Effect.succeed(null)
      : fs.readFileString(file.value).pipe(
          Effect.map((contents) => contents.trim() || null),
          Effect.orElseSucceed(() => null),
        );
  const hostToken = yield* readToken(relayConfig.hostTokenFile);
  const clientToken = yield* readToken(relayConfig.clientTokenFile);
  const relay: StorefrontWakeRelay | null =
    Option.isSome(relayUrl) && clientToken !== null
      ? { url: relayUrl.value, token: clientToken }
      : null;

  const postRelay = Effect.fn("HostPower.postRelay")(function* (
    action: "heartbeat" | "sleeping",
    body: unknown,
  ) {
    if (Option.isNone(relayUrl) || hostToken === null) return;
    const request = HttpClientRequest.post(
      `${relayUrl.value}/v1/hosts/${encodeURIComponent(environmentId)}/${action}`,
    ).pipe(HttpClientRequest.bearerToken(hostToken), HttpClientRequest.bodyJsonUnsafe(body));
    yield* http.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.flatMap((response) =>
        response.status >= 300
          ? Effect.logDebug("wake relay refused", { action, status: response.status })
          : Effect.void,
      ),
      Effect.timeout("5 seconds"),
      // The request error carries the request, and with it the token.
      Effect.catchCause(() => Effect.logDebug("wake relay unreachable", { action })),
    );
  });

  const heartbeat = SubscriptionRef.get(ref).pipe(
    Effect.flatMap((state) =>
      postRelay("heartbeat", { stayAwake: state.stayAwake, sleepWhenDone: state.armedAt !== null }),
    ),
  );

  const screenLocked = Effect.gen(function* () {
    if (platform === "darwin") return macScreenLocked((yield* run(MAC_SESSION_COMMAND)).output);
    const omarchy = (yield* run(OMARCHY_LOCKED_COMMAND)).exitCode;
    if (omarchy === 0 || omarchy === 1) return omarchy === 0;
    return (yield* run(LOGIND_LOCKED_COMMAND)).output.trim() === "yes";
  });

  const suspend = suspendCommand(platform);

  const checkSleep = Effect.gen(function* () {
    const state = yield* SubscriptionRef.get(ref);
    const armedAt = state.armedAt;
    if (armedAt === null || suspend === undefined) return;
    if ((yield* Clock.currentTimeMillis) < armedAt + UNDO_MS) return;
    const waitingFor: Array<StorefrontPowerWaitingFor> = [];
    let lastError: string | null = null;
    if (yield* hasActiveRun) waitingFor.push("activeRun");
    if (!(yield* screenLocked)) waitingFor.push("screenUnlocked");
    if (platform === "linux") {
      const answer = parseCanSuspend((yield* run(CAN_SUSPEND_COMMAND)).output);
      if (answer === "inhibited") waitingFor.push("inhibitor");
      else if (answer !== "yes") lastError = `logind does not let this host suspend (${answer}).`;
    }
    if (waitingFor.length > 0 || lastError !== null) {
      yield* update((current) =>
        current.armedAt !== armedAt ||
        (current.lastError === lastError && current.waitingFor.join() === waitingFor.join())
          ? current
          : { ...current, waitingFor, lastError },
      );
      return;
    }
    yield* postRelay("sleeping", {});
    // One-shot: it is off before the host sleeps, so a resume does not suspend it again.
    yield* update((current) =>
      current.armedAt === armedAt ? { ...current, armedAt: null, waitingFor: [] } : current,
    );
    yield* Effect.logInfo("Storefront sleep when done: suspending this host");
    const result = yield* run(suspend);
    if (result.exitCode === 0) return;
    const inhibited = /inhibit/i.test(result.output);
    yield* update((current) =>
      current.armedAt !== null
        ? current
        : inhibited
          ? { ...current, armedAt, waitingFor: ["inhibitor"] }
          : {
              ...current,
              lastError: `Suspend failed: ${result.output || `exit ${result.exitCode}`}`,
            },
    );
    yield* heartbeat;
  });

  const stayAwake = stayAwakeCommand(platform, process.pid);
  if (stayAwake !== undefined) {
    const holdOnce = Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(stayAwake.command, stayAwake.args, {
          detached: false,
          shell: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }),
      );
      yield* child.stdout.pipe(
        Stream.take(1),
        Stream.runForEach(() => Effect.logInfo("Storefront stay awake: holding sleep off")),
        Effect.forkScoped,
      );
      yield* Effect.addFinalizer(() => Effect.logInfo("Storefront stay awake: released"));
      yield* child.exitCode;
    }).pipe(Effect.scoped);
    yield* forkParked(
      holdWhileWanted(
        SubscriptionRef.changes(ref).pipe(Stream.map((state) => state.stayAwake)),
        holdOnce.pipe(Effect.repeat(Schedule.spaced("10 seconds")), Effect.ignore),
        0,
      ),
    );
  }
  yield* forkParked(
    Effect.forever(
      Effect.sleep(CHECK_INTERVAL).pipe(
        Effect.andThen(checkSleep),
        Effect.catchCause((cause) => Effect.logWarning("sleep when done check failed", { cause })),
      ),
    ),
  );
  if (Option.isSome(relayUrl)) {
    yield* forkParked(
      Effect.forever(heartbeat.pipe(Effect.andThen(Effect.sleep(HEARTBEAT_INTERVAL)))),
    );
  }

  const status = Effect.gen(function* () {
    return powerStatus(
      yield* SubscriptionRef.get(ref),
      yield* Clock.currentTimeMillis,
      supported,
      relay,
    );
  });
  const after = (state: Effect.Effect<PowerState>) =>
    state.pipe(Effect.andThen(Effect.forkDetach(heartbeat)), Effect.andThen(status));

  return HostPower.of({
    status,
    setStayAwake: Effect.fn("HostPower.setStayAwake")(function* (on: boolean) {
      return yield* after(update((state) => withStayAwake(state, on)));
    }),
    setSleepWhenDone: Effect.fn("HostPower.setSleepWhenDone")(function* (on: boolean) {
      const now = yield* Clock.currentTimeMillis;
      return yield* after(update((state) => withSleepWhenDone(state, on, now)));
    }),
  });
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  return yield* makeHostPower({
    filePath: path.join((yield* ServerConfig.ServerConfig).stateDir, ...STORE_RELATIVE_PATH),
    environmentId: yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId,
    hasActiveRun: sql<{ readonly active: number }>`
      SELECT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs
        WHERE status IN ('preparing', 'starting', 'running')
      ) AS active
    `.pipe(
      Effect.map((rows) => rows[0]?.active === 1),
      // A failed read must not put the host to sleep under a working agent.
      Effect.orElseSucceed(() => true),
    ),
  });
});

export const layer = Layer.effect(HostPower, make).pipe(Layer.provide(FetchHttpClient.layer));
