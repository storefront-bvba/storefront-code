// Storefront Code (fork): the browser's side of our wake relay (fork/wake-relay). Plain fetch on
// purpose: the relay's CORS allows only `authorization` and `content-type`, so trace headers an
// Effect HTTP client adds would fail the preflight. The token never goes into a URL or a log.
import {
  StorefrontWakeRelayHost,
  StorefrontWakeRelayHosts,
  type StorefrontWakeRelay,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeHosts = Schema.decodeUnknownPromise(StorefrontWakeRelayHosts);
const decodeWakeAnswer = Schema.decodeUnknownPromise(
  Schema.Struct({ host: StorefrontWakeRelayHost }),
);

const relayUrl = (relay: StorefrontWakeRelay, path: string) =>
  `${relay.url.replace(/\/+$/, "")}${path}`;

async function call(relay: StorefrontWakeRelay, method: "GET" | "POST", path: string) {
  const response = await fetch(relayUrl(relay, path), {
    method,
    headers: { authorization: `Bearer ${relay.token}` },
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Wake relay answered ${response.status}`);
  return response.json() as Promise<unknown>;
}

export async function fetchWakeRelayHosts(relay: StorefrontWakeRelay) {
  return (await decodeHosts(await call(relay, "GET", "/v1/hosts"))).hosts;
}

export async function wakeRelayHost(relay: StorefrontWakeRelay, hostId: string) {
  const path = `/v1/hosts/${encodeURIComponent(hostId)}/wake`;
  return (await decodeWakeAnswer(await call(relay, "POST", path))).host;
}
