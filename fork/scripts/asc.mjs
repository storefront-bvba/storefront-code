#!/usr/bin/env node
// Storefront Code: small App Store Connect API client (no dependencies).
//
//   node fork/scripts/asc.mjs ids        list our registered bundle IDs and their capabilities
//   node fork/scripts/asc.mjs register   register missing bundle IDs and capabilities (idempotent)
//   node fork/scripts/asc.mjs apps       list App Store Connect app records
//
// Reads ASC_KEY_ID, ASC_ISSUER_ID and optionally ASC_KEY_PATH (default
// ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8) from the environment.
// The key never belongs in this repository.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.appstoreconnect.apple.com";
const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuerId } = process.env;
if (!keyId || !issuerId) {
  console.error("Set ASC_KEY_ID and ASC_ISSUER_ID.");
  process.exit(2);
}
const keyPath =
  process.env.ASC_KEY_PATH ?? join(homedir(), ".appstoreconnect/private_keys", `AuthKey_${keyId}.p8`);
const privateKey = createPrivateKey(readFileSync(keyPath));

// Every bundle ID the app variants and their extensions use (see apps/mobile/storefront-identity.ts).
const BASE = "be.storefront.code";
const VARIANTS = [
  { suffix: "", label: "Storefront Code" },
  { suffix: ".dev", label: "Storefront Code Dev" },
];
const TARGETS = [
  { suffix: "", label: "", capabilities: ["PUSH_NOTIFICATIONS", "APP_GROUPS"] },
  { suffix: ".widgets", label: " Widgets", capabilities: ["APP_GROUPS"] },
  { suffix: ".sharing", label: " Sharing", capabilities: ["APP_GROUPS"] },
];
const WANTED = VARIANTS.flatMap((variant) =>
  TARGETS.map((target) => ({
    identifier: `${BASE}${variant.suffix}${target.suffix}`,
    name: `${variant.label}${target.label}`,
    capabilities: target.capabilities,
  })),
);

const base64url = (input) => Buffer.from(input).toString("base64url");
function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 15 * 60, aud: "appstoreconnect-v1" }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = (json.errors ?? []).map((error) => `${error.code}: ${error.detail}`).join("; ");
    throw new Error(`${method} ${path} → ${response.status} ${detail || text}`);
  }
  return json;
}

async function ourBundleIds() {
  const result = await api(
    "GET",
    `/v1/bundleIds?filter[identifier]=${encodeURIComponent(WANTED.map((w) => w.identifier).join(","))}&include=bundleIdCapabilities&limit=200`,
  );
  const capabilities = new Map(
    (result.included ?? [])
      .filter((item) => item.type === "bundleIdCapabilities")
      .map((item) => [item.id, item.attributes.capabilityType]),
  );
  return (result.data ?? [])
    // filter[identifier] also matches prefixes, so keep exact matches only.
    .filter((item) => WANTED.some((w) => w.identifier === item.attributes.identifier))
    .map((item) => ({
      id: item.id,
      identifier: item.attributes.identifier,
      name: item.attributes.name,
      capabilities: (item.relationships?.bundleIdCapabilities?.data ?? []).map((ref) =>
        capabilities.get(ref.id),
      ),
    }));
}

const command = process.argv[2];
if (command === "ids") {
  for (const id of await ourBundleIds()) {
    console.log(`${id.identifier}  "${id.name}"  [${id.capabilities.join(", ")}]`);
  }
} else if (command === "register") {
  const existing = new Map((await ourBundleIds()).map((id) => [id.identifier, id]));
  for (const wanted of WANTED) {
    let record = existing.get(wanted.identifier);
    if (!record) {
      const created = await api("POST", "/v1/bundleIds", {
        data: {
          type: "bundleIds",
          attributes: { identifier: wanted.identifier, name: wanted.name, platform: "IOS" },
        },
      });
      record = { id: created.data.id, identifier: wanted.identifier, capabilities: [] };
      console.log(`registered ${wanted.identifier}`);
    }
    for (const capability of wanted.capabilities) {
      if (record.capabilities.includes(capability)) continue;
      await api("POST", "/v1/bundleIdCapabilities", {
        data: {
          type: "bundleIdCapabilities",
          attributes: { capabilityType: capability },
          relationships: { bundleId: { data: { type: "bundleIds", id: record.id } } },
        },
      });
      console.log(`enabled ${capability} on ${wanted.identifier}`);
    }
  }
  console.log("done");
} else if (command === "apps") {
  const result = await api("GET", "/v1/apps?limit=50");
  for (const app of result.data ?? []) {
    console.log(`${app.id}  ${app.attributes.bundleId}  "${app.attributes.name}"`);
  }
} else {
  console.error("Usage: node fork/scripts/asc.mjs ids|register|apps");
  process.exit(2);
}
