#!/usr/bin/env node
// Storefront Code: small App Store Connect API client (no dependencies).
//
//   node fork/scripts/asc.mjs ids        list our registered bundle IDs and their capabilities
//   node fork/scripts/asc.mjs register   register missing bundle IDs and capabilities (idempotent)
//   node fork/scripts/asc.mjs testers    internal TestFlight group "Storefront" with all team users
//   node fork/scripts/asc.mjs apps       list App Store Connect app records
//   node fork/scripts/asc.mjs devices    list registered devices
//   node fork/scripts/asc.mjs device "<name>" <udid>   register a device (idempotent)
//     Development signing needs at least one; read the UDID on the Mac with
//     `xcrun devicectl list devices` while the device is connected.
//   node fork/scripts/asc.mjs certificates                          list signing certificates
//   node fork/scripts/asc.mjs certificate DEVELOPMENT|DISTRIBUTION <csr.pem> <out.cer>
//   node fork/scripts/asc.mjs revoke <certificate id>
//   node fork/scripts/asc.mjs builds     latest uploads: build number, processing state, expiry
//
// Reads ASC_KEY_ID, ASC_ISSUER_ID and optionally ASC_KEY_PATH (default
// ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8) from the environment.
// The key never belongs in this repository.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
} else if (command === "testers") {
  // Internal TestFlight group that gets every build automatically, with every App Store Connect
  // user in it (internal testers must be users of the team).
  const apps = await api("GET", `/v1/apps?filter[bundleId]=${BASE}`);
  const app = apps.data?.[0];
  if (!app) throw new Error(`No App Store Connect app for ${BASE}: create it first.`);
  const groups = await api("GET", `/v1/apps/${app.id}/betaGroups`);
  let group = groups.data?.find((g) => g.attributes.isInternalGroup && g.attributes.name === "Storefront");
  if (!group) {
    const created = await api("POST", "/v1/betaGroups", {
      data: {
        type: "betaGroups",
        attributes: { name: "Storefront", isInternalGroup: true, hasAccessToAllBuilds: true },
        relationships: { app: { data: { type: "apps", id: app.id } } },
      },
    });
    group = created.data;
    console.log(`created internal group Storefront (${group.id})`);
  }
  const members = await api("GET", `/v1/betaGroups/${group.id}/betaTesters?limit=200`);
  const memberEmails = new Set((members.data ?? []).map((t) => t.attributes.email?.toLowerCase()));
  const users = await api("GET", "/v1/users?limit=200");
  for (const user of users.data ?? []) {
    const email = user.attributes.username.toLowerCase();
    if (memberEmails.has(email)) continue;
    await api("POST", "/v1/betaTesters", {
      data: {
        type: "betaTesters",
        attributes: {
          email,
          firstName: user.attributes.firstName,
          lastName: user.attributes.lastName,
        },
        relationships: { betaGroups: { data: [{ type: "betaGroups", id: group.id }] } },
      },
    });
    console.log(`added ${email} to Storefront`);
  }
  console.log("done");
} else if (command === "apps") {
  const result = await api("GET", "/v1/apps?limit=50");
  for (const app of result.data ?? []) {
    console.log(`${app.id}  ${app.attributes.bundleId}  "${app.attributes.name}"`);
  }
} else if (command === "devices") {
  const result = await api("GET", "/v1/devices?limit=200");
  for (const device of result.data ?? []) {
    const { name, udid, model, status } = device.attributes;
    console.log(`${udid}  "${name}"  ${model ?? ""} ${status}`);
  }
} else if (command === "device") {
  const [name, udid] = process.argv.slice(3);
  if (!name || !udid) throw new Error('Usage: node fork/scripts/asc.mjs device "<name>" <udid>');
  const existing = await api("GET", `/v1/devices?filter[udid]=${encodeURIComponent(udid)}`);
  if (existing.data?.length) {
    console.log(`already registered: "${existing.data[0].attributes.name}"`);
  } else {
    await api("POST", "/v1/devices", {
      data: { type: "devices", attributes: { name, udid, platform: "IOS" } },
    });
    console.log(`registered "${name}"`);
  }
} else if (command === "certificates") {
  const result = await api("GET", "/v1/certificates?limit=200");
  for (const cert of result.data ?? []) {
    const { certificateType, name, serialNumber, expirationDate } = cert.attributes;
    console.log(`${cert.id}  ${certificateType}  "${name}"  serial ${serialNumber}  until ${expirationDate?.slice(0, 10)}`);
  }
} else if (command === "certificate") {
  // Create a signing certificate from a CSR (PEM) and write the certificate (DER) to a file.
  const [type, csrPath, outPath] = process.argv.slice(3);
  if (!["DEVELOPMENT", "DISTRIBUTION"].includes(type) || !csrPath || !outPath) {
    throw new Error("Usage: node fork/scripts/asc.mjs certificate DEVELOPMENT|DISTRIBUTION <csr.pem> <out.cer>");
  }
  const csrContent = readFileSync(csrPath, "utf8")
    .replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, "")
    .replace(/\s+/g, "");
  const created = await api("POST", "/v1/certificates", {
    data: { type: "certificates", attributes: { certificateType: type, csrContent } },
  });
  writeFileSync(outPath, Buffer.from(created.data.attributes.certificateContent, "base64"));
  console.log(`created ${type} certificate ${created.data.id} (serial ${created.data.attributes.serialNumber})`);
} else if (command === "builds") {
  const apps = await api("GET", `/v1/apps?filter[bundleId]=${BASE}`);
  const app = apps.data?.[0];
  if (!app) throw new Error(`No App Store Connect app for ${BASE}.`);
  const result = await api(
    "GET",
    `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=10&include=buildBetaDetail`,
  );
  const details = new Map(
    (result.included ?? [])
      .filter((item) => item.type === "buildBetaDetails")
      .map((item) => [item.id, item.attributes]),
  );
  for (const build of result.data ?? []) {
    const { version, processingState, uploadedDate, expirationDate, expired } = build.attributes;
    const detail = details.get(build.relationships?.buildBetaDetail?.data?.id) ?? {};
    console.log(
      `${version}  ${processingState}  internal:${detail.internalBuildState ?? "?"}  uploaded ${uploadedDate?.slice(0, 16)}  ${expired ? "expired" : `expires ${expirationDate?.slice(0, 10)}`}`,
    );
  }
} else if (command === "revoke") {
  const [id] = process.argv.slice(3);
  if (!id) throw new Error("Usage: node fork/scripts/asc.mjs revoke <certificate id>");
  await api("DELETE", `/v1/certificates/${id}`);
  console.log(`revoked ${id}`);
} else {
  console.error(
    "Usage: node fork/scripts/asc.mjs ids|register|testers|apps|devices|device|certificates|certificate|revoke|builds",
  );
  process.exit(2);
}
