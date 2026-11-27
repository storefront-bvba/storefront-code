import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { hubOrigin } from "./hubOrigin.ts";

const usageUrl = new URL("http://192.168.0.188:8318/");
const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("names the hub by the API origin its agents are sent to", () =>
  hubOrigin(usageUrl).pipe(
    withEnv({ STOREFRONT_HUB_ORIGIN: " https://cpa.storefront.be/ " }),
    Effect.map((origin) => expect(origin).toBe("https://cpa.storefront.be")),
  ),
);

it.effect("keeps the usage URL's origin without one, or with one that is no URL", () =>
  Effect.gen(function* () {
    expect(yield* hubOrigin(usageUrl).pipe(withEnv({}))).toBe("http://192.168.0.188:8318");
    expect(yield* hubOrigin(usageUrl).pipe(withEnv({ STOREFRONT_HUB_ORIGIN: "cpa" }))).toBe(
      "http://192.168.0.188:8318",
    );
  }),
);
