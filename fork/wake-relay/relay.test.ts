import * as NodeAssert from "node:assert/strict";
import * as NodeDgram from "node:dgram";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import {
  AWAKE_FOR_MS,
  WAKING_FOR_MS,
  createListener,
  createRelay,
  createUdpSender,
  deriveState,
  findToken,
  loadState,
  magicPacket,
  parseConfig,
  saveState,
  sha256Hex,
  type HostRecord,
  type RelayConfig,
} from "./relay.ts";

const { describe, it } = NodeTest;
const START = Date.parse("2026-11-27T10:00:00.000Z");
const CLIENT = "client-token";
const OMARCHY = "omarchy-host-token";
const MACBOOK = "macbook-host-token";
const ORIGIN = "https://omarchy.example.ts.net";

const config: RelayConfig = parseConfig(
  JSON.stringify({
    corsOrigins: [ORIGIN],
    tokens: [
      { sha256: sha256Hex(CLIENT), role: "client", name: "iPhone" },
      { sha256: sha256Hex(OMARCHY), role: "host", hostId: "env-omarchy" },
      { sha256: sha256Hex(MACBOOK), role: "host", hostId: "env-macbook" },
    ],
    hosts: [
      {
        id: "env-omarchy",
        name: "Omarchy",
        mac: "02:00:00:aa:bb:cc",
        broadcast: "192.168.0.255",
        wake: "magic-packet",
      },
      { id: "env-macbook", name: "MacBook", wake: "none", wakeNote: "Needs a sleep proxy" },
    ],
  }),
);

const record = (fields: Partial<HostRecord> = {}): HostRecord => ({
  lastSeenAt: null,
  sleptAt: null,
  wakeRequestedAt: null,
  stayAwake: false,
  sleepWhenDone: false,
  ...fields,
});

function setup() {
  const clock = { now: START };
  const state = new Map<string, HostRecord>();
  const sent: Array<{ packet: Buffer; address: string }> = [];
  const logs: string[] = [];
  let changes = 0;
  const relay = createRelay({
    config: () => config,
    state,
    now: () => clock.now,
    sendPacket: async (packet, address) => {
      sent.push({ packet, address });
    },
    onChange: () => {
      changes += 1;
    },
    log: (line) => logs.push(line),
  });
  const call = async (
    method: string,
    url: string,
    { token, body, origin }: { token?: string; body?: unknown; origin?: string } = {},
  ) => {
    const headers: NodeHttp.IncomingHttpHeaders = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (origin) headers.origin = origin;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await relay({
      method,
      url,
      headers,
      body: body === undefined ? "" : JSON.stringify(body),
    });
    const json: unknown = response.headers["content-type"]?.startsWith("application/json")
      ? JSON.parse(response.body)
      : response.body;
    return { ...response, json };
  };
  const hostState = async (id: string) => {
    const { json } = await call("GET", "/v1/hosts", { token: CLIENT });
    return (json as { hosts: Array<{ id: string; state: string }> }).hosts.find(
      (host) => host.id === id,
    )?.state;
  };
  return { clock, state, sent, logs, call, hostState, changes: () => changes };
}

const heartbeat = { stayAwake: false, sleepWhenDone: true };

