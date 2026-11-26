#!/usr/bin/env node
// Storefront Code: fails when upstream changes relay code that F5 copied or mirrors, so a sync
// re-ports it on purpose. After re-porting, `--print` shows the new fingerprints for REGIONS.
// Also checks the AgentAwarenessRelay seam: one relay publish call, behind the sink.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "../..");
const relay = "infra/relay/src";
const agentActivity = `${relay}/agentActivity`;

// Fingerprints taken at upstream v0.1.12 (ca81b7b97a).
const REGIONS = [
  {
    name: "delivery constants and types",
    file: `${agentActivity}/ApnsDeliveries.ts`,
    start: "const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS",
    end: "export type ApnsDeliveryError",
    port: "apps/server/src/storefront/push/deliveryPort.ts",
    hash: "7dbb69c5ece25bb1",
  },
  {
    name: "choosing a delivery",
    file: `${agentActivity}/ApnsDeliveries.ts`,
    start: "function parseAggregate(",
    end: "function duplicateJobResult(",
    port: "apps/server/src/storefront/push/deliveryPort.ts",
    hash: "95dd5f1226b108a8",
  },
  {
    name: "sendLiveActivity checks",
    file: `${agentActivity}/ApnsDeliveries.ts`,
    start: 'const sendLiveActivity: ApnsDeliveries["Service"]["sendLiveActivity"]',
    end: 'const sendPushNotification: ApnsDeliveries["Service"]["sendPushNotification"]',
    port: "apps/server/src/storefront/push/deliveryPort.ts, HostAgentActivity.ts",
    hash: "a3c92db7db5edb50",
  },
  {
    name: "sendPushNotification checks",
    file: `${agentActivity}/ApnsDeliveries.ts`,
    start: 'const sendPushNotification: ApnsDeliveries["Service"]["sendPushNotification"]',
    end: 'const processSignedJob: ApnsDeliveries["Service"]["processSignedJob"]',
    port: "apps/server/src/storefront/push/deliveryPort.ts, HostAgentActivity.ts",
    hash: "c1b69fb7a0ee436c",
  },
  {
    name: "sendForTarget",
    file: `${agentActivity}/ApnsDeliveries.ts`,
    start: "sendForTarget: Effect.fnUntraced(function* (input) {",
    end: "export const layer",
    port: "apps/server/src/storefront/push/deliveryPort.ts",
    hash: "3980ba01819cf77a",
  },
  {
    name: "publish, replay and idle end",
    file: `${agentActivity}/AgentActivityPublisher.ts`,
    start: "const make = Effect.gen(function* () {",
    end: "export const layer",
    port: "apps/server/src/storefront/push/HostAgentActivity.ts",
    hash: "7d978952abfca307",
  },
  {
    name: "Live Activity rows (arming time, delivery marks, token retirement)",
    file: `${agentActivity}/LiveActivities.ts`,
    start: 'register: Effect.fn("relay.live_activities.register")',
    end: "export const layer",
    port: "apps/server/src/storefront/push/DeviceStore.ts",
    hash: "07c3957b9cf71d16",
  },
  {
    name: "device registration",
    file: `${agentActivity}/Devices.ts`,
    start: 'register: Effect.fn("relay.devices.register")',
    end: 'unregister: Effect.fn("relay.devices.unregister")',
    port: "apps/server/src/storefront/push/DeviceStore.ts",
    hash: "f02f9bf486fd3cce",
  },
  {
    name: "registration replay and snapshot",
    file: `${agentActivity}/MobileRegistrations.ts`,
    start: "const make = Effect.gen(function* () {",
    end: "export const layer",
    port: "apps/server/src/storefront/push/HostAgentActivity.ts",
    hash: "2e70993b84750527",
  },
  {
    name: "cron: finished rows kept 30 minutes",
    file: `${relay}/worker.ts`,
    start: "activityRows.pruneTerminal({",
    end: "DeliveryAttempts.DeliveryAttempts.pipe(",
    port: "apps/server/src/storefront/push/HostAgentActivity.ts",
    hash: "2853fedbc7ef6f8c",
  },
];

// Lines that must still be there, word for word.
const REQUIRED_LINES = [
  { file: `${relay}/worker.ts`, text: 'yield* Cloudflare.Workers.cron("*/5 * * * *", () =>' },
  {
    file: `${relay}/worker.ts`,
    text: "Effect.flatMap((publisher) => publisher.endIdleLiveActivities),",
  },
];

function read(file) {
  return NodeFS.readFileSync(NodePath.join(root, file), "utf8");
}

function region(entry) {
  const source = read(entry.file);
  const start = source.indexOf(entry.start);
  if (start < 0) return { error: `start marker not found: ${entry.start}` };
  const end = source.indexOf(entry.end, start + entry.start.length);
  if (end < 0) return { error: `end marker not found: ${entry.end}` };
  return { text: source.slice(start, end) };
}

function fingerprint(text) {
  const normalized = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return NodeCrypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function checkSeam() {
  const problems = [];
  const serverSrc = NodePath.join(root, "apps/server/src");
  const callers = [];
  const walk = (dir) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        if (NodeFS.readFileSync(full, "utf8").includes(".publishAgentActivity(")) {
          callers.push(NodePath.relative(root, full));
        }
      }
    }
  };
  walk(serverSrc);
  const seamFile = "apps/server/src/relay/AgentAwarenessRelay.ts";
  if (callers.length !== 1 || callers[0] !== seamFile) {
    problems.push(
      `relay publish calls outside the seam: ${callers.join(", ") || "none"} (expected only ${seamFile})`,
    );
  }
  const seam = read(seamFile);
  const sinkAt = seam.indexOf("if (sink) return yield* sink.publish(");
  const relayAt = seam.indexOf(".publishAgentActivity(");
  if (sinkAt < 0 || relayAt < 0 || sinkAt > relayAt) {
    problems.push(`${seamFile}: the sink no longer comes before the relay publish`);
  }
  if (
    !seam.includes("sink ? Effect.succeed(sinkGateSecret(name)) : readStoredSecretString(name)")
  ) {
    problems.push(`${seamFile}: the relay's link gates no longer go through the sink`);
  }
  if (!seam.includes("Layer.provide(HostPush.layer)")) {
    problems.push(`${seamFile}: the relay layer no longer provides HostPush.layer`);
  }
  return problems;
}

const print = process.argv.includes("--print");
const failures = [];
const current = [];
for (const entry of REGIONS) {
  const result = region(entry);
  if (result.error) {
    failures.push(`${entry.file} (${entry.name}): ${result.error}`);
    continue;
  }
  const hash = fingerprint(result.text);
  current.push({ name: entry.name, hash });
  if (!print && hash !== entry.hash) {
    failures.push(
      `${entry.file} (${entry.name}) changed upstream: ${entry.hash} -> ${hash}. Re-port into ${entry.port}.`,
    );
  }
}
for (const required of REQUIRED_LINES) {
  if (!read(required.file).includes(required.text)) {
    failures.push(`${required.file}: missing "${required.text}"`);
  }
}
failures.push(...checkSeam());

if (print) {
  for (const { name, hash } of current) console.log(`${hash}  ${name}`);
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`push port: ${failure}`);
  process.exit(1);
}
if (!print) console.log(`push port: ${REGIONS.length} upstream regions unchanged, seam intact.`);
