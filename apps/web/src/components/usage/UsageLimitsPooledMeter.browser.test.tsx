import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type UsageLimitDisplay } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const display = vi.hoisted(() => ({ current: "remaining" as UsageLimitDisplay }));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  return {
    ...actual,
    useClientSettings: <T,>(select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
      select({ ...DEFAULT_CLIENT_SETTINGS, usageLimitDisplay: display.current }),
  };
});

function showLimitsAs(mode: UsageLimitDisplay): Disposable {
  display.current = mode;
  return {
    [Symbol.dispose]: () => {
      display.current = "remaining";
    },
  };
}

const checkedAt = "2026-10-25T16:00:00.000Z";

function claude(instanceId: string, plan: string, usedPercent: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: "2.1.0",
    status: "ready",
    auth: { status: "authenticated", label: plan, email: `${instanceId}@example.com` },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: "five_hour",
          label: "Session",
          kind: "session",
          usedPercent,
          windowDurationMins: 300,
          resetsAt: "2026-10-25T18:00:00.000Z",
        },
      ],
    },
  };
}

const presentations = new Map([
  [
    EnvironmentId.make("desk"),
    {
      entry: { target: { label: "Desk" } },
      serverConfig: {
        providers: [claude("Work", "Max", 40), claude("Spare", "Pro", 90)],
      },
    },
  ],
]);

describe("UsageLimitsPooled combined meter", () => {
  it("draws one meter for the pool and keeps a row per account", async () => {
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    // Max counts five times Pro: (60 * 5 + 10 * 1) / 6 rounds to 52.
    const meter = screen.getByRole("meter", { name: "Session" });
    await expect.element(meter).toHaveAttribute("aria-valuenow", "52");
    await expect.element(screen.getByText("52%", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /^Work: 60% left/ })).toBeVisible();
    // Same reset time, so the columns follow the account names.
    await expect.element(screen.getByRole("button", { name: /Segment 1\s*Spare/ })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /Segment 2\s*Work/ })).toBeVisible();
  });
});

describe("UsageLimitsPooled as used", () => {
  it("reads the pool, the meter and each account as the share used", async () => {
    using _display = showLimitsAs("used");
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    const meter = screen.getByRole("meter", { name: "Session" });
    await expect.element(meter).toHaveAttribute("aria-valuenow", "48");
    await expect.element(meter).toHaveAttribute("aria-valuetext", "48% used");
    await expect.element(screen.getByText("48%", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("used", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /^Work: 40% used/ })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /Segment 1\s*Spare\s*90%/ }))
      .toBeVisible();
  });
});
