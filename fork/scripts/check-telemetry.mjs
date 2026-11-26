#!/usr/bin/env node
// Storefront Code telemetry guard (see fork/GOAL.md, "Zero telemetry").
//
// Upstream keeps its analytics code; we neutralise it with small patches instead of deleting it,
// so syncs stay cheap. This guard keeps that safe:
//   1. invariants: our neutralising patches are still in place after a rebase;
//   2. source scan: every line in shipped code that names a telemetry service is counted per file
//      and compared with fork/telemetry-baseline.json, a list we reviewed. More hits than the
//      baseline (a new file, or more lines in a known one) fails;
//   3. dependencies: no package.json may add an analytics or crash-reporting SDK that is not in
//      the baseline.
//
// Usage: node fork/scripts/check-telemetry.mjs           check, exit 1 on new findings
//        node fork/scripts/check-telemetry.mjs --update  rewrite the baseline after review
//
// Inspired by pseudoseed/t3code_dev scripts/no-upstream-telemetry.test.ts (MIT).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baselinePath = join(root, "fork/telemetry-baseline.json");
const update = process.argv.includes("--update");

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
    file: "apps/mobile/app.config.ts",
    mustContain: ["export default withStorefrontIdentity(config);"],
    why: "the mobile config must pass through our identity (own IDs, no Expo updates)",
  },
  {
    file: "apps/mobile/storefront-identity.ts",
    mustContain: ['config.updates = { enabled: false, checkAutomatically: "NEVER"'],
    why: "over-the-air updates from upstream's Expo project must stay off",
  },
];

const failures = [];
const notes = [];

for (const { file, mustContain = [], mustNotContain = [], why } of INVARIANTS) {
  const path = join(root, file);
  if (!existsSync(path)) {
    failures.push(`${file}: missing (${why})`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  for (const needle of mustContain) {
    if (!text.includes(needle)) failures.push(`${file}: lacks ${JSON.stringify(needle)} (${why})`);
  }
  for (const needle of mustNotContain) {
    if (text.includes(needle)) failures.push(`${file}: contains ${JSON.stringify(needle)} (${why})`);
  }
}

const tracked = execFileSync("git", ["ls-files", "--", ...SHIPPED_ROOTS], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter((file) => file !== "");

const sources = {};
for (const file of tracked) {
  if (!SOURCE_FILE.test(file) || NOT_SHIPPED.test(file)) continue;
  const path = join(root, file);
  if (!existsSync(path)) continue;
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [id, pattern] of Object.entries(PATTERNS)) {
    const count = lines.filter((line) => pattern.test(line)).length;
    if (count > 0) (sources[file] ??= {})[id] = count;
  }
}

const dependencies = {};
for (const file of tracked) {
  if (!file.endsWith("package.json")) continue;
  const path = join(root, file);
  if (!existsSync(path)) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    continue;
  }
  const names = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    .flatMap((field) => Object.keys(manifest[field] ?? {}))
    .filter((name) => BANNED_DEPENDENCY.test(name));
  if (names.length > 0) dependencies[file] = [...new Set(names)].sort();
}

if (update) {
  const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    baselinePath,
    JSON.stringify({ sources: sorted(sources), dependencies: sorted(dependencies) }, null, 2) + "\n",
  );
  console.log(`Baseline written: ${Object.keys(sources).length} source files, ${Object.keys(dependencies).length} manifests.`);
} else {
  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8"))
    : { sources: {}, dependencies: {} };
  for (const [file, counts] of Object.entries(sources)) {
    for (const [id, count] of Object.entries(counts)) {
      const known = baseline.sources[file]?.[id] ?? 0;
      if (count > known) failures.push(`${file}: ${id} on ${count} line(s), baseline ${known}`);
    }
  }
  for (const [file, counts] of Object.entries(baseline.sources)) {
    for (const [id, known] of Object.entries(counts)) {
      const count = sources[file]?.[id] ?? 0;
      if (count < known) notes.push(`${file}: ${id} down from ${known} to ${count} (baseline can shrink)`);
    }
  }
  for (const [file, names] of Object.entries(dependencies)) {
    const known = new Set(baseline.dependencies[file] ?? []);
    for (const name of names) {
      if (!known.has(name)) failures.push(`${file}: new telemetry dependency ${name}`);
    }
  }
}

for (const note of notes) console.log(`note: ${note}`);
if (failures.length > 0) {
  console.error("Telemetry guard failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "Review each finding: neutralise it, or, if it is harmless, run with --update and record why in fork/GOAL-CURRENT-STATUS.md.",
  );
  process.exit(1);
}
if (!update) console.log("Telemetry guard passed.");
