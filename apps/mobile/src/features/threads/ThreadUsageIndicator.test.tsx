import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import type { UsageLimitDisplay } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  display: "remaining" as UsageLimitDisplay,
  indicatorEnabled: undefined as boolean | undefined,
  press: null as (() => void) | null,
}));

vi.mock("react-native", () => ({
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children: ReactNode;
    accessibilityLabel: string;
    onPress: () => void;
  }) => {
    state.press = onPress;
    return (
      <button type="button" aria-label={accessibilityLabel}>
        {children}
      </button>
    );
  },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-reanimated", () => {
  const transition = { duration: () => transition, reduceMotion: () => transition };
  return {
    default: { View: ({ children }: { children: ReactNode }) => <div>{children}</div> },
    FadeIn: transition,
    FadeOut: transition,
    ReduceMotion: { System: "system" },
  };
});
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/GlassSurface", () => ({
  GlassSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../lib/clock", () => ({
  useNowMinuteMs: () => Date.parse("2026-09-03T12:00:00.000Z"),
}));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    AsyncResult.success({
      usageLimitDisplay: state.display,
      threadUsageIndicatorEnabled: state.indicatorEnabled,
    }),
}));

import { ThreadUsageIndicator } from "./ThreadUsageIndicator";

const instanceId = ProviderInstanceId.make("claude");
const checkedAt = "2026-09-03T11:00:00.000Z";

function claude(windows: NonNullable<ServerProvider["usageLimits"]>["windows"]): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "me@example.com" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows },
  };
}

const limits = [
  { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
  { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 71 },
  {
    id: "seven_day_fable",
    kind: "weekly",
    label: "Weekly · Fable",
    usedPercent: 95,
    modelIds: ["claude-fable"],
  },
] as const;

function renderIndicator(provider: ServerProvider, onOpen = vi.fn()) {
  state.press = null;
  const markup = renderToStaticMarkup(
    <ThreadUsageIndicator
      serverConfig={{ providers: [provider], usageLimitSources: [] } as unknown as ServerConfig}
      modelSelection={{ instanceId, model: "claude-opus" }}
      top={100}
      onOpen={onOpen}
    />,
  );
  const text = markup.replace(/<[^>]+>/g, "");
  const label = markup.match(/aria-label="([^"]*)"/)?.[1] ?? null;
  return { text, label };
}

describe("ThreadUsageIndicator", () => {
  it("shows the thread's tightest limit and opens the full panel", () => {
    const onOpen = vi.fn<(report: UsageLimitsReport | null) => void>();
    const screen = renderIndicator(claude([...limits]), onOpen);

    // The Fable-only weekly limit does not hold back an Opus thread.
    expect(screen.text).toBe("Weekly29% left");
    expect(screen.label).toBe("Usage limits: Session 60% left, Weekly 29% left");
    state.press?.();
    expect(onOpen.mock.calls[0]![0]?.accounts.map((account) => account.instanceId)).toEqual([
      instanceId,
    ]);
  });

  it("reads as used when limits are shown as used", () => {
    using _display = {
      [Symbol.dispose]: () => {
        state.display = "remaining";
      },
    };
    state.display = "used";
    expect(renderIndicator(claude([...limits])).text).toBe("Weekly71% used");
  });

  it("stays hidden when turned off or when the account reports no limits", () => {
    using _enabled = {
      [Symbol.dispose]: () => {
        state.indicatorEnabled = undefined;
      },
    };
    state.indicatorEnabled = false;
    expect(renderIndicator(claude([...limits])).text).toBe("");

    state.indicatorEnabled = undefined;
    expect(renderIndicator(claude([])).text).toBe("");
  });
});
