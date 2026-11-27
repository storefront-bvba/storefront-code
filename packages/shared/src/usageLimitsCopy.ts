import type {
  ProviderConsumeResetCreditInput,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  collectExternalUsageLinks as collectExternalUsageLinksWith,
  cursorUsageWindowDetails as cursorUsageWindowDetailsBase,
  type LimitPool,
  type LimitPresentations,
  providersWithLimits,
  type ResetCreditChoice,
  resetCountdown,
  unshownFailedHubAccounts,
} from "./usageLimits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CURSOR_USAGE_WINDOW_COPY: Readonly<
  Record<string, { readonly label: string; readonly description: string }>
> = {
  totalPercentUsed: {
    label: msg("Overall", { $context: "usage limit covering the whole plan" }),
    description: msg("All usage on your plan this billing cycle."),
  },
  autoPercentUsed: {
    label: msg("Cursor Models"),
    description: msg("Grok, Composer, and Auto use this allowance."),
  },
  apiPercentUsed: {
    label: msg("Other Models"),
    description: msg("Usage allowance for third-party models such as Claude, GPT, and Gemini."),
  },
};

/** @public */
export function cursorUsageWindowDetails(
  id: string,
  pool: LimitPool,
  resolve: MFunctionType = mFallback,
) {
  const details = cursorUsageWindowDetailsBase(id, pool);
  const copy = CURSOR_USAGE_WINDOW_COPY[id];
  if (!details || !copy) return details;
  return {
    ...details,
    label: details.label === null ? null : resolve(copy.label),
    description: details.description === undefined ? undefined : resolve(copy.description),
  };
}

/** @public */
export function collectExternalUsageLinks(
  presentations: LimitPresentations,
  resolve: MFunctionType = mFallback,
) {
  return collectExternalUsageLinksWith(presentations, (provider, environment) =>
    resolve(msg("{provider} on {environment}", { provider, environment })),
  );
}

/** @public */
export function limitsNotice(
  limits: ServerProviderUsageLimits,
  resolve: MFunctionType = mFallback,
): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? resolve(msg("This account has no subscription limits."));
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? resolve(msg("Could not read limits."));
  }
  return limits.windows.length === 0 ? resolve(msg("No limits reported.")) : null;
}

/** @public */
export function collectLimitNotices(
  presentations: LimitPresentations,
  resolve: MFunctionType = mFallback,
): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const notices = new Set<string>();
  // A failed hub read needs no notice when another report already shows the account's row.
  const failedAccounts = unshownFailedHubAccounts(presentations);
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const limits = provider.usageLimits;
      // A bare unsupported means the account has no limits; an external usage link shows its message.
      if (
        limits?.unavailable?.reason === "unsupported" &&
        (!limits.unavailable.message || limits.externalUsage)
      ) {
        continue;
      }
      const notice = limits ? limitsNotice(limits, resolve) : null;
      const name = provider.displayName?.trim() || String(provider.driver);
      if (notice) notices.add(`${label(environmentLabel, name)}: ${notice}`);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.add(`${label(environmentLabel, source.label)}: ${source.error}`);
      } else if (
        (source.kind === "http" ? (source.quotaAccounts?.length ?? 0) : source.accounts.length) ===
        0
      ) {
        notices.add(
          resolve(
            msg("{source}: No accounts reported.", {
              source: label(environmentLabel, source.label),
            }),
          ),
        );
      }
      for (const account of source.accounts) {
        const name = failedAccounts.get(account);
        if (name === undefined) continue;
        const notice = limitsNotice(account.usageLimits, resolve);
        notices.add(`${label(environmentLabel, source.label)} · ${name}: ${notice}`);
      }
    }
  }
  return [...notices];
}

/** @public */
export function formatDuration(ms: number, resolve: MFunctionType = mFallback): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return resolve(msg("{days}d {hours}h", { days, hours }));
  if (hours > 0) return resolve(msg("{hours}h {minutes}m", { hours, minutes }));
  return resolve(msg("{minutes}m", { minutes }));
}

