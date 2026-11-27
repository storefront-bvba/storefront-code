import type { StorefrontPowerStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { relayStateLabel, sleepWhenDoneLabel } from "./sleepWakeLabels";

const status = (patch: Partial<StorefrontPowerStatus>): StorefrontPowerStatus => ({
  supported: true,
  stayAwake: false,
  sleepWhenDone: { state: "off", pendingUntil: null },
  waitingFor: [],
  lastError: null,
  relay: null,
  ...patch,
});

describe("sleep and wake labels", () => {
  it("counts down while a tap can still be undone", () => {
    expect(
      sleepWhenDoneLabel(
        status({ sleepWhenDone: { state: "pending", pendingUntil: "2026-11-27T08:00:10Z" } }),
        7,
      ),
    ).toBe("Sleeping when done in 7 s · tap to undo");
  });

  it("says what an armed host still waits for", () => {
    expect(
      sleepWhenDoneLabel(
        status({
          sleepWhenDone: { state: "armed", pendingUntil: null },
          waitingFor: ["activeRun", "screenUnlocked"],
        }),
        0,
      ),
    ).toBe("Sleeps when done, waiting for agents to finish and the screen to lock · tap to cancel");
    expect(sleepWhenDoneLabel(status({}), 0)).toBe("Sleep when done");
  });

  it("names every relay state", () => {
    const host = {
      id: "env",
      name: "Omarchy",
      canWake: true,
      lastSeenAt: null,
      sleptAt: null,
      wakeRequestedAt: null,
      stayAwake: false,
      sleepWhenDone: false,
    } as const;
    expect(relayStateLabel(undefined)).toBeNull();
    expect(relayStateLabel({ ...host, state: "waking" })).toBe("Waking…");
    expect(relayStateLabel({ ...host, state: "asleep" })).toBe("Asleep");
    expect(relayStateLabel({ ...host, state: "unknown" })).toBe("Not seen yet");
  });
});
