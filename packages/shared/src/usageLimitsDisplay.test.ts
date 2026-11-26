import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectLimitPools, type LimitAccount } from "./usageLimits.ts";
import {
  limitPercentText,
  limitPercentWithTimeText,
  limitWindowSummary,
  limitWindowTimeText,
  poolMeter,
  shownPercent,
} from "./usageLimitsDisplay.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 10,
  windowDurationMins: 7 * 24 * 60,
  resetsAt: "2026-09-08T12:00:00.000Z",
} as const;

const account = (
  key: string,
  plan: string | undefined,
  windows: LimitAccount["limits"]["windows"],
): LimitAccount => ({
  key,
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: key,
  email: undefined,
  plan,
  accentColor: undefined,
  environments: [],
  sourceLabel: "Hub",
  redeem: null,
  limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
});

const sessionPool = (accounts: readonly LimitAccount[]) =>
  collectLimitPools(accounts, now)[0]!.windows.find((window) => window.kind === "session")!;

describe("poolMeter", () => {
  it("fills one meter with each account's share of what is left", () => {
    const pool = sessionPool([
      account("max", "Max", [session]),
      account("pro", "Pro", [{ ...session, usedPercent: 90 }]),
    ]);
    const meter = poolMeter(pool, now);
    const fill = meter.pieces.reduce((sum, piece) => sum + piece.width, 0);

    expect(meter.pieces.map(({ member, index }) => [member.account.key, index])).toEqual([
      ["max", 1],
      ["pro", 2],
    ]);
    // A Max plan holds five times a Pro plan's session allowance.
    expect(meter.pieces[0]!.width).toBeCloseTo(50);
    expect(meter.pieces[1]!.start).toBeCloseTo(50);
    expect(meter.pieces[1]!.width).toBeCloseTo(10 / 6);
    expect(Math.round(fill)).toBe(pool.remainingPercent);
  });

  it("places what the resets restore after the fill, within the meter", () => {
    const meter = poolMeter(
      sessionPool([
        account("max", "Max", [session]),
        account("pro", "Pro", [{ ...session, usedPercent: 90 }]),
      ]),
      now,
    );
    const fill = meter.pieces.reduce((sum, piece) => sum + piece.width, 0);

    expect(meter.refills.map((refill) => refill.member.account.key)).toEqual(["max", "pro"]);
    expect(meter.refills[0]!.start).toBeCloseTo(fill);
    expect(meter.refills[0]!.width).toBeCloseTo(40 * (5 / 6));
    expect(meter.refills[1]!.start + meter.refills[1]!.width).toBeCloseTo(100);
  });

  it("restores nothing for a window without a reset time", () => {
    const meter = poolMeter(
      sessionPool([account("a", undefined, [{ ...session, resetsAt: undefined }])]),
      now,
    );

    expect(meter.refills).toEqual([]);
    expect(meter.paceMark).toBeNull();
  });

  it("marks even pace as the share-weighted time left of every account", () => {
    const meter = poolMeter(
      sessionPool([
        account("a", undefined, [session]),
        account("b", undefined, [{ ...session, resetsAt: "2026-09-03T16:00:00.000Z" }]),
      ]),
      now,
    );

    // Two hours of five left for one account and four of five for the other.
    expect(meter.paceMark).toBeCloseTo((40 + 80) / 2);
  });

  it("keeps column numbers when an account does not report the window", () => {
    const accounts = [
      account("a", undefined, [session, weekly]),
      account("b", undefined, [{ ...session, usedPercent: 0 }]),
      account("c", undefined, [weekly]),
    ];
    const pool = collectLimitPools(accounts, now)[0]!;
    const week = pool.windows.find((window) => window.kind === "weekly")!;
    const meter = poolMeter(week, now);

    expect(week.columns.map((column) => column.account.key)).toEqual(
      pool.accounts.map((entry) => entry.key),
    );
    expect(meter.pieces.map(({ member, index }) => [member.account.key, index])).toEqual(
      week.columns.flatMap((column, position) =>
        column.window ? [[column.account.key, position + 1]] : [],
      ),
    );
    expect(meter.pieces.reduce((sum, piece) => sum + piece.width, 0)).toBeCloseTo(90);
  });
});

describe("usage limit display", () => {
  it("flips quota and time to the share used", () => {
    expect(shownPercent(40, "remaining")).toBe(40);
    expect(shownPercent(40, "used")).toBe(60);
    expect(limitPercentText(40, "remaining")).toBe("40% left");
    expect(limitPercentText(40, "used")).toBe("60% used");
    expect(limitWindowTimeText(25, "remaining")).toBe("25% of the window left");
    expect(limitWindowTimeText(25, "used")).toBe("75% of the window passed");
    expect(limitPercentWithTimeText(40, 25, "used")).toBe("60% used · 75% of the window passed");
    expect(limitPercentWithTimeText(40, null, "used")).toBe("60% used");
  });

  it.each([
    ["remaining", null, null, "Session: 40% left"],
    ["remaining", 25, "resets in 2h", "Session: 40% left, 25% of the window left, resets in 2h"],
    ["used", null, "resets in 2h", "Session: 60% used, resets in 2h"],
    ["used", 25, null, "Session: 60% used, 75% of the window passed"],
  ] as const)("reads a %s window aloud", (display, timeLeft, resetsIn, expected) => {
    expect(
      limitWindowSummary({ label: "Session", remaining: 40, timeLeft, resetsIn }, display),
    ).toBe(expected);
  });

  it("fills the meter with what each account used", () => {
    const pool = sessionPool([
      account("max", "Max", [session]),
      account("pro", "Pro", [{ ...session, usedPercent: 90 }]),
    ]);
    const meter = poolMeter(pool, now, "used");
    const [max, pro] = meter.pieces;

    expect(max!.width).toBeCloseTo(40 * (5 / 6));
    expect(pro!.start).toBeCloseTo(max!.width);
    expect(pro!.width).toBeCloseTo(15);
    expect(Math.round(max!.width + pro!.width)).toBe(100 - pool.remainingPercent);
    expect(meter.refills).toEqual([]);
    expect(meter.paceMark).toBeCloseTo(100 - poolMeter(pool, now).paceMark!);
  });
});