describe("deriveState", () => {
  it("is unknown for a host never seen", () => {
    NodeAssert.equal(deriveState(record(), START), "unknown");
  });

  it("is awake under 70 s after a heartbeat, unreachable after", () => {
    const seen = record({ lastSeenAt: START });
    NodeAssert.equal(deriveState(seen, START + AWAKE_FOR_MS - 1), "awake");
    NodeAssert.equal(deriveState(seen, START + AWAKE_FOR_MS), "unreachable");
  });

  it("is asleep once the host said sleeping, even right after its last heartbeat", () => {
    const slept = record({ lastSeenAt: START, sleptAt: START + 1000 });
    NodeAssert.equal(deriveState(slept, START + 2000), "asleep");
    NodeAssert.equal(deriveState(slept, START + 3_600_000), "asleep");
  });

  it("is waking for 3 minutes after a wake request, then falls back", () => {
    const woken = record({
      lastSeenAt: START,
      sleptAt: START + 1000,
      wakeRequestedAt: START + 5000,
    });
    NodeAssert.equal(deriveState(woken, START + 5000 + WAKING_FOR_MS - 1), "waking");
    NodeAssert.equal(deriveState(woken, START + 5000 + WAKING_FOR_MS), "asleep");
    const neverSeen = record({ wakeRequestedAt: START });
    NodeAssert.equal(deriveState(neverSeen, START + 1), "waking");
    NodeAssert.equal(deriveState(neverSeen, START + WAKING_FOR_MS), "unknown");
  });

  it("is awake again after a heartbeat that follows the sleep notice", () => {
    const resumed = record({
      lastSeenAt: START + 9000,
      sleptAt: START,
      wakeRequestedAt: START + 10,
    });
    NodeAssert.equal(deriveState(resumed, START + 9000), "awake");
  });
});

