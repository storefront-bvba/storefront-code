#!/usr/bin/env node
// Storefront Code telemetry guard (fork/GOAL.md, "Zero telemetry"), after pseudoseed/t3code_dev's
// no-upstream-telemetry.test.ts (MIT). No arguments: check the source against the reviewed
// fork/telemetry-baseline.json. `--update`: rewrite that baseline after review. `--artifact <dir>`:
// check an unpacked build. Exit 1 on any finding.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const baselinePath = NodePath.join(root, "fork/telemetry-baseline.json");
const args = process.argv.slice(2);
const update = args.includes("--update");
const artifactIndex = args.indexOf("--artifact");

const SHIPPED_ROOTS = ["apps/server", "apps/web", "apps/desktop", "apps/mobile", "packages"];
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|swift|kt|mm?|java)$/;
const NOT_SHIPPED = /(?:\.test\.|\.spec\.|\/__tests__\/|\/test-fixtures?\b|\.stories\.)/;

const PATTERNS = {
  posthog: /posthog/i,
  "posthog-key": /phc_[A-Za-z0-9]{20,}/,
  "t3-ingest": /ingest\.t3\.codes/,
  axiom: /axiom/i,
  // Not preceded by a letter, so identifiers like `isEntry` or `hasEntry` do not count.
  sentry: /(?<![A-Za-z])sentry/i,
  "expo-observe": /expo-observe/,
  "expo-updates-host": /u\.expo\.dev/,
  "other-vendor":
    /\b(?:mixpanel|amplitude|segment\.(?:io|com)|datadoghq|statsig|launchdarkly|bugsnag|honeycomb\.io|newrelic|logrocket|fullstory|hotjar|plausible\.io|google-analytics|googletagmanager|crashlytics)\b/i,
};

// Every host in a URL of shipped code must be in the baseline's reviewed `hosts` or `allowedHosts`.
// Reserved, private and tailnet names are examples or local and never leave the machine.
const URL_HOST = /\b(?:https?|wss?):\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const LOCAL_HOST =
  /(?:^|\.)(?:invalid|test|example|localhost|local|internal|arpa|ts\.net)$|^(?:[\w-]+\.)*example\.(?:com|org|net)$|^(?:127|10)\.\d+\.\d+\.\d+$|^192\.168\.\d+\.\d+$|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/;

const BANNED_DEPENDENCY =
  /^(?:posthog.*|@posthog\/.*|@sentry\/.*|sentry-.*|expo-observe|@axiomhq\/.*|mixpanel.*|@amplitude\/.*|@segment\/.*|@vercel\/analytics|@datadog\/.*|@bugsnag\/.*|@react-native-firebase\/(?:analytics|crashlytics)|statsig.*|launchdarkly.*|@launchdarkly\/.*)$/;

const INVARIANTS = [
  {
    file: "apps/server/src/telemetry/AnalyticsService.ts",
    mustContain: ["const enabledByDefault = false;"],
    mustNotContain: ["ingest.t3.codes", "phc_"],
    why: "server product analytics must default off with no built-in destination",
  },
  {
    file: "packages/shared/src/cliRelease.ts",
    mustContain: ['const CLI_RELEASE_REPOSITORY = "storefront-bvba/storefront-code";'],
    why: "server and CLI updates must come from our own releases, never upstream's",
  },
  {
    file: "apps/mobile/app.config.ts",
    mustContain: ["export default withStorefrontIdentity(config);"],
    why: "the mobile config must pass through our identity (own IDs, no Expo updates)",
  },
  {
    file: "apps/mobile/storefront-identity.ts",
    mustContain: ['config.updates = { enabled: false, checkAutomatically: "NEVER"'],
    why: "over-the-air updates from upstream's Expo project must stay off",
  },
  {
    file: "packages/shared/src/favicon.ts",
    mustContain: ["// Storefront Code: no favicon service"],
    mustNotContain: ["google.com/s2/favicons"],
    why: "link favicons must not tell Google (or the linked site) which domains a thread shows",
  },
];

// GOAL.md sync checklist step 4: what a built runtime or app must not, and must, contain.
const ARTIFACT_FORBIDDEN = {
  "t3-ingest": /ingest\.t3\.codes/,
  "posthog-key": /phc_[A-Za-z0-9]{20,}/,
  "axiom-host": /\baxiom\.co\b/,
  "expo-updates-host": /\bu\.expo\.dev\b/,
  "upstream-releases": /pingdotgg\/t3code\/releases/,
  "google-favicons": /google\.com\/s2\/favicons/,
};
const ARTIFACT_REQUIRED = { "own-update-source": /storefront-bvba\/storefront-code/ };

const failures = [];
const notes = [];

function finish(hint) {
  for (const note of notes) console.log(`note: ${note}`);
  if (failures.length > 0) {
    console.error("Telemetry guard failed:");
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(hint);
    process.exit(1);
  }
}

function filesUnder(path) {
  const stat = NodeFS.lstatSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return NodeFS.readdirSync(path).flatMap((name) => filesUnder(NodePath.join(path, name)));
}

