import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as HostPower from "./HostPower.ts";
import { parseCanSuspend, stayAwakeCommand, suspendCommand } from "./powerCommands.ts";

interface Host {
  readonly ran: Array<string>;
  readonly relay: Array<string>;
  readonly suspended: Deferred.Deferred<void>;
  locked: boolean;
  canSuspend: string;
  /** A process keeping one core busy until this is false. */
  compiling: boolean;
}

/** The host's load as Linux would report it: idle, apart from `php` while `compiling`. */
const fakeLoad = (host: Host) => {
  let ticks = 0;
  let last: number | null = null;
  return Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
    if (last !== null && host.compiling) ticks += ((at - last) / 1000) * 100;
    last = at;
    return {
      at,
      cores: 24,
      cpuBusy: 0,
      cpuTotal: 0,
      networkBytes: 0,
      diskBytes: 0,
      processes: new Map([["4242:1", { name: "php", ticks }]]),
    };
  });
};

/** Answers like the Omarchy PC: its lock helper, logind and systemd-inhibit, with nothing run. */
const fakeSpawner = (host: Host) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const line =
        command._tag === "StandardCommand" ? [command.command, ...command.args].join(" ") : "";
      host.ran.push(line);
      if (line === "systemctl suspend") yield* Deferred.succeed(host.suspended, undefined);
      const holds = line.startsWith("systemd-inhibit");
      const stdout = holds
        ? "\n"
        : line.startsWith("busctl")
          ? `s "${host.canSuspend}"\n`
          : line.includes("LockedHint")
            ? "no\n"
            : "";
      // Omarchy's helper answers 0 locked, 1 unlocked.
      const exitCode = line.includes("omarchy-hyprland-session-locked") && !host.locked ? 1 : 0;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4242),
        stdout: stdout ? Stream.make(new TextEncoder().encode(stdout)) : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: holds ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(holds),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );

const fakeRelay = (host: Host) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      host.relay.push(new URL(request.url).pathname);
      return HttpClientResponse.fromWeb(request, new Response('{"ok":true}'));
    }),
  );

const hostPower = Effect.fn("test.hostPower")(function* (host: Host, active: Ref.Ref<boolean>) {
  const fs = yield* FileSystem.FileSystem;
  const tokens = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(`${tokens}/host`, "host-token\n");
  yield* fs.writeFileString(`${tokens}/client`, "client-token\n");
  return yield* HostPower.makeHostPower({
    filePath: `${tokens}/power.json`,
    environmentId: "env-omarchy",
    hasActiveRun: Ref.get(active),
    sampleLoad: fakeLoad(host),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner(host)),
    Effect.provideService(HttpClient.HttpClient, fakeRelay(host)),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            STOREFRONT_WAKE_RELAY_URL: "https://wake.test/",
            STOREFRONT_WAKE_RELAY_HOST_TOKEN_FILE: `${tokens}/host`,
            STOREFRONT_WAKE_RELAY_CLIENT_TOKEN_FILE: `${tokens}/client`,
          },
        }),
      ),
    ),
  );
});

const newHost = (): Host => ({
  ran: [],
  relay: [],
  suspended: Deferred.makeUnsafe<void>(),
  locked: false,
  canSuspend: "yes",
  compiling: false,
});
const suspended = (host: Host) => host.ran.filter((line) => line === "systemctl suspend").length;

