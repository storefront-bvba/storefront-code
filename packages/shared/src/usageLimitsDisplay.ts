import {
  EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import type { UsageLimitDisplay } from "@t3tools/contracts/settings";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  antigravityWindowLimitsModel,
  collectLimitAccounts,
  collectLimitPools,
  collectProviderUsageLimits,
  displayLimitWindows,
  elapsedShare,
  hubRoutes,
  instanceHubs,
  type LimitPoolMember,
  type LimitPoolWindow,
  remainingPercent,
} from "./usageLimits.ts";
import { limitsNotice } from "./usageLimitsCopy.ts";

export type { UsageLimitDisplay };

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

/**
 * A percentage of quota or time left as the display reads it: unchanged for "remaining", the
 * share used or elapsed for "used". Bars, numbers and pace marks all flip through this.
 */
export function shownPercent(remaining: number, display: UsageLimitDisplay): number {
  return display === "used" ? 100 - remaining : remaining;
}

/** "40% left" or "60% used". */
export function limitPercentText(
  remaining: number,
  display: UsageLimitDisplay,
  resolve: MFunctionType = mFallback,
): string {
  return display === "used"
    ? resolve(msg("{used}% used", { used: 100 - remaining }))
    : resolve(msg("{remaining}% left", { remaining }));
}

/** How much of the window's time is left, or has passed when limits read as used. */
export function limitWindowTimeText(
  timeLeft: number,
  display: UsageLimitDisplay,
  resolve: MFunctionType = mFallback,
): string {
  return display === "used"
    ? resolve(msg("{elapsed}% of the window passed", { elapsed: 100 - timeLeft }))
    : resolve(msg("{timeLeft}% of the window left", { timeLeft }));
}

/** Where even spending would stand by now. */
export function limitEvenPaceText(
  timeLeft: number,
  display: UsageLimitDisplay,
  resolve: MFunctionType = mFallback,
): string {
  return display === "used"
    ? resolve(msg("{elapsed}% used by now", { elapsed: 100 - timeLeft }))
    : resolve(msg("{timeLeft}% left by now", { timeLeft }));
}

/** A limit's quota and time, as one line. */
export function limitPercentWithTimeText(
  remaining: number,
  timeLeft: number | null,
  display: UsageLimitDisplay,
  resolve: MFunctionType = mFallback,
): string {
  if (timeLeft === null) return limitPercentText(remaining, display, resolve);
  return display === "used"
    ? resolve(
        msg("{used}% used · {elapsed}% of the window passed", {
          used: 100 - remaining,
          elapsed: 100 - timeLeft,
        }),
      )
    : resolve(msg("{remaining}% left · {timeLeft}% of the window left", { remaining, timeLeft }));
}

/** A limit window read aloud: its label, quota, time and reset. */
export function limitWindowSummary(
  input: {
    readonly label: string;
    readonly remaining: number;
    readonly timeLeft: number | null;
    readonly resetsIn: string | null;
  },
  display: UsageLimitDisplay,
  resolve: MFunctionType = mFallback,
): string {
  const { label, remaining, timeLeft, resetsIn } = input;
  if (display === "used") {
    const used = 100 - remaining;
    if (timeLeft === null) {
      return resetsIn
        ? resolve(msg("{label}: {used}% used, {resetsIn}", { label, used, resetsIn }))
        : resolve(msg("{label}: {used}% used", { label, used }));
    }
    const elapsed = 100 - timeLeft;
    return resetsIn
      ? resolve(
          msg("{label}: {used}% used, {elapsed}% of the window passed, {resetsIn}", {
            label,
            used,
            elapsed,
            resetsIn,
          }),
        )
      : resolve(
          msg("{label}: {used}% used, {elapsed}% of the window passed", { label, used, elapsed }),
        );
  }
  if (timeLeft === null) {
    return resetsIn
      ? resolve(msg("{label}: {remaining}% left, {resetsIn}", { label, remaining, resetsIn }))
      : resolve(msg("{label}: {remaining}% left", { label, remaining }));
  }
  return resetsIn
    ? resolve(
        msg("{label}: {remaining}% left, {timeLeft}% of the window left, {resetsIn}", {
          label,
          remaining,
          timeLeft,
          resetsIn,
        }),
      )
    : resolve(
        msg("{label}: {remaining}% left, {timeLeft}% of the window left", {
          label,
          remaining,
          timeLeft,
        }),
      );
}

/** One account's part of a pooled meter, in percent of the whole meter. */
export interface PoolMeterPiece {
  readonly member: LimitPoolMember;
  /** The account's column number, shared with its legend row and its column in other windows. */
  readonly index: number;
  readonly start: number;
  readonly width: number;
}

export interface PoolMeter {
  readonly pieces: readonly PoolMeterPiece[];
  /** What each account's next reset gives back, placed after the fill. */
  readonly refills: readonly PoolMeterPiece[];
  /** Where the fill would stand if every account had spent at even pace. */
  readonly paceMark: number | null;
}

/**
 * Lays a pool window out as one meter: each account adds what it has left (or has used) times its
 * share of the pool's capacity, so the fill ends at the pool's percentage.
 */
