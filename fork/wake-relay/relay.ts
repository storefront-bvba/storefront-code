// Storefront Wake: knows which Storefront Code hosts are awake and wakes them with a magic packet.
// Spec: fork/design/F8-sleep-and-wake.md ("Relay"). No dependencies: Node 26 runs this file as is.
import * as NodeCrypto from "node:crypto";
import * as NodeDgram from "node:dgram";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

export const AWAKE_FOR_MS = 70_000;
export const WAKING_FOR_MS = 180_000;
export const BODY_LIMIT = 16 * 1024;

export type Token =
  | { sha256: string; role: "client"; name?: string }
  | { sha256: string; role: "host"; hostId: string };
export type Host = {
  id: string;
  name: string;
  wake: "magic-packet" | "none";
  mac?: string;
  broadcast?: string;
  wakeNote?: string;
};
export type RelayConfig = { corsOrigins: string[]; tokens: Token[]; hosts: Host[] };
export type HostRecord = {
  lastSeenAt: number | null;
  sleptAt: number | null;
  wakeRequestedAt: number | null;
  stayAwake: boolean;
  sleepWhenDone: boolean;
};
export type HostState = "awake" | "waking" | "asleep" | "unreachable" | "unknown";
export type SendPacket = (packet: Buffer, address: string) => Promise<void>;
export type RelayRequest = {
  method: string;
  url: string;
  headers: NodeHttp.IncomingHttpHeaders;
  body: string;
};
export type RelayResponse = { status: number; headers: Record<string, string>; body: string };
export type Relay = (request: RelayRequest) => Promise<RelayResponse>;

const emptyRecord = (): HostRecord => ({
  lastSeenAt: null,
  sleptAt: null,
  wakeRequestedAt: null,
  stayAwake: false,
  sleepWhenDone: false,
});

// A host says "sleeping" and then stops its heartbeats, so a fresh heartbeat older than the
// sleep notice does not make it awake.
export function deriveState(record: HostRecord, now: number): HostState {
  const { lastSeenAt, sleptAt, wakeRequestedAt } = record;
  const sleptSinceSeen = sleptAt !== null && (lastSeenAt === null || sleptAt >= lastSeenAt);
  if (lastSeenAt !== null && now - lastSeenAt < AWAKE_FOR_MS && !sleptSinceSeen) return "awake";
  if (
    wakeRequestedAt !== null &&
    (lastSeenAt === null || wakeRequestedAt > lastSeenAt) &&
    now - wakeRequestedAt < WAKING_FOR_MS
  ) {
    return "waking";
  }
  if (sleptSinceSeen) return "asleep";
  return lastSeenAt === null ? "unknown" : "unreachable";
}

export function magicPacket(mac: string): Buffer {
  const hex = mac.replaceAll(/[:-]/g, "");
  if (!/^[\da-f]{12}$/i.test(hex)) throw new Error(`not a MAC address: ${mac}`);
  const address = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => address)]);
}

export const sha256Hex = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

export function findToken(tokens: Token[], authorization: string | undefined): Token | null {
  const presented = /^Bearer +(\S+)$/i.exec(authorization ?? "")?.[1];
  if (presented === undefined) return null;
  const digest = NodeCrypto.createHash("sha256").update(presented).digest();
  let match: Token | null = null;
  for (const token of tokens) {
    const expected = Buffer.from(token.sha256, "hex");
    const equal = expected.length === digest.length && NodeCrypto.timingSafeEqual(expected, digest);
    if (equal && match === null) match = token;
  }
  return match;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

export function parseConfig(text: string): RelayConfig {
  const fail = (message: string): never => {
    throw new Error(`relay.json: ${message}`);
  };
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw)) return fail("not a JSON object");
  const { corsOrigins = [], tokens, hosts } = raw;
  if (!Array.isArray(corsOrigins) || !corsOrigins.every(isText)) {
    return fail("corsOrigins must be a list of origins");
  }
  if (!Array.isArray(hosts) || !Array.isArray(tokens)) return fail("hosts and tokens are lists");
  const parsedHosts = hosts.map((host: unknown, index): Host => {
    if (!isObject(host) || !isText(host.id)) return fail(`hosts[${index}] needs an id`);
    const { id, name = id, wake, mac, broadcast, wakeNote } = host;
    if (!isText(name) || (wakeNote !== undefined && !isText(wakeNote))) {
      return fail(`host ${id}: name and wakeNote are text`);
    }
    if (wake === "none") return { id, name, wake, wakeNote };
    if (wake !== "magic-packet") return fail(`host ${id}: wake is "magic-packet" or "none"`);
    if (!isText(mac) || !isText(broadcast)) return fail(`host ${id}: needs mac and broadcast`);
    magicPacket(mac);
    return { id, name, wake, mac, broadcast, wakeNote };
  });
  const hostIds = new Set(parsedHosts.map((host) => host.id));
  if (hostIds.size !== parsedHosts.length) fail("host ids must be unique");
  const parsedTokens = tokens.map((token: unknown, index): Token => {
    if (
      !isObject(token) ||
      typeof token.sha256 !== "string" ||
      !/^[\da-f]{64}$/i.test(token.sha256)
    ) {
      return fail(`tokens[${index}]: sha256 must be 64 hex characters`);
    }
    const sha256 = token.sha256.toLowerCase();
    if (token.role === "client") {
      return { sha256, role: "client", name: isText(token.name) ? token.name : undefined };
    }
    if (token.role === "host" && isText(token.hostId) && hostIds.has(token.hostId)) {
      return { sha256, role: "host", hostId: token.hostId };
    }
    return fail(`tokens[${index}]: role is "client", or "host" with the hostId of a listed host`);
  });
  return { corsOrigins, tokens: parsedTokens, hosts: parsedHosts };
}