it.effect("sleeps once the undo window passed, no run is active and the screen is locked", () =>
  Effect.gen(function* () {
    const host = newHost();
    const active = yield* Ref.make(true);
    const power = yield* hostPower(host, active);

    const armed = yield* power.setSleepWhenDone(true);
    expect(armed.sleepWhenDone.state).toBe("pending");
    expect(armed.relay).toEqual({ url: "https://wake.test", token: "client-token" });

    yield* TestClock.adjust("15 seconds");
    // The host must also have been quiet for five minutes, which it has not been measured for yet.
    expect((yield* power.status).waitingFor).toEqual(["activeRun", "screenUnlocked", "busy"]);
    expect((yield* power.status).busyWith).toBeNull();

    yield* Ref.set(active, false);
    host.locked = true;
    host.canSuspend = "inhibited";
    yield* TestClock.adjust("5 seconds");
    expect((yield* power.status).waitingFor).toEqual(["busy", "inhibitor"]);
    expect(suspended(host)).toBe(0);

    host.canSuspend = "yes";
    yield* TestClock.adjust("4 minutes");
    expect((yield* power.status).waitingFor).toEqual(["busy"]);
    expect(suspended(host)).toBe(0);
    yield* TestClock.adjust("1 minute");
    yield* Deferred.await(host.suspended);
    expect(suspended(host)).toBe(1);
    expect(host.relay).toContain("/v1/hosts/env-omarchy/sleeping");
    expect((yield* power.status).sleepWhenDone.state).toBe("off");

    yield* TestClock.adjust("30 seconds");
    expect(suspended(host)).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("waits for a busy process, says which, and sleeps five quiet minutes after it ends", () =>
  Effect.gen(function* () {
    const host = { ...newHost(), locked: true, compiling: true };
    const power = yield* hostPower(host, yield* Ref.make(false));
    yield* power.setSleepWhenDone(true);

    yield* TestClock.adjust("10 minutes");
    const busy = yield* power.status;
    expect(busy.waitingFor).toEqual(["busy"]);
    expect(busy.busyWith).toMatchObject({ kind: "process", name: "php" });
    expect(suspended(host)).toBe(0);

    host.compiling = false;
    yield* TestClock.adjust("4 minutes");
    expect(suspended(host)).toBe(0);
    yield* TestClock.adjust("2 minutes");
    yield* Deferred.await(host.suspended);
    expect(suspended(host)).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("an undo inside the window keeps the host awake", () =>
  Effect.gen(function* () {
    const host = { ...newHost(), locked: true };
    const power = yield* hostPower(host, yield* Ref.make(false));
    yield* power.setSleepWhenDone(true);
    yield* TestClock.adjust("6 seconds");
    expect((yield* power.setSleepWhenDone(false)).sleepWhenDone.state).toBe("off");
    yield* TestClock.adjust("30 seconds");
    expect(host.ran.some((line) => line.startsWith("busctl"))).toBe(false);
    expect(suspended(host)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("Stay awake holds an inhibitor and gives way to Sleep when done", () =>
  Effect.gen(function* () {
    const host = newHost();
    const power = yield* hostPower(host, yield* Ref.make(false));
    const awake = yield* power.setStayAwake(true);
    expect(awake.stayAwake).toBe(true);
    yield* TestClock.adjust("1 second");
    expect(host.ran.filter((line) => line.startsWith("systemd-inhibit"))).toHaveLength(1);

    const sleeping = yield* power.setSleepWhenDone(true);
    expect(sleeping.stayAwake).toBe(false);
    expect(sleeping.sleepWhenDone.state).toBe("pending");
    expect((yield* power.setStayAwake(true)).sleepWhenDone.state).toBe("off");

    yield* TestClock.adjust("25 seconds");
    expect(host.relay.filter((path) => path.endsWith("/heartbeat")).length).toBeGreaterThan(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("builds each platform's commands", () => {
  expect(stayAwakeCommand("linux", 7)?.args).toContain("--why=Stay awake is on");
  expect(stayAwakeCommand("darwin", 7)?.args.at(-1)).toBe("7");
  expect(stayAwakeCommand("win32", 7)).toBeUndefined();
  expect(suspendCommand("darwin")).toEqual({ command: "pmset", args: ["sleepnow"] });
  expect(parseCanSuspend('s "inhibited"\n')).toBe("inhibited");
  expect(parseCanSuspend("")).toBe("unknown");
});

it.effect("keeps its state in power.json across restarts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const make = HostPower.makeHostPower({
      filePath: `${dir}/storefront/power.json`,
      environmentId: "env",
      hasActiveRun: Effect.succeed(false),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner(newHost())),
      Effect.provideService(HttpClient.HttpClient, fakeRelay(newHost())),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    );
    yield* Effect.scoped((yield* Effect.scoped(make)).setStayAwake(true));
    const again = yield* make;
    expect((yield* again.status).stayAwake).toBe(true);
    expect((yield* again.status).relay).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
);
