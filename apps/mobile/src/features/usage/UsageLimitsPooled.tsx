import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  collectHttpQuotaSources,
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  paceRemainingPercent,
  remainingPercent,
  type LimitAccount,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import {
  collectExternalUsageLinks,
  collectLimitNotices,
  cursorUsageWindowDetails,
} from "@t3tools/shared/usageLimitsCopy";
import { poolMeter, type PoolMeterPiece } from "@t3tools/shared/usageLimitsDisplay";
import { msg, T, useGT, useMessages, Var } from "gt-react-native";
import { Fragment, useId, useState } from "react";
import { Pressable, View } from "react-native";
import { useNowMinuteMs } from "../../lib/clock";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { Defs, Path, Pattern, Rect, Svg } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { MessageResolver } from "../../i18n/messages";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { environmentPresentations } from "../../state/presentation";
import { refillLabel, ResetCredits, resetLabels } from "./UsageLimitsSection";
import { usageProviderKind, useProviderColors } from "./usageProviders";

const PACE_LABEL = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
} as const;

function accountName(account: LimitAccount, resolve: MessageResolver) {
  if (account.displayName) return account.displayName;
  if (!account.email) return providerClients.get(account.driver)?.label ?? account.driver;
  return (
    emailInitials(account.email) || resolve(msg("Account", { $context: "fallback account name" }))
  );
}

function emailInitials(email: string) {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase();
}

// What each account's next reset restores, hatched in that account's color.
function MeterHatches({
  refills,
  colorOf,
}: {
  readonly refills: readonly PoolMeterPiece[];
  readonly colorOf: (account: LimitAccount) => string;
}) {
  const patternId = useId().replace(/:/g, "");
  const [size, setSize] = useState({ width: 0, height: 0 });
  return (
    <View
      pointerEvents="none"
      className="absolute inset-0"
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
      }}
    >
      {size.width > 0 && size.height > 0 && refills.length > 0 ? (
        // Numeric canvas dimensions clear Android SVG geometry cached before a segment resized.
        <Svg width={size.width} height={size.height} accessible={false}>
          <Defs>
            {refills.map((refill, index) => (
              <Pattern
                key={refill.member.account.key}
                id={`${patternId}-${index}`}
                width={6}
                height={6}
                patternUnits="userSpaceOnUse"
              >
                <Path
                  d="M-1 1L1 -1M0 6L6 0M5 7L7 5"
                  stroke={colorOf(refill.member.account)}
                  strokeWidth={1}
                  opacity={0.22}
                />
              </Pattern>
            ))}
          </Defs>
          {refills.map((refill, index) => (
            <Rect
              key={refill.member.account.key}
              x={`${refill.start}%`}
              width={`${refill.width}%`}
              height="100%"
              fill={`url(#${patternId}-${index})`}
            />
          ))}
        </Svg>
      ) : null}
    </View>
  );
}