const decodePathPart = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};
const toIso = (time: number | null) => (time === null ? null : new Date(time).toISOString());
const fromIso = (value: unknown) => {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? null : time;
};

export function loadState(path: string): Map<string, HostRecord> {
  let text: string;
  try {
    text = NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const raw: unknown = JSON.parse(text);
  const hosts = isObject(raw) && isObject(raw.hosts) ? raw.hosts : {};
  const state = new Map<string, HostRecord>();
  for (const [id, record] of Object.entries(hosts)) {
    if (!isObject(record)) continue;
    state.set(id, {
      lastSeenAt: fromIso(record.lastSeenAt),
      sleptAt: fromIso(record.sleptAt),
      wakeRequestedAt: fromIso(record.wakeRequestedAt),
      stayAwake: record.stayAwake === true,
      sleepWhenDone: record.sleepWhenDone === true,
    });
  }
  return state;
}

export function saveState(path: string, state: Map<string, HostRecord>, hostIds: Set<string>) {
  const hosts: Record<string, unknown> = {};
  for (const [id, record] of state) {
    if (!hostIds.has(id)) continue;
    hosts[id] = {
      ...record,
      lastSeenAt: toIso(record.lastSeenAt),
      sleptAt: toIso(record.sleptAt),
      wakeRequestedAt: toIso(record.wakeRequestedAt),
    };
  }
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify({ hosts }, null, 2)}\n`);
  NodeFS.renameSync(temporary, path);
}

export function createRelay(deps: {
  config: () => RelayConfig;
  state: Map<string, HostRecord>;
  now: () => number;
  sendPacket: SendPacket;
  onChange: () => void;
  log: (line: string) => void;
}): Relay {
  const recordOf = (id: string) => {
    const existing = deps.state.get(id);
    if (existing) return existing;
    const created = emptyRecord();
    deps.state.set(id, created);
    return created;
  };
  const view = (host: Host, now: number) => {
    const record = deps.state.get(host.id) ?? emptyRecord();
    return {
      id: host.id,
      name: host.name,
      state: deriveState(record, now),
      canWake: host.wake === "magic-packet",
      wakeNote: host.wakeNote ?? null,
      lastSeenAt: toIso(record.lastSeenAt),
      sleptAt: toIso(record.sleptAt),
      wakeRequestedAt: toIso(record.wakeRequestedAt),
      stayAwake: record.stayAwake,
      sleepWhenDone: record.sleepWhenDone,
    };
  };

  return async (request) => {
    const config = deps.config();
    const origin = request.headers.origin;
    const cors: Record<string, string> =
      typeof origin === "string" && config.corsOrigins.includes(origin)
        ? { "access-control-allow-origin": origin }
        : {};
    const headers = { ...cors, vary: "Origin", "cache-control": "no-store" };
    const json = (status: number, body: unknown): RelayResponse => ({
      status,
      headers: { ...headers, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });

    const { pathname } = new URL(request.url, "http://relay");
    if (request.method === "OPTIONS") {
      const preflight: Record<string, string> = cors["access-control-allow-origin"]
        ? {
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-max-age": "600",
          }
        : {};
      return { status: 204, headers: { ...headers, ...preflight }, body: "" };
    }
    if (request.method === "GET" && pathname === "/healthz") {
      return { status: 200, headers: { ...headers, "content-type": "text/plain" }, body: "ok" };
    }
    const listing = request.method === "GET" && pathname === "/v1/hosts";
    const action =
      request.method === "POST"
        ? /^\/v1\/hosts\/([^/]+)\/(wake|heartbeat|sleeping)$/.exec(pathname)
        : null;
    if (!listing && !action) return json(404, { error: "not_found" });

    const token = findToken(config.tokens, request.headers.authorization);
    if (!token) return json(401, { error: "unauthorized" });
    const now = deps.now();
    if (!action) {
      return json(200, {
        now: new Date(now).toISOString(),
        hosts: config.hosts.map((host) => view(host, now)),
      });
    }

    const [, encodedId = "", verb] = action;
    const id = decodePathPart(encodedId);
    if (id === null) return json(404, { error: "unknown_host" });
    const allowed =
      verb === "wake" ? token.role === "client" : token.role === "host" && token.hostId === id;
    if (!allowed) return json(403, { error: "forbidden" });
    const host = config.hosts.find((candidate) => candidate.id === id);
    if (!host) return json(404, { error: "unknown_host" });

    let body: unknown = {};
    if (request.body.trim() !== "") {
      if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) {
        return json(415, { error: "json_only" });
      }
      try {
        body = JSON.parse(request.body);
      } catch {
        return json(400, { error: "invalid_json" });
      }
    }

    const label = `${host.name} (${host.id})`;
    if (verb === "wake") {
      if (host.wake !== "magic-packet" || !host.mac || !host.broadcast) {
        return json(409, { error: "cannot_wake" });
      }
      try {
        await deps.sendPacket(magicPacket(host.mac), host.broadcast);
      } catch (error) {
        deps.log(`wake ${label}: sending to ${host.broadcast} failed: ${String(error)}`);
        return json(502, { error: "send_failed" });
      }
      const sentAt = deps.now();
      recordOf(host.id).wakeRequestedAt = sentAt;
      deps.onChange();
      deps.log(`wake ${label}: magic packet sent to ${host.broadcast}`);
      return json(202, { host: view(host, sentAt) });
    }

    const record = recordOf(host.id);
    if (verb === "sleeping") {
      record.sleptAt = now;
      deps.onChange();
      deps.log(`sleeping ${label}`);
      return json(200, { ok: true });
    }
    if (
      !isObject(body) ||
      typeof body.stayAwake !== "boolean" ||
      typeof body.sleepWhenDone !== "boolean"
    ) {
      return json(400, { error: "invalid_heartbeat" });
    }
    const before = deriveState(record, now);
    record.lastSeenAt = now;
    record.stayAwake = body.stayAwake;
    record.sleepWhenDone = body.sleepWhenDone;
    deps.onChange();
    if (before !== "awake") deps.log(`awake ${label}, was ${before}`);
    return json(200, { ok: true });
  };
}

// Reads the body up to BODY_LIMIT; a larger one is drained and answered with 413.
export function createListener(
  relay: Relay,
  log: (line: string) => void,
): NodeHttp.RequestListener {
  return (req, res) => {
    req.once("error", () => res.destroy());
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.on("end", () => {
      const respond = ({ status, headers, body }: RelayResponse) => {
        res.writeHead(status, headers);
        res.end(body);
      };
      if (size > BODY_LIMIT) {
        respond({
          status: 413,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ error: "too_large" }),
        });
        return;
      }
      relay({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }).then(respond, (error: unknown) => {
        log(`${req.method} ${req.url} failed: ${String(error)}`);
        respond({ status: 500, headers: {}, body: "" });
      });
    });
  };
}

export function createUdpSender({ port = 9, times = 3, gapMs = 300 } = {}): SendPacket {
  return async (packet, address) => {
    const socket = NodeDgram.createSocket("udp4");
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(() => resolve());
      });
      socket.setBroadcast(true);
      for (let attempt = 0; attempt < times; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
        await new Promise<void>((resolve, reject) => {
          socket.send(packet, port, address, (error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      socket.close();
    }
  };
}

if (import.meta.main) {
  const listen = process.env.RELAY_LISTEN ?? "127.0.0.1:8790";
  const configPath = process.env.RELAY_CONFIG ?? "/config/relay.json";
  const statePath = process.env.RELAY_STATE ?? "/data/state.json";
  const log = (line: string) => console.log(line);
  const readConfig = () => parseConfig(NodeFS.readFileSync(configPath, "utf8"));

  let config = readConfig();
  let state: Map<string, HostRecord>;
  try {
    state = loadState(statePath);
  } catch (error) {
    log(`cannot read ${statePath} (${String(error)}), starting without state`);
    state = new Map();
  }
  const relay = createRelay({
    config: () => config,
    state,
    now: Date.now,
    sendPacket: createUdpSender(),
    onChange: () => {
      try {
        saveState(statePath, state, new Set(config.hosts.map((host) => host.id)));
      } catch (error) {
        log(`cannot save ${statePath}: ${String(error)}`);
      }
    },
    log,
  });

  const server = NodeHttp.createServer(createListener(relay, log));
  server.requestTimeout = 10_000;
  const separator = listen.lastIndexOf(":");
  const address = listen.slice(0, separator).replace(/^\[(.*)\]$/, "$1");
  server.listen(Number(listen.slice(separator + 1)), address, () => {
    log(`listening on ${listen} with ${config.hosts.length} hosts`);
  });

  process.on("SIGHUP", () => {
    try {
      config = readConfig();
      log(`reloaded ${configPath}: ${config.hosts.length} hosts, ${config.tokens.length} tokens`);
    } catch (error) {
      log(`reload of ${configPath} failed, keeping the old config: ${String(error)}`);
    }
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log(`${signal}: stopping`);
      server.close(() => process.exit(0));
    });
  }
}
