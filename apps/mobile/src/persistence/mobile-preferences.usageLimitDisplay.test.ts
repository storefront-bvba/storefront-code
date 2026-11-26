import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: vi.fn() }));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

function storeWith(payload: Record<string, unknown>) {
  let stored = { payload: JSON.stringify(payload), updatedAt: 1 };
  const unused = Effect.die("unused in this test");
  const database = Layer.succeed(
    MobileDatabase.MobileDatabase,
    MobileDatabase.MobileDatabase.of({
      loadCache: () => unused,
      listCache: () => unused,
      saveCache: () => unused,
      removeCache: () => unused,
      clearCacheKind: () => unused,
      clearEnvironmentCache: () => unused,
      clearAllCaches: unused,
      inspectCaches: unused,
      loadPreferencesJson: Effect.sync(() => Option.some(stored)),
      savePreferencesJson: (next, updatedAt) =>
        Effect.sync(() => {
          stored = { payload: next, updatedAt };
        }),
    }),
  );
  const secureStorage = Layer.succeed(
    MobileSecureStorage.MobileSecureStorage,
    MobileSecureStorage.MobileSecureStorage.of({
      getItem: () => Effect.succeed(null),
      setItem: () => Effect.void,
      removeItem: () => Effect.void,
    }),
  );
  return MobilePreferences.layer.pipe(Layer.provide(Layer.merge(database, secureStorage)));
}

describe("usage limit display preference", () => {
  it.effect("survives a save of another preference", () =>
    Effect.gen(function* () {
      const store = yield* MobilePreferences.MobilePreferencesStore;
      expect((yield* store.load).usageLimitDisplay).toBe("used");
      yield* store.savePatch({ workingShelfEnabled: false });
      expect((yield* store.load).usageLimitDisplay).toBe("used");
    }).pipe(Effect.provide(storeWith({ usageLimitDisplay: "used" }))),
  );

  it.effect("drops an unknown value", () =>
    Effect.gen(function* () {
      const store = yield* MobilePreferences.MobilePreferencesStore;
      expect((yield* store.load).usageLimitDisplay).toBeUndefined();
    }).pipe(Effect.provide(storeWith({ usageLimitDisplay: "sideways" }))),
  );
});
