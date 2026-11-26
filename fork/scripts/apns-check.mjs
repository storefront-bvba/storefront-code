#!/usr/bin/env node
// Storefront Code: one APNs alert to a made-up token with our key, upstream's client and our
// HTTP/2 client; 400 BadDeviceToken means Apple took the key, team and JWT (403: it did not).
// Needs the four STOREFRONT_APNS_* variables; `--production` for api.push.apple.com.
import * as NodeCrypto from "node:crypto";

const { runApnsCheck } = await import("../../apps/server/src/storefront/push/apnsCheck.ts");

const environment = process.argv.includes("--production") ? "production" : "sandbox";
const tokenArg = process.argv.find((arg) => arg.startsWith("--token="));
const deviceToken = tokenArg
  ? tokenArg.slice("--token=".length)
  : NodeCrypto.randomBytes(32).toString("hex");

try {
  const result = await runApnsCheck({ environment, deviceToken });
  console.log(JSON.stringify(result, null, 2));
  const accepted = result.status === 400 && result.reason === "BadDeviceToken";
  console.log(
    accepted
      ? "OK: Apple accepted the key, team and JWT (the device token is made up)."
      : `Unexpected answer ${result.status} ${result.reason ?? ""}`.trim(),
  );
  process.exit(accepted || (tokenArg && result.status === 200) ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