describe("magicPacket", () => {
  it("is 6 × FF and then the MAC 16 times", () => {
    const packet = magicPacket("A8:A1:59:01:02:03");
    NodeAssert.equal(packet.length, 102);
    NodeAssert.deepEqual([...packet.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
    const mac = [0xa8, 0xa1, 0x59, 0x01, 0x02, 0x03];
    for (let copy = 0; copy < 16; copy += 1) {
      NodeAssert.deepEqual([...packet.subarray(6 + copy * 6, 12 + copy * 6)], mac);
    }
    NodeAssert.deepEqual(magicPacket("a8-a1-59-01-02-03"), packet);
  });

  it("refuses what is not a MAC address", () => {
    NodeAssert.throws(() => magicPacket("a8:a1:59:01:02"), /not a MAC address/);
  });
});

describe("tokens", () => {
  it("matches a bearer token by its SHA-256 only", () => {
    NodeAssert.equal(findToken(config.tokens, `Bearer ${CLIENT}`)?.role, "client");
    NodeAssert.equal(findToken(config.tokens, `bearer ${OMARCHY}`)?.role, "host");
    NodeAssert.equal(findToken(config.tokens, `Bearer ${sha256Hex(CLIENT)}`), null);
    NodeAssert.equal(findToken(config.tokens, CLIENT), null);
    NodeAssert.equal(findToken(config.tokens, undefined), null);
  });

  it("rejects a host token bound to a host that is not listed", () => {
    const text = JSON.stringify({
      tokens: [{ sha256: sha256Hex("x"), role: "host", hostId: "nope" }],
      hosts: [],
    });
    NodeAssert.throws(() => parseConfig(text), /hostId of a listed host/);
  });
});

describe("API", () => {
  it("answers healthz without a token and refuses the API without a valid one", async () => {
    const { call } = setup();
    const health = await call("GET", "/healthz");
    NodeAssert.deepEqual([health.status, health.body], [200, "ok"]);
    NodeAssert.equal((await call("GET", "/v1/hosts")).status, 401);
    NodeAssert.equal((await call("GET", "/v1/hosts", { token: "wrong" })).status, 401);
    NodeAssert.equal((await call("POST", "/v1/hosts/env-omarchy/wake")).status, 401);
  });

  it("lets a host token report only for its own host, and only a client wake", async () => {
    const { call } = setup();
    const other = await call("POST", "/v1/hosts/env-omarchy/heartbeat", {
      token: MACBOOK,
      body: heartbeat,
    });
    NodeAssert.deepEqual([other.status, other.json], [403, { error: "forbidden" }]);
    const client = await call("POST", "/v1/hosts/env-omarchy/sleeping", { token: CLIENT });
    NodeAssert.equal(client.status, 403);
    const hostWake = await call("POST", "/v1/hosts/env-omarchy/wake", { token: OMARCHY });
    NodeAssert.equal(hostWake.status, 403);
    NodeAssert.equal((await call("GET", "/v1/hosts", { token: OMARCHY })).status, 200);
  });

  it("lists every host with its state", async () => {
    const { call, clock } = setup();
    await call("POST", "/v1/hosts/env-omarchy/heartbeat", { token: OMARCHY, body: heartbeat });
    clock.now += 5000;
    const { status, json } = await call("GET", "/v1/hosts", { token: CLIENT });
    NodeAssert.equal(status, 200);
    NodeAssert.deepEqual(json, {
      now: "2026-11-27T10:00:05.000Z",
      hosts: [
        {
          id: "env-omarchy",
          name: "Omarchy",
          state: "awake",
          canWake: true,
          wakeNote: null,
          lastSeenAt: "2026-11-27T10:00:00.000Z",
          sleptAt: null,
          wakeRequestedAt: null,
          stayAwake: false,
          sleepWhenDone: true,
        },
        {
          id: "env-macbook",
          name: "MacBook",
          state: "unknown",
          canWake: false,
          wakeNote: "Needs a sleep proxy",
          lastSeenAt: null,
          sleptAt: null,
          wakeRequestedAt: null,
          stayAwake: false,
          sleepWhenDone: false,
        },
      ],
    });
  });

  it("walks a host through sleep, wake and resume", async () => {
    const { call, clock, hostState, sent, logs } = setup();
    await call("POST", "/v1/hosts/env-omarchy/heartbeat", { token: OMARCHY, body: heartbeat });
    NodeAssert.equal(await hostState("env-omarchy"), "awake");

    clock.now += 1000;
    const sleeping = await call("POST", "/v1/hosts/env-omarchy/sleeping", { token: OMARCHY });
    NodeAssert.deepEqual([sleeping.status, sleeping.json], [200, { ok: true }]);
    NodeAssert.equal(await hostState("env-omarchy"), "asleep");

    clock.now += 60_000;
    const wake = await call("POST", "/v1/hosts/env-omarchy/wake", { token: CLIENT });
    NodeAssert.equal(wake.status, 202);
    NodeAssert.equal((wake.json as { host: { state: string } }).host.state, "waking");
    NodeAssert.deepEqual(sent, [
      { packet: magicPacket("02:00:00:aa:bb:cc"), address: "192.168.0.255" },
    ]);

    clock.now += 20_000;
    await call("POST", "/v1/hosts/env-omarchy/heartbeat", { token: OMARCHY, body: heartbeat });
    NodeAssert.equal(await hostState("env-omarchy"), "awake");

    clock.now += AWAKE_FOR_MS;
    NodeAssert.equal(await hostState("env-omarchy"), "unreachable");
    NodeAssert.deepEqual(logs, [
      "awake Omarchy (env-omarchy), was unknown",
      "sleeping Omarchy (env-omarchy)",
      "wake Omarchy (env-omarchy): magic packet sent to 192.168.0.255",
      "awake Omarchy (env-omarchy), was waking",
    ]);
  });

  it("refuses to wake a host without a wake method, and an unknown host", async () => {
    const { call, sent } = setup();
    const macbook = await call("POST", "/v1/hosts/env-macbook/wake", { token: CLIENT });
    NodeAssert.deepEqual([macbook.status, macbook.json], [409, { error: "cannot_wake" }]);
    const unknown = await call("POST", "/v1/hosts/env-nope/wake", { token: CLIENT });
    NodeAssert.deepEqual([unknown.status, unknown.json], [404, { error: "unknown_host" }]);
    NodeAssert.equal(sent.length, 0);
  });

  it("takes only a JSON heartbeat with both booleans", async () => {
    const { call, changes } = setup();
    const partial = await call("POST", "/v1/hosts/env-omarchy/heartbeat", {
      token: OMARCHY,
      body: { stayAwake: true },
    });
    NodeAssert.deepEqual([partial.status, partial.json], [400, { error: "invalid_heartbeat" }]);
    const empty = await call("POST", "/v1/hosts/env-omarchy/heartbeat", { token: OMARCHY });
    NodeAssert.equal(empty.status, 400);
    NodeAssert.equal(changes(), 0);
  });

  it("answers CORS preflight only for a configured origin", async () => {
    const { call } = setup();
    const allowed = await call("OPTIONS", "/v1/hosts", { origin: ORIGIN });
    NodeAssert.equal(allowed.status, 204);
    NodeAssert.equal(allowed.headers["access-control-allow-origin"], ORIGIN);
    NodeAssert.equal(allowed.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
    NodeAssert.equal(
      allowed.headers["access-control-allow-headers"],
      "authorization, content-type",
    );
    NodeAssert.equal(allowed.headers["access-control-max-age"], "600");

    const other = await call("OPTIONS", "/v1/hosts", { origin: "https://evil.example" });
    NodeAssert.equal(other.status, 204);
    NodeAssert.equal(other.headers["access-control-allow-origin"], undefined);
    NodeAssert.equal(other.headers["access-control-allow-methods"], undefined);

    const listed = await call("GET", "/v1/hosts", { token: CLIENT, origin: ORIGIN });
    NodeAssert.equal(listed.headers["access-control-allow-origin"], ORIGIN);
  });
});

describe("state file", () => {
  it("round-trips through a temporary file and drops hosts no longer configured", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wake-relay-"));
    try {
      const path = NodePath.join(directory, "data", "state.json");
      NodeAssert.deepEqual(loadState(path), new Map());
      const state = new Map([
        ["env-omarchy", record({ lastSeenAt: START, sleptAt: START + 1000, sleepWhenDone: true })],
        ["env-gone", record({ lastSeenAt: START })],
      ]);
      saveState(path, state, new Set(["env-omarchy", "env-macbook"]));
      NodeAssert.deepEqual(loadState(path), new Map([["env-omarchy", state.get("env-omarchy")]]));
      NodeAssert.deepEqual(NodeFS.readdirSync(NodePath.dirname(path)), ["state.json"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("server", () => {
  it("serves the API over HTTP and refuses an oversized body", async () => {
    const { state } = setup();
    const relay = createRelay({
      config: () => config,
      state,
      now: () => START,
      sendPacket: async () => {},
      onChange: () => {},
      log: () => {},
    });
    const server = NodeHttp.createServer(createListener(relay, () => {}));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    try {
      const health = await fetch(`${base}/healthz`);
      NodeAssert.deepEqual([health.status, await health.text()], [200, "ok"]);

      const beat = await fetch(`${base}/v1/hosts/env-omarchy/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${OMARCHY}`, "content-type": "application/json" },
        body: JSON.stringify(heartbeat),
      });
      NodeAssert.deepEqual([beat.status, await beat.json()], [200, { ok: true }]);

      const big = await fetch(`${base}/v1/hosts/env-omarchy/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${OMARCHY}`, "content-type": "application/json" },
        body: JSON.stringify({ ...heartbeat, padding: "x".repeat(20_000) }),
      });
      NodeAssert.equal(big.status, 413);

      const text = await fetch(`${base}/v1/hosts/env-omarchy/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${OMARCHY}`, "content-type": "text/plain" },
        body: "hello",
      });
      NodeAssert.equal(text.status, 415);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("sends the magic packet three times over UDP", async () => {
    const receiver = NodeDgram.createSocket("udp4");
    await new Promise<void>((resolve) => receiver.bind(0, "127.0.0.1", resolve));
    const received: Buffer[] = [];
    const allThree = new Promise<void>((resolve) => {
      receiver.on("message", (message) => {
        received.push(message);
        if (received.length === 3) resolve();
      });
    });
    try {
      const send = createUdpSender({ port: receiver.address().port, gapMs: 0 });
      const packet = magicPacket("02:00:00:aa:bb:cc");
      await send(packet, "127.0.0.1");
      await allThree;
      NodeAssert.deepEqual(received, [packet, packet, packet]);
    } finally {
      receiver.close();
    }
  });
});
