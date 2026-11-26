import type { ReactElement } from "react";
import type { LiveActivityLayout } from "expo-widgets";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Image: "Image",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
  ZStack: "ZStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (value: unknown) => value;
  return {
    accessibilityElement: modifier,
    accessibilityLabel: modifier,
    activityBackgroundTint: modifier,
    containerBackground: modifier,
    font: modifier,
    foregroundStyle: modifier,
    frame: modifier,
    layoutPriority: modifier,
    lineLimit: modifier,
    minimumScaleFactor: modifier,
    padding: modifier,
    resizable: modifier,
    widgetURL: (url: string) => ({ widgetURL: url }),
  };
});

vi.mock("expo-widgets", () => ({
  createLiveActivity: (_name: string, layout: unknown) => layout,
  createWidget: (_name: string, layout: unknown) => layout,
}));

import AgentActivity, {
  type AgentActivityPhase,
  type AgentActivityProps,
  type AgentActivityRowProps,
} from "./AgentActivity";
import { AgentActivityWidget } from "./AgentActivityWidget";

const renderLiveActivity = AgentActivity as unknown as (
  props: AgentActivityProps,
  environment: unknown,
) => LiveActivityLayout;

function row(threadId: string, phase: AgentActivityPhase): AgentActivityRowProps {
  return {
    environmentId: "env-1",
    threadId,
    projectTitle: "Project",
    threadTitle: threadId,
    modelTitle: "Model",
    phase,
    status: phase,
    updatedAt: "2026-01-01T00:00:00.000Z",
    deepLink: `/threads/env-1/${threadId}`,
  };
}

function props(rows: ReadonlyArray<AgentActivityRowProps>): AgentActivityProps {
  return {
    title: "Agents",
    subtitle: "",
    activeCount: rows.filter((item) => item.phase !== "completed" && item.phase !== "failed")
      .length,
    updatedAt: "2026-01-01T00:00:00.000Z",
    activities: rows,
  };
}

function tapTarget(element: unknown): string | undefined {
  const modifiers = (element as ReactElement<{ modifiers?: ReadonlyArray<unknown> }>).props
    .modifiers;
  return modifiers
    ?.map((modifier) => (modifier as { widgetURL?: string } | undefined)?.widgetURL)
    .find((url) => url !== undefined);
}

function liveActivityTarget(rows: ReadonlyArray<AgentActivityRowProps>) {
  const layout = renderLiveActivity(props(rows), {
    colorScheme: "dark",
    isLuminanceReduced: false,
    isLiquidGlassAvailable: false,
    isStale: false,
    widgetRenderingMode: "fullColor",
  });
  return tapTarget(layout.banner);
}

function widgetTarget(rows: ReadonlyArray<AgentActivityRowProps>) {
  return tapTarget(
    AgentActivityWidget(props(rows), {
      widgetFamily: "systemMedium",
      widgetRenderingMode: "fullColor",
      colorScheme: "dark",
    } as never),
  );
}

describe.each([
  ["Live Activity", liveActivityTarget],
  ["widget", widgetTarget],
])("%s tap target", (_name, target) => {
  it("opens a thread waiting for you first", () => {
    expect(
      target([
        row("running", "running"),
        row("done", "completed"),
        row("input", "waiting_for_input"),
      ]),
    ).toBe("t3code://threads/env-1/input");
  });

  it("opens a finished thread before a running one", () => {
    expect(target([row("running", "running"), row("done", "completed")])).toBe(
      "t3code://threads/env-1/done",
    );
  });

  it("opens a running thread when nothing else is there", () => {
    expect(target([row("running", "running")])).toBe("t3code://threads/env-1/running");
  });
});
