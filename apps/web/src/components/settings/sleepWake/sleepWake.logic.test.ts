import type { StorefrontWakeRelayHost } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  armedDescription,
  cannotWakeText,
  pendingSecondsLeft,
  relayStateLabel,
  rememberRelay,
  splitRelayHosts,
} from "./sleepWake.logic";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");

const host = (
  id: string,
  extra: Partial<StorefrontWakeRelayHost> = {},
): StorefrontWakeRelayHost => ({
  id,
  name: id,
  state: "asleep",
  canWake: true,
  lastSeenAt: null,
  sleptAt: null,
  wakeRequestedAt: null,
  stayAwake: false,
  sleepWhenDone: false,
  ...extra,
});

describe("pendingSecondsLeft", () => {
  it.each([
    ["2026-11-27T10:00:10.000Z", 10],
    ["2026-11-27T10:00:09.200Z", 10],
    ["2026-11-27T10:00:00.400Z", 1],
    ["2026-11-27T09:59:59.000Z", 0],
    // A host clock ahead of ours still counts down from the undo window, not beyond it.
    ["2026-11-27T10:00:30.000Z", 10],
    ["not a date", 0],
    [null, 0],
  ])("%s leaves %i s", (pendingUntil, seconds) => {
    expect(pendingSecondsLeft(pendingUntil, NOW)).toBe(seconds);
  });
});

describe("labels", () => {
  it("says what an armed Sleep when done waits for", () => {
    expect(armedDescription([])).toBe("Going to sleep now.");
    expect(armedDescription(["screenUnlocked"])).toBe("Waiting for the screen to lock.");
    expect(armedDescription(["activeRun", "screenUnlocked", "inhibitor"])).toBe(
      "Waiting for agents to finish, the screen to lock and another app keeping it awake.",
    );
    expect(
      armedDescription(["busy"], { kind: "network", bytesPerSecond: 3.25 * 1024 * 1024 }),
    ).toBe("Waiting for the computer to be quiet for 5 minutes (network at 3.3 MB/s).");
  });

  it("names relay states and why a host cannot wake", () => {
    expect(relayStateLabel("waking")).toBe("Waking…");
    expect(cannotWakeText(host("mac", { canWake: false }))).toBe("Cannot be woken remotely.");
    expect(cannotWakeText(host("mac", { canWake: false, wakeNote: "Needs a sleep proxy." }))).toBe(
      "Needs a sleep proxy.",
    );
  });
});

describe("relays", () => {
  const relay = { url: "https://wake.test", token: "a" };

  it("keeps one entry per relay address with its latest token", () => {
    const known = rememberRelay([], relay);
    expect(rememberRelay(known, { ...relay })).toBe(known);
    expect(rememberRelay(known, { ...relay, token: "b" })).toEqual([{ ...relay, token: "b" }]);
  });

  it("matches relay hosts to environments by id and keeps the rest apart once", () => {
    const entries = [host("pc"), host("mac"), host("mac")].map((entry) => ({ relay, host: entry }));
    const { byEnvironment, unmatched } = splitRelayHosts(["pc", "phone"], entries);
    expect([...byEnvironment.keys()]).toEqual(["pc"]);
    expect(unmatched.map((entry) => entry.host.id)).toEqual(["mac"]);
  });
});
