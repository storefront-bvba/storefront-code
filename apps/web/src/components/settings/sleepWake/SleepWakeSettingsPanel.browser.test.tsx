import { RegistryContext } from "@effect/atom-react";
import type { StorefrontPowerStatus, StorefrontWakeRelayHost } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";
import "~/index.css";
import type { PowerSwitch } from "./powerHost";
import { SleepWakeSettingsPanel } from "./SleepWakeSettingsPanel";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");
const PENDING_UNTIL = "2026-11-27T10:00:10.000Z";
const OFF = { state: "off", pendingUntil: null } as const;
const RELAY = { url: "https://wake.test/", token: "client-token" };

const mocks = vi.hoisted(() => ({
  environments: [] as Array<{ environmentId: string; label: string }>,
  hosts: new Map<string, unknown>(),
  writes: [] as Array<{ environmentId: string; which: string; on: boolean }>,
}));

vi.mock(import("../../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: mocks.environments })) as never,
}));

// The host side, modelled on the server: turning one switch on turns the other off.
vi.mock(import("./powerHost"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    readPowerStatus: ((environmentId: string) => {
      const status = mocks.hosts.get(environmentId);
      return status === undefined
        ? Effect.fail(new actual.PowerHostRefused({ status: 0 }))
        : Effect.succeed({ _tag: "Ok", status });
    }) as never,
    writePowerSwitch: ((input: { environmentId: string; which: PowerSwitch; on: boolean }) =>
      Effect.sync(() => {
        mocks.writes.push(input);
        const current = mocks.hosts.get(input.environmentId) as StorefrontPowerStatus;
        const next: StorefrontPowerStatus =
          input.which === "stayAwake"
            ? {
                ...current,
                stayAwake: input.on,
                sleepWhenDone: input.on ? OFF : current.sleepWhenDone,
              }
            : {
                ...current,
                stayAwake: input.on ? false : current.stayAwake,
                sleepWhenDone: input.on ? { state: "pending", pendingUntil: PENDING_UNTIL } : OFF,
              };
        mocks.hosts.set(input.environmentId, next);
        return { _tag: "Ok", status: next };
      })) as never,
  };
});

const status = (extra: Partial<StorefrontPowerStatus> = {}): StorefrontPowerStatus => ({
  supported: true,
  stayAwake: false,
  sleepWhenDone: OFF,
  waitingFor: [],
  busyWith: null,
  lastError: null,
  relay: null,
  ...extra,
});

const relayHost = (
  id: string,
  extra: Partial<StorefrontWakeRelayHost>,
): StorefrontWakeRelayHost => ({
  id,
  name: id,
  state: "awake",
  canWake: true,
  lastSeenAt: null,
  sleptAt: null,
  wakeRequestedAt: null,
  stayAwake: false,
  sleepWhenDone: false,
  ...extra,
});

function setup(
  environments: ReadonlyArray<{ id: string; label: string; status?: StorefrontPowerStatus }>,
) {
  mocks.environments = environments.map(({ id, label }) => ({ environmentId: id, label }));
  mocks.hosts.clear();
  for (const environment of environments) {
    if (environment.status) mocks.hosts.set(environment.id, environment.status);
  }
  mocks.writes.length = 0;
}

// Each test gets its own registry, so relays one test learned never reach the next.
const panel = () => (
  <RegistryContext.Provider value={AtomRegistry.make()}>
    <SleepWakeSettingsPanel />
  </RegistryContext.Provider>
);

it("arms Sleep when done with a 10-second undo, turning Stay awake off, and undoes it", async () => {
  setup([{ id: "pc", label: "Omarchy", status: status({ stayAwake: true }) }]);
  using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  await using screen = await render(panel());

  const stayAwake = screen.getByRole("switch", { name: "Stay awake" });
  await expect.element(stayAwake).toBeChecked();
  await screen.getByRole("button", { name: "Sleep when done" }).click();

  await expect.element(screen.getByText("Starts in 10 s. Undo keeps it awake.")).toBeVisible();
  await expect.element(stayAwake).not.toBeChecked();
  await screen.getByRole("button", { name: "Undo" }).click();

  await expect.element(screen.getByRole("button", { name: "Sleep when done" })).toBeVisible();
  expect(mocks.writes).toEqual([
    { environmentId: "pc", which: "sleepWhenDone", on: true },
    { environmentId: "pc", which: "sleepWhenDone", on: false },
  ]);
});