/** @public */
export function resetCreditChoices(
  credits: ServerProviderResetCredits,
  input: ProviderConsumeResetCreditInput,
  now: number,
  compact = false,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<ResetCreditChoice> {
  const expiresIn = (at: string | undefined) =>
    at ? formatDuration(Date.parse(at) - now, resolve) : null;
  if (credits.options && "instanceId" in input) {
    return credits.options.map((option) => {
      const expires = expiresIn(option.expiresAt);
      const values = { label: option.label, count: option.availableCount };
      return {
        key: option.creditId,
        summary: expires
          ? resolve(msg("{label} · {count} left · expires in {expires}", { ...values, expires }))
          : resolve(msg("{label} · {count} left", values)),
        actionLabel: resolve(msg("Use", { $context: "button that redeems a reset credit" })),
        confirmDescription: resolve(
          msg("{label}: {description} This cannot be undone.", {
            label: option.label,
            description: option.description,
          }),
        ),
        availableCount: option.availableCount,
        input: { ...input, creditId: option.creditId },
      };
    });
  }
  const count = credits.availableCount;
  const expires = expiresIn(credits.nextExpiresAt);
  return [
    {
      key: "next",
      summary:
        count === 0
          ? resolve(msg("No reset credits banked"))
          : compact
            ? expires
              ? resolve(msg("{count} banked · expires in {expires}", { count, expires }))
              : resolve(msg("{count} banked", { count }))
            : expires
              ? resolve(
                  msg(
                    "{count, plural, one {{count} reset credit banked · next expires in {expires}} other {{count} reset credits banked · next expires in {expires}}}",
                    { count, expires },
                  ),
                )
              : resolve(
                  msg(
                    "{count, plural, one {{count} reset credit banked} other {{count} reset credits banked}}",
                    { count },
                  ),
                ),
      actionLabel: resolve(msg("Use reset")),
      confirmDescription: resolve(
        msg(
          "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
        ),
      ),
      availableCount: count,
      input,
    },
  ];
}

/**
 * When a limit resets, as a clock time and never a countdown, always to the minute: "at 20:00"
 * today, else the weekday and time ("Monday 18:00"), with the date from six days out. 24-hour.
 */
export function resetTimeText(
  at: number,
  now: number,
  locale?: string,
  resolve: MFunctionType = mFallback,
): string {
  const clock = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  const day = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  if (day.format(at) === day.format(now)) {
    const time = new Intl.DateTimeFormat(locale, clock).format(at);
    return resolve(msg("at {time}", { time, $context: "a usage limit resets today at this time" }));
  }
  const nearby = at - now < 6 * DAY;
  return new Intl.DateTimeFormat(locale, {
    weekday: nearby ? "long" : "short",
    ...(nearby ? {} : { day: "numeric", month: "short" }),
    ...clock,
  }).format(at);
}

/**
 * `full` reads "resets at 20:00", `in` reads "at 20:00", `refill` reads "↻ at 20:00"; further
 * out the weekday ("resets Monday 18:00"). Storefront Code (fork): a clock time to the minute,
 * never a countdown (Wouter, 2026-11-27).
 * @public
 */
export function formatResetsIn(
  window: ServerProviderUsageWindow,
  now: number,
  resolve: MFunctionType = mFallback,
  style: "full" | "in" | "refill" = "full",
): string | null {
  const countdown = resetCountdown(window, now);
  if (countdown === null) return null;
  if (countdown.kind === "now") return resolve(msg("resets now"));
  if (countdown.kind === "momentarily") return resolve(msg("Resets momentarily"));
  const when = resetTimeText(now + countdown.ms, now, undefined, resolve);
  if (style === "in") return when;
  if (style === "refill") return resolve(msg("↻ {when}", { when }));
  return resolve(msg("resets {when}", { when, $context: "when a usage window resets" }));
}
