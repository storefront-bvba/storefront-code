import { describe, expect, it } from "vite-plus/test";

import { summarizeThreadUsage, usageTone } from "./threadUsage";

const window = (key: string, remainingPercent: number) => ({
  key,
  label: key,
  remainingPercent,
  nextReset: null,
});

describe("thread usage", () => {
  it("shows the window with the least left, with every window for the hover", () => {
    const windows = [window("Session", 60), window("Weekly", 29)];
    const usage = summarizeThreadUsage(windows, null);
    expect(usage?.tightest.label).toBe("Weekly");
    expect(usage?.windows).toHaveLength(2);
    expect(summarizeThreadUsage([], null)).toBeNull();
  });

  it("turns amber below 20% left and red below 10%, as on the phone", () => {
    expect(usageTone(29).fill).toBe("bg-muted-foreground");
    expect(usageTone(18).fill).toBe("bg-amber-500");
    expect(usageTone(7).stroke).toBe("text-red-500");
  });
});