it("shows what an armed Sleep when done waits for, the host's last error, and cancels", async () => {
  setup([
    {
      id: "pc",
      label: "Omarchy",
      status: status({
        sleepWhenDone: { state: "armed", pendingUntil: null },
        waitingFor: ["screenUnlocked"],
        lastError: "Suspend was refused.",
      }),
    },
  ]);
  await using screen = await render(panel());

  await expect.element(screen.getByText("Sleeps when done")).toBeVisible();
  await expect.element(screen.getByText("Waiting for the screen to lock.")).toBeVisible();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Suspend was refused.");
  await screen.getByRole("button", { name: "Cancel" }).click();

  await expect.element(screen.getByRole("button", { name: "Sleep when done" })).toBeVisible();
  expect(mocks.writes).toEqual([{ environmentId: "pc", which: "sleepWhenDone", on: false }]);
});

it("wakes a sleeping environment through the relay and lists hosts without an environment", async () => {
  setup([
    { id: "pc", label: "Omarchy", status: status({ relay: RELAY }) },
    { id: "laptop", label: "Laptop" },
  ]);
  const hosts = new Map([
    ["pc", relayHost("pc", {})],
    ["laptop", relayHost("laptop", { state: "asleep" })],
    ["mac", relayHost("mac", { name: "MacBook", state: "asleep", canWake: false })],
  ]);
  const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
  const fetch = globalThis.fetch;
  using _network = vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
    const url = request instanceof Request ? request.url : String(request);
    if (!url.startsWith("https://wake.test/")) return fetch(request, init);
    const method = init?.method ?? "GET";
    requests.push({ url, method, authorization: new Headers(init?.headers).get("authorization") });
    if (method === "POST" && url === "https://wake.test/v1/hosts/laptop/wake") {
      const woken = relayHost("laptop", {
        state: "waking",
        wakeRequestedAt: "2026-11-27T10:00:01Z",
      });
      hosts.set("laptop", woken);
      return Promise.resolve(Response.json({ host: woken }, { status: 202 }));
    }
    return Promise.resolve(
      Response.json({ now: "2026-11-27T10:00:00Z", hosts: [...hosts.values()] }),
    );
  });
  await using screen = await render(panel());

  const laptop = screen.getByRole("region", { name: "Laptop" });
  await expect.element(laptop.getByText("Asleep")).toBeVisible();
  await expect.element(laptop.getByText("Could not reach this environment.")).toBeVisible();
  const mac = screen.getByRole("region", { name: "MacBook" });
  await expect.element(mac.getByText("Cannot be woken remotely.")).toBeVisible();
  expect(mac.getByRole("button").elements()).toEqual([]);
  const omarchy = screen.getByRole("region", { name: "Omarchy" });
  await expect.element(omarchy.getByText("Awake")).toBeVisible();
  expect(omarchy.getByRole("button", { name: "Wake up" }).elements()).toEqual([]);

  await laptop.getByRole("button", { name: "Wake up" }).click();

  await expect.element(laptop.getByRole("button", { name: "Waking…" })).toBeDisabled();
  // The relay's next answer says "waking" too, so the badge follows the button.
  await vi.waitFor(() => expect(laptop.getByText("Waking…").elements()).toHaveLength(2));
  expect(requests).toContainEqual({
    url: "https://wake.test/v1/hosts/laptop/wake",
    method: "POST",
    authorization: "Bearer client-token",
  });
  expect(requests.every((request) => !request.url.includes("client-token"))).toBe(true);
});