export function poolMeter(
  window: LimitPoolWindow,
  now: number,
  display: UsageLimitDisplay = "remaining",
): PoolMeter {
  const withReset = new Set(window.resets.map((reset) => reset.member));
  const share = (member: LimitPoolMember) => window.shares.get(member.account.key) ?? 0;
  const pieces: PoolMeterPiece[] = [];
  let end = 0;
  window.columns.forEach((column, position) => {
    if (!column.window) return;
    const member = column as LimitPoolMember;
    const left = 100 - clampPercent(member.window.usedPercent);
    const width = share(member) * shownPercent(left, display);
    pieces.push({ member, index: position + 1, start: end, width });
    end += width;
  });
  const refills: PoolMeterPiece[] = [];
  // Read as used, a reset gives back nearly all of the fill, so hatching it would only add noise.
  for (const piece of display === "used" ? [] : pieces) {
    const { member } = piece;
    if (!withReset.has(member)) continue;
    const used = clampPercent(member.window.usedPercent);
    const width = share(member) * Math.min(used, clampPercent(member.refillPercent));
    if (width <= 0) continue;
    refills.push({ ...piece, start: end, width });
    end += width;
  }
  const elapsed = pieces.map((piece) => elapsedShare(piece.member.window, now));
  const paceMark = elapsed.every((value) => value !== null)
    ? pieces.reduce((sum, piece, index) => sum + share(piece.member) * (1 - elapsed[index]!), 0) *
      100
    : null;
  return {
    pieces,
    refills,
    paceMark: pieces.length > 0 && paceMark !== null ? shownPercent(paceMark, display) : null,
  };
}

export type ThreadLimits =
  | { readonly kind: "instance"; readonly limits: ServerProviderUsageLimits }
  | { readonly kind: "pool"; readonly windows: readonly LimitPoolWindow[] };

// collectLimitAccounts keys its input by environment; the card reads one, so any id serves.
const CARD_ENVIRONMENT = EnvironmentId.make("thread-details");

/** The limits a thread spends from: its instance's own, or the pool its hub routes the model to. */
export function resolveThreadLimits(
  providerInstanceId: ProviderInstanceId | null,
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadLimits | null {
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  if (!provider) return null;
  const report = collectProviderUsageLimits(provider.instanceId, providers, sources, now, model);
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const own =
    report?.accounts.find((entry) => entry.instanceId === provider.instanceId)?.limits ??
    provider.usageLimits;
  if (!own) return null;
  const hubs = instanceHubs(provider, sources);
  if (limitsNotice(own) === null || hubs.length === 0) return { kind: "instance", limits: own };
  // An instance sent to a hub reads no limits of its own; its hub pools the accounts it spends.
  return hubPool(provider.driver, model, providers, hubs, now) ?? { kind: "instance", limits: own };
}

function hubPool(
  driver: ServerProvider["driver"],
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadLimits | null {
  const routes = hubRoutes(sources, driver, model);
  const routed = sources.map((source) => ({
    ...source,
    accounts: source.accounts.filter(routes).map((account) =>
      account.driver === "antigravity"
        ? {
            ...account,
            usageLimits: {
              ...account.usageLimits,
              windows: account.usageLimits.windows.filter((window) =>
                antigravityWindowLimitsModel(window, model),
              ),
            },
          }
        : account,
    ),
  }));
  const readable = routed
    .flatMap((source) => source.accounts)
    .filter((account) => limitsNotice(account.usageLimits) === null);
  if (readable.length === 0) return null;
  // A signed-in login joins the pool only as a fresher reading of an account the hub routes to.
  const signedIn = providers.filter((provider) =>
    readable.some(
      (account) =>
        account.driver === provider.driver &&
        account.workspaceId === provider.auth.workspaceId &&
        account.email !== undefined &&
        account.email.toLowerCase() === provider.auth.email?.toLowerCase(),
    ),
  );
  const presentations = new Map([
    [
      CARD_ENVIRONMENT,
      {
        entry: { target: { label: "" } },
        serverConfig: { providers: signedIn, usageLimitSources: routed },
      },
    ],
  ]);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  return pools.length > 0 ? { kind: "pool", windows: pools.flatMap(displayLimitWindows) } : null;
}

export interface ThreadLimitWindow {
  readonly key: string;
  readonly label: string;
  readonly remainingPercent: number;
}

const countsModel = (window: ServerProviderUsageWindow, model: string | null) =>
  model === null ||
  ((window.modelIds === undefined || window.modelIds.includes(model)) &&
    (window.providerIds === undefined || window.providerIds.includes(model.split("/")[0] ?? "")));

/** The windows a thread's next turn spends from, in display order; model-only windows of other models drop out. */
export function threadLimitWindows(
  limits: ThreadLimits | null,
  model: string | null,
): readonly ThreadLimitWindow[] {
  if (limits === null) return [];
  if (limits.kind === "pool") {
    return limits.windows
      .filter((window) => window.members.some((member) => countsModel(member.window, model)))
      .map((window) => ({
        key: `${window.kind}:${window.id}`,
        label: window.label,
        remainingPercent: window.remainingPercent,
      }));
  }
  if (limitsNotice(limits.limits) !== null) return [];
  return limits.limits.windows
    .filter((window) => countsModel(window, model))
    .map((window) => ({
      key: `${window.kind}:${window.id}`,
      label: window.label,
      remainingPercent: remainingPercent(window),
    }));
}
