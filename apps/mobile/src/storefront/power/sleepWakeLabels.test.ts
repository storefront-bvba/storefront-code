import type { StorefrontPowerStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { relayStateLabel, sleepWhenDoneLabel } from "./sleepWakeLabels";

const status = (patch: Partial<StorefrontPowerStatus>): StorefrontPowerStatus => ({
  supported: true,
  stayAwake: false,
  sleepWhenDone: { state: "off", pendingUntil: null },
  waitingFor: [],
  busyWith: null,
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

  it("says what keeps the computer busy", () => {
    const armed = { state: "armed", pendingUntil: null } as const;
    expect(sleepWhenDoneLabel(status({ sleepWhenDone: armed, waitingFor: ["busy"] }), 0)).toBe(
      "Sleeps when done, waiting for the computer to be quiet for 5 minutes · tap to cancel",
    );
    expect(
      sleepWhenDoneLabel(
        status({
          sleepWhenDone: armed,
          waitingFor: ["busy"],
          busyWith: { kind: "process", name: "php", cores: 0.98 },
        }),
        0,
      ),
    ).toBe(
      "Sleeps when done, waiting for the computer to be quiet for 5 minutes (php at 98% CPU) · tap to cancel",
    );
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