function PoolWindowCard({
  pool,
  color,
  now,
  environmentIds,
  label,
  description,
  wide,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
  readonly label?: string | null;
  readonly description?: string;
  readonly wide: boolean;
}) {
  const navigation = useNavigation();
  const gt = useGT();
  const m = useMessages();
  const [barWidth, setBarWidth] = useState(0);
  const meter = poolMeter(pool, now);
  const colorOf = (account: LimitAccount) =>
    normalizeProviderAccentColor(account.accentColor) ?? color;
  // The pace tick sits in a card-colored slot, which reads as a gap cut from the meter.
  const tickX =
    meter.paceMark === null || barWidth < 6
      ? null
      : Math.min(Math.max((barWidth * meter.paceMark) / 100, 3), barWidth - 3);
  const nextRefill = pool.resets.find((reset) => reset.at > now && reset.restoresPercent > 0);
  const openAccount = (account: LimitAccount) =>
    navigation.navigate("SettingsUsageAccount", {
      accountKey: account.key,
      windowId: pool.id,
      windowKind: pool.kind,
      environmentIds,
    });
  const summary = (
    <>
      <View className={wide ? "gap-1" : "flex-row items-start justify-between gap-3"}>
        <View className="gap-1">
          {label !== null ? (
            <Text className="text-sm font-t3-medium text-foreground">{label ?? pool.label}</Text>
          ) : null}
          <View className="flex-row items-baseline gap-1.5">
            <Text className="text-sm leading-(--text-3xl--line-height) text-foreground-muted">
              <T>
                <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
                  <Var>{pool.remainingPercent}</Var>%
                </Text>{" "}
                left
              </T>
            </Text>
          </View>
        </View>
        {pool.pace ? (
          <Text className="text-xs text-foreground-tertiary">{m(PACE_LABEL[pool.pace])}</Text>
        ) : null}
      </View>
      {description ? <Text className="text-xs text-foreground-muted">{description}</Text> : null}
      {nextRefill ? (
        <Text className="text-xs tabular-nums text-foreground-muted">
          {refillLabel(nextRefill.member.window, now, nextRefill.restoresPercent, m)}
        </Text>
      ) : null}
    </>
  );
  // One meter for the pool: each account fills its share of what is left, numbered like its row.
  const bar = (
    <View
      className={wide ? "h-9" : "h-7"}
      onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}
    >
      <View className="absolute inset-0 overflow-hidden rounded-md bg-subtle">
        {meter.pieces.map(({ member: { account, window }, index, start, width }) => {
          if (width <= 0) return null;
          const timeLeft = paceRemainingPercent(window, now);
          return (
            <Pressable
              key={account.key}
              accessibilityRole="button"
              accessibilityLabel={
                timeLeft === null
                  ? gt("Segment {index}, {account}, {remaining}% left", {
                      index,
                      account: accountName(account, m),
                      remaining: remainingPercent(window),
                    })
                  : gt(
                      "Segment {index}, {account}, {remaining}% left, {timeLeft}% of the window left",
                      {
                        index,
                        account: accountName(account, m),
                        remaining: remainingPercent(window),
                        timeLeft,
                      },
                    )
              }
              accessibilityHint={gt("Show account details")}
              onPress={() => openAccount(account)}
              className="absolute top-0 bottom-0 items-center justify-center"
              style={{ left: `${start}%`, width: `${width}%` }}
            >
              {/* Pieces after the first start 2pt in, so neighbouring accounts read apart. */}
              <View
                pointerEvents="none"
                className="absolute top-0 right-0 bottom-0"
                style={{
                  left: start > 0 ? 2 : 0,
                  backgroundColor: colorOf(account),
                  opacity: 0.35,
                }}
              />
              {(barWidth * width) / 100 >= 18 ? (
                <Text
                  numberOfLines={1}
                  className="text-xs font-t3-medium tabular-nums text-foreground"
                >
                  {index}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
        <MeterHatches refills={meter.refills} colorOf={colorOf} />
      </View>
      {tickX !== null ? (
        <View
          pointerEvents="none"
          className="absolute top-0 bottom-0 w-1.5 bg-grouped-card"
          style={{ left: tickX - 3 }}
        >
          <View className="absolute top-0.5 bottom-0.5 left-0.5 w-0.5 rounded-full bg-foreground" />
        </View>
      ) : null}
    </View>
  );
  const legend = (
    <View>
      {pool.columns.map(({ account, window }, index) => {
        if (!window) return null;
        const segmentColor = colorOf(account);
        const credits = account.limits.resetCredits?.availableCount ?? 0;
        const reset = resetLabels(window, now, m);
        const resetsIn = reset?.full;
        return (
          <Pressable
            key={account.key}
            accessibilityRole="button"
            accessibilityLabel={
              resetsIn && credits
                ? gt(
                    "Segment {index}, {account}, {remaining}% left, {resetsIn}, {credits, plural, other {{credits} reset credits banked}}",
                    {
                      index: index + 1,
                      account: accountName(account, m),
                      remaining: remainingPercent(window),
                      resetsIn,
                      credits,
                    },
                  )
                : resetsIn
                  ? gt("Segment {index}, {account}, {remaining}% left, {resetsIn}", {
                      index: index + 1,
                      account: accountName(account, m),
                      remaining: remainingPercent(window),
                      resetsIn,
                    })
                  : credits
                    ? gt(
                        "Segment {index}, {account}, {remaining}% left, {credits, plural, other {{credits} reset credits banked}}",
                        {
                          index: index + 1,
                          account: accountName(account, m),
                          remaining: remainingPercent(window),
                          credits,
                        },
                      )
                    : gt("Segment {index}, {account}, {remaining}% left", {
                        index: index + 1,
                        account: accountName(account, m),
                        remaining: remainingPercent(window),
                      })
            }
            accessibilityHint={gt("Show account details")}
            onPress={() => openAccount(account)}
            className="min-h-[44px] flex-row items-center gap-2 active:opacity-60"
          >
            <View className="relative size-5 items-center justify-center overflow-hidden rounded-md bg-subtle-strong">
              <View
                pointerEvents="none"
                className="absolute inset-0"
                style={{ backgroundColor: segmentColor, opacity: 0.35 }}
              />
              <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                {index + 1}
              </Text>
            </View>
            <Text
              numberOfLines={1}
              className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
            >
              {accountName(account, m)}
            </Text>
            <Text className="text-sm font-t3-medium tabular-nums text-foreground">
              {remainingPercent(window)}%
            </Text>
            <View className="flex-row items-center gap-1">
              {resetsIn ? (
                <>
                  <SymbolView
                    name="arrow.clockwise"
                    size={12}
                    tintColorClassName="accent-foreground-muted"
                  />
                  <Text className="text-xs tabular-nums text-foreground-muted">
                    {reset?.compact}
                  </Text>
                </>
              ) : null}
              {credits ? (
                <>
                  {resetsIn ? <Text className="text-xs text-foreground-tertiary">·</Text> : null}
                  <SymbolView name="ticket" size={13} tintColorClassName="accent-icon" />
                  <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                    {credits}
                  </Text>
                </>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
  if (wide) {
    return (
      <View className="flex-row items-center gap-6 rounded-[24px] border-continuous bg-grouped-card p-4">
        <View className="w-44 gap-1">{summary}</View>
        <View className="min-w-0 flex-1 gap-1">
          {bar}
          {legend}
        </View>
      </View>
    );
  }
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
      {summary}
      {bar}
      {legend}
    </View>
  );
}

export function UsageLimitsSection({
  now,
  failedLabels,
  selectedEnvironmentIds,
  wide = false,
}: {
  readonly now: number;
  readonly failedLabels: readonly string[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly wide?: boolean;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const selected =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  const pools = collectLimitPools(collectLimitAccounts(selected), now);
  const quotaSources = collectHttpQuotaSources(selected);
  const m = useMessages();
  const notices = collectLimitNotices(selected, m);
  const externalLinks = collectExternalUsageLinks(selected, m);
  const colors = useProviderColors();
  const gt = useGT();
  return (
    <View className="gap-6">
      {pools.length === 0 &&
      notices.length === 0 &&
      failedLabels.length === 0 &&
      externalLinks.length === 0 &&
      quotaSources.length === 0 ? (
        <Text className="py-12 text-center text-base text-foreground-muted">
          {selected.size === 0
            ? gt("Select an environment to see limits.")
            : gt("No provider on the selected environments reports subscription limits.")}
        </Text>
      ) : null}
      {quotaSources.map((source) => (
        <View key={source.key} className="gap-3 rounded-[24px] bg-grouped-card p-4">
          <Text className="text-base font-t3-medium text-foreground">{source.label}</Text>
          {source.quotaAccounts?.map((account) => (
            <View key={account.id} className="gap-1">
              <Text className="text-sm font-t3-medium text-foreground">{account.label}</Text>
              {account.windows.map((window) => {
                const reset = resetLabels(window, now, m);
                return (
                  <View key={window.id} className="flex-row justify-between gap-3">
                    <Text className="shrink text-sm text-foreground-muted">{window.label}</Text>
                    <Text className="text-sm text-foreground-muted">
                      {gt("{remaining}% left", { remaining: remainingPercent(window) })}
                      {reset ? ` · ${reset.compact}` : ""}
                    </Text>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      ))}
      {pools.map((pool) => {
        const windows = displayLimitWindows(pool);
        return (
          <Fragment key={pool.driver}>
            <View className="gap-3">
              <View className="flex-row items-center gap-2 px-1">
                <ProviderIcon provider={pool.driver} size={18} />
                <Text className="text-base font-t3-medium text-foreground">
                  {providerClients.get(pool.driver)?.label ?? pool.driver}
                </Text>
              </View>
              {windows.map((window) => {
                const details =
                  pool.driver === "cursor"
                    ? cursorUsageWindowDetails(window.id, pool, m)
                    : undefined;
                return (
                  <PoolWindowCard
                    key={`${window.kind}:${window.id}`}
                    pool={window}
                    color={colors[usageProviderKind(pool.driver) ?? "codex"]}
                    now={now}
                    environmentIds={
                      selectedEnvironmentIds === null ? null : [...selectedEnvironmentIds]
                    }
                    label={details?.label}
                    description={details?.description}
                    wide={wide}
                  />
                );
              })}
            </View>
          </Fragment>
        );
      })}
      {externalLinks.map((link) => (
        <View key={link.url} className="gap-3 rounded-xl border border-border-subtle p-4">
          <Text className="text-base font-t3-medium text-foreground">{link.label}</Text>
          <Text className="text-xs text-foreground-muted">{link.accounts.join(", ")}</Text>
          {link.message ? (
            <Text className="text-sm text-foreground-muted">{link.message}</Text>
          ) : null}
          <Pressable
            accessibilityRole="link"
            className="min-h-11 justify-center"
            onPress={() => void tryOpenExternalUrl(link.url)}
          >
            <Text className="text-sm font-t3-medium text-primary">
              <T>Manage usage</T>
            </Text>
          </Pressable>
        </View>
      ))}
      {notices.length > 0 || failedLabels.length > 0 ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="flex-row items-start gap-2 rounded-xl border border-warning-border bg-warning px-3.5 py-3"
        >
          <SymbolView
            name="exclamationmark.triangle"
            size={16}
            tintColorClassName="accent-warning-foreground"
          />
          <View className="min-w-0 flex-1 gap-0.5">
            {notices.map((notice) => (
              <Text key={notice} className="text-sm font-t3-medium text-warning-foreground">
                {notice}
              </Text>
            ))}
            {failedLabels.length > 0 ? (
              <Text className="text-sm font-t3-medium text-warning-foreground">
                <T>
                  <Var>{failedLabels.join(", ")}</Var> could not refresh limits. Showing the last
                  known values.
                </T>
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

type AccountScreenProps = StaticScreenProps<{
  accountKey: string;
  windowId: string;
  windowKind: LimitPoolWindow["kind"];
  environmentIds: readonly string[] | null;
}>;

export function UsageLimitAccountScreen({ route }: AccountScreenProps) {
  const insets = useSafeAreaInsets();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const { accountKey, windowId, windowKind, environmentIds } = route.params;
  const now = useNowMinuteMs();
  const selectedIds =
    environmentIds === null ? null : new Set(environmentIds.map((id) => EnvironmentId.make(id)));
  const selected =
    selectedIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedIds.has(id)));
  const accounts = collectLimitAccounts(selected);
  const account = accounts.find((candidate) => candidate.key === accountKey);
  const pool = collectLimitPools(accounts, now)
    .find((candidate) => candidate.driver === account?.driver)
    ?.windows.find((candidate) => candidate.id === windowId && candidate.kind === windowKind);
  const window = pool?.members.find((member) => member.account.key === accountKey)?.window;
  const evenPace = window ? paceRemainingPercent(window, now) : null;
  const reset = pool?.resets.find((candidate) => candidate.member.account.key === accountKey);
  const [revealed, setRevealed] = useState(false);
  const gt = useGT();
  return (
    <SettingsScreen title={gt("Account", { $context: "screen title" })}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {!account || !window ? (
          <Text className="text-base text-foreground-muted">
            <T>This account is no longer reporting limits on the selected environments.</T>
          </Text>
        ) : (
          <>
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <ProviderIcon provider={account.driver} size={24} />
                <Text className="flex-1 text-xl font-t3-bold text-foreground">
                  {account.displayName ??
                    providerClients.get(account.driver)?.label ??
                    account.driver}
                </Text>
              </View>
              {account.email ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    revealed ? gt("Hide account email") : gt("Reveal account email")
                  }
                  onPress={() => setRevealed((value) => !value)}
                  className="min-h-[44px] justify-center"
                >
                  <Text className="text-sm text-foreground-muted">
                    {revealed ? account.email : "••••••@••••••"}
                  </Text>
                </Pressable>
              ) : null}
              {account.plan ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {account.plan}
                </Text>
              ) : null}
            </View>
            <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">{window.label}</Text>
              <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
                <T>
                  <Var>{remainingPercent(window)}</Var>% left
                </T>
              </Text>
              {window.resetsAt ? (
                <Text selectable className="text-sm text-foreground-muted">
                  <T>
                    Resets{" "}
                    <Var>
                      {new Date(window.resetsAt).toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </Var>
                  </T>
                </Text>
              ) : null}
              {evenPace !== null ? (
                <Text className="text-sm text-foreground-muted">
                  <T>
                    Even pace: <Var>{evenPace}</Var>% left by now
                  </T>
                </Text>
              ) : null}
              {reset && reset.restoresPercent > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  <T>
                    Restores <Var>{reset.restoresPercent}</Var>% of the pool
                  </T>
                </Text>
              ) : null}
            </View>
            <View className="gap-2 rounded-[24px] border-continuous bg-grouped-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">
                {account.environments.length
                  ? gt("Signed in", {
                      $context: "heading for environments signed in to the account",
                    })
                  : gt("Source", { $context: "heading for where account limits come from" })}
              </Text>
              {account.environments.length ? (
                account.environments.map((environment) => (
                  <Text key={environment.environmentId} className="text-sm text-foreground-muted">
                    {environment.label}
                  </Text>
                ))
              ) : (
                <Text className="text-sm text-foreground-muted">{account.sourceLabel}</Text>
              )}
            </View>
            {account.redeem && account.limits.resetCredits ? (
              <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
                <Text className="text-sm font-t3-medium text-foreground">
                  <T>Reset credits</T>
                </Text>
                <ResetCredits
                  key={account.key}
                  environmentId={account.redeem.environmentId}
                  input={account.redeem.input}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
