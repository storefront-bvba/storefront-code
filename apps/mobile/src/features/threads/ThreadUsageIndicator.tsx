import { useAtomValue } from "@effect/atom-react";
import type { ModelSelection, ServerConfig, UsageLimitsReport } from "@t3tools/contracts";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import {
  limitPercentText,
  resetTimeText,
  resolveThreadLimits,
  shownPercent,
  threadLimitWindows,
} from "@t3tools/shared/usageLimitsDisplay";
import { AsyncResult } from "effect/reactivity";
import { useGT, useLocale, useMessages } from "gt-react-native";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { useNowMinuteMs } from "../../lib/clock";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useUsageLimitDisplay } from "../usage/useUsageLimitDisplay";

const ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

/**
 * The thread's tightest usage limit, in the top corner below the header. It reads the limits the
 * app already has for the thread's account (or its hub's pool) and opens the full panel on tap.
 */
export function ThreadUsageIndicator(props: {
  readonly serverConfig: ServerConfig | null;
  readonly modelSelection: ModelSelection;
  readonly top: number;
  readonly onOpen: (report: UsageLimitsReport | null) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const now = useNowMinuteMs();
  const display = useUsageLimitDisplay();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.threadUsageIndicatorEnabled !== false;
  const { instanceId, model } = props.modelSelection;
  const providers = props.serverConfig?.providers ?? [];
  const sources = props.serverConfig?.usageLimitSources ?? [];
  const windows = enabled
    ? threadLimitWindows(
        resolveThreadLimits(instanceId, model, providers, sources, now),
        model,
        now,
      )
    : [];
  const tightest = windows.reduce<(typeof windows)[number] | null>(
    (lowest, window) =>
      lowest === null || window.remainingPercent < lowest.remainingPercent ? window : lowest,
    null,
  );
  if (tightest === null) return null;
  const remaining = tightest.remainingPercent;
  // What is left right after the next reset, and when, always to the minute.
  const reset = tightest.nextReset
    ? `${shownPercent(tightest.nextReset.remainingPercent, display)}% ${resetTimeText(
        tightest.nextReset.at,
        now,
        locale,
        m,
      )}`
    : null;
  const tone =
    remaining <= 10 ? "bg-red-500" : remaining <= 20 ? "bg-amber-500" : "bg-foreground-muted";
  const open = () =>
    props.onOpen(collectProviderUsageLimits(instanceId, providers, sources, Date.now(), model));
  return (
    <Animated.View
      entering={ENTERING}
      exiting={EXITING}
      pointerEvents="box-none"
      className="absolute right-3 z-20"
      style={{ top: props.top }}
    >
      <GlassSurface style={{ borderRadius: reset ? 14 : 999 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${gt("Usage limits: {windows}", {
            windows: windows
              .map(
                (window) =>
                  `${window.label} ${limitPercentText(window.remainingPercent, display, m)}`,
              )
              .join(", "),
          })}${reset ? `, ${reset}` : ""}`}
          accessibilityHint={gt("Shows this thread's usage limits")}
          hitSlop={6}
          onPress={open}
          className={`${reset ? "py-1" : "h-7"} justify-center px-2.5 active:opacity-60`}
        >
          <View className="h-5 flex-row items-center gap-1.5">
            <View className="h-1 w-6 overflow-hidden rounded-full bg-subtle-strong">
              <View
                className={`h-full rounded-full ${tone}`}
                style={{ width: `${shownPercent(remaining, display)}%` }}
              />
            </View>
            <Text numberOfLines={1} className="text-xs text-foreground-muted">
              {tightest.label}
            </Text>
            <Text numberOfLines={1} className="text-xs font-t3-medium tabular-nums text-foreground">
              {limitPercentText(remaining, display, m)}
            </Text>
          </View>
          {reset ? (
            <Text
              numberOfLines={1}
              className="text-right text-xs tabular-nums text-foreground-muted"
            >
              {reset}
            </Text>
          ) : null}
        </Pressable>
      </GlassSurface>
    </Animated.View>
  );
}
