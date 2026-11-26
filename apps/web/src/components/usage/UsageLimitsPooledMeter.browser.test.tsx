import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

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

describe("UsageLimitsPooled combined meter", () => {
  it("draws one meter for the pool and keeps a row per account", async () => {
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