if (artifactIndex !== -1) {
  const artifact = args[artifactIndex + 1];
  if (!artifact || !NodeFS.existsSync(artifact)) {
    console.error("Usage: node fork/scripts/check-telemetry.mjs --artifact <unpacked build>");
    process.exit(2);
  }
  const found = {};
  const files = filesUnder(NodePath.resolve(artifact));
  for (const file of files) {
    // latin1 keeps every byte, so strings inside executables and bytecode are searched too.
    const text = NodeFS.readFileSync(file).toString("latin1");
    for (const [id, pattern] of Object.entries({ ...ARTIFACT_FORBIDDEN, ...ARTIFACT_REQUIRED })) {
      if (pattern.test(text)) (found[id] ??= []).push(NodePath.relative(artifact, file));
    }
  }
  for (const id of Object.keys(ARTIFACT_FORBIDDEN)) {
    if (found[id]) failures.push(`${id} in ${found[id].join(", ")}`);
  }
  for (const id of Object.keys(ARTIFACT_REQUIRED)) {
    if (!found[id]) failures.push(`${id} not found in any file`);
  }
  finish("Do not ship this build: find what put each string in, and neutralise it in the source.");
  console.log(`Artifact check passed (${files.length} files).`);
  process.exit(0);
}

for (const { file, mustContain = [], mustNotContain = [], why } of INVARIANTS) {
  const path = NodePath.join(root, file);
  if (!NodeFS.existsSync(path)) {
    failures.push(`${file}: missing (${why})`);
    continue;
  }
  const text = NodeFS.readFileSync(path, "utf8");
  for (const needle of mustContain) {
    if (!text.includes(needle)) failures.push(`${file}: lacks ${JSON.stringify(needle)} (${why})`);
  }
  for (const needle of mustNotContain) {
    if (text.includes(needle))
      failures.push(`${file}: contains ${JSON.stringify(needle)} (${why})`);
  }
}

const tracked = NodeChildProcess.execFileSync("git", ["ls-files", "--", ...SHIPPED_ROOTS], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter((file) => file !== "");

const sources = {};
const hostFiles = {};
for (const file of tracked) {
  if (!SOURCE_FILE.test(file) || NOT_SHIPPED.test(file)) continue;
  const path = NodePath.join(root, file);
  if (!NodeFS.existsSync(path)) continue;
  const text = NodeFS.readFileSync(path, "utf8");
  const lines = text.split("\n");
  for (const [id, pattern] of Object.entries(PATTERNS)) {
    const count = lines.filter((line) => pattern.test(line)).length;
    if (count > 0) (sources[file] ??= {})[id] = count;
  }
  for (const match of text.matchAll(URL_HOST)) {
    const host = match[1].toLowerCase();
    if (!LOCAL_HOST.test(host)) (hostFiles[host] ??= new Set()).add(file);
  }
}

const dependencies = {};
for (const file of tracked) {
  if (!file.endsWith("package.json")) continue;
  const path = NodePath.join(root, file);
  if (!NodeFS.existsSync(path)) continue;
  let manifest;
  try {
    manifest = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    continue;
  }
  const names = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    .flatMap((field) => Object.keys(manifest[field] ?? {}))
    .filter((name) => BANNED_DEPENDENCY.test(name));
  if (names.length > 0) dependencies[file] = [...new Set(names)].sort();
}

const baseline = NodeFS.existsSync(baselinePath)
  ? JSON.parse(NodeFS.readFileSync(baselinePath, "utf8"))
  : {};
const allowedHosts = baseline.allowedHosts ?? {};
const hosts = Object.keys(hostFiles)
  .filter((host) => !Object.hasOwn(allowedHosts, host))
  .sort();

if (update) {
  const sorted = (object) =>
    Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
  const next = {
    sources: sorted(sources),
    dependencies: sorted(dependencies),
    hosts,
    allowedHosts: sorted(allowedHosts),
  };
  NodeFS.writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
  console.log(
    `Baseline written: ${Object.keys(sources).length} source files, ${Object.keys(dependencies).length} manifests, ${hosts.length} hosts.`,
  );
} else {
  const baselineSources = baseline.sources ?? {};
  for (const [file, counts] of Object.entries(sources)) {
    for (const [id, count] of Object.entries(counts)) {
      const known = baselineSources[file]?.[id] ?? 0;
      if (count > known) failures.push(`${file}: ${id} on ${count} line(s), baseline ${known}`);
    }
  }
  for (const [file, counts] of Object.entries(baselineSources)) {
    for (const [id, known] of Object.entries(counts)) {
      const count = sources[file]?.[id] ?? 0;
      if (count < known)
        notes.push(`${file}: ${id} down from ${known} to ${count} (baseline can shrink)`);
    }
  }
  for (const [file, names] of Object.entries(dependencies)) {
    const known = new Set(baseline.dependencies?.[file] ?? []);
    for (const name of names) {
      if (!known.has(name)) failures.push(`${file}: new telemetry dependency ${name}`);
    }
  }
  const knownHosts = new Set(baseline.hosts ?? []);
  for (const host of hosts) {
    if (!knownHosts.has(host)) {
      failures.push(`new outbound host ${host} in ${[...hostFiles[host]].sort().join(", ")}`);
    }
  }
  for (const host of knownHosts) {
    if (!hostFiles[host])
      notes.push(`host ${host} no longer in shipped code (baseline can shrink)`);
  }
}

finish(
  "Review each finding: neutralise it, or, if it is harmless, run with --update and record why in fork/GOAL-CURRENT-STATUS.md.",
);
if (!update) console.log("Telemetry guard passed.");
