// Storefront Code (fork): the open thread's usage limits for the sidebar strip and, without a
// sidebar, the composer ring (F4, fork/GOAL-CURRENT-STATUS.md). ChatView publishes what its thread
// spends from; both read it here. Only a change in the limits republishes, not every ChatView render.
import type {
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  resolveThreadLimits,
  type ThreadLimitWindow,
  threadLimitWindows,
} from "@t3tools/shared/usageLimitsDisplay";
import { useEffect, useSyncExternalStore } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";

export interface ThreadUsage {
  readonly windows: readonly ThreadLimitWindow[];
  /** The window with the least left: what the strip and the ring show. */
  readonly tightest: ThreadLimitWindow;
  /** Opens the thread's usage panel; null once its ChatView is gone (then: the Usage page). */
  readonly open: (() => void) | null;
}

function createStore<A>(initial: A) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: A) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const usageStore = createStore<ThreadUsage | null>(null);
const stripVisibleStore = createStore(false);

/** The tightest window and every window the thread's model counts against; null without limits. */
export function summarizeThreadUsage(
  windows: readonly ThreadLimitWindow[],
  open: (() => void) | null,
): ThreadUsage | null {
  const tightest = windows.reduce<ThreadLimitWindow | null>(
    (lowest, window) =>
      lowest === null || window.remainingPercent < lowest.remainingPercent ? window : lowest,
    null,
  );
  return tightest === null ? null : { windows, tightest, open };
}

/** Grey, amber below 20% left, red below 10%, as on the phone. Literal classes for Tailwind. */
export function usageTone(remainingPercent: number) {
  if (remainingPercent <= 10) return { fill: "bg-red-500", stroke: "text-red-500" };
  if (remainingPercent <= 20) return { fill: "bg-amber-500", stroke: "text-amber-500" };
  return { fill: "bg-muted-foreground", stroke: "text-muted-foreground" };
}

export function usePublishThreadUsage(input: {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly open: () => void;
}) {
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const windows = threadLimitWindows(
    resolveThreadLimits(input.providerInstanceId, input.model, input.providers, input.sources, now),
    input.model,
    now,
  );
  const key = JSON.stringify(windows);
  const { open } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes to the store the sidebar strip and composer ring read
  useEffect(() => {
    usageStore.set(summarizeThreadUsage(JSON.parse(key) as ThreadLimitWindow[], open));
  }, [key, open]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a closed thread view can no longer open its panel
  useEffect(
    () => () => {
      const current = usageStore.get();
      if (current?.open === open) usageStore.set({ ...current, open: null });
    },
    [open],
  );
}

export function useThreadUsage(): ThreadUsage | null {
  return useSyncExternalStore(usageStore.subscribe, usageStore.get, usageStore.get);
}

/** The sidebar strip says whether it is on screen; the composer ring only shows when it is not. */
export function useReportUsageStripVisible(visible: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the composer ring whether the sidebar strip shows
  useEffect(() => {
    stripVisibleStore.set(visible);
    return () => stripVisibleStore.set(false);
  }, [visible]);
}

export function useUsageStripVisible(): boolean {
  return useSyncExternalStore(
    stripVisibleStore.subscribe,
    stripVisibleStore.get,
    stripVisibleStore.get,
  );
}
