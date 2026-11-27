/* oxlint-disable t3code/no-untranslated-copy -- Storefront Code's own screen, English only so far. */
// Storefront Code (fork): what the Sleep & wake page shows (fork/design/F8-sleep-and-wake.md).
import {
  SLEEP_WHEN_DONE_UNDO_SECONDS,
  type StorefrontPowerBusy,
  type StorefrontPowerWaitingFor,
  type StorefrontWakeRelay,
  type StorefrontWakeRelayHost,
} from "@t3tools/contracts";

export type RelayHostState = StorefrontWakeRelayHost["state"];

const RELAY_STATE_LABELS: Readonly<Record<RelayHostState, string>> = {
  awake: "Awake",
  waking: "Waking…",
  asleep: "Asleep",
  unreachable: "Unreachable",
  unknown: "Unknown",
};

export const relayStateLabel = (state: RelayHostState) => RELAY_STATE_LABELS[state];

const WAITING_FOR_LABELS: Readonly<Record<StorefrontPowerWaitingFor, string>> = {
  activeRun: "agents to finish",
  screenUnlocked: "the screen to lock",
  inhibitor: "another app keeping it awake",
  busy: "the computer to be quiet for 5 minutes",
};

const percent = (cores: number) => `${Math.round(cores * 100)}%`;
const megabytes = (bytesPerSecond: number) => `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;

/** What keeps the host busy, in the words of `top`: "php at 98% CPU". */
function busyText(busy: StorefrontPowerBusy): string {
  switch (busy.kind) {
    case "process":
      return `${busy.name} at ${percent(busy.cores)} CPU`;
    case "cpu":
      return `CPU at ${percent(busy.cores)}`;
    case "disk":
      return `disk at ${megabytes(busy.bytesPerSecond)}`;
    case "network":
      return `network at ${megabytes(busy.bytesPerSecond)}`;
  }
}

function joinWithAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** What an armed Sleep when done still waits for before the host suspends. */
export function armedDescription(
  waitingFor: ReadonlyArray<StorefrontPowerWaitingFor>,
  busyWith: StorefrontPowerBusy | null = null,
): string {
  if (waitingFor.length === 0) return "Going to sleep now.";
  const label = (reason: StorefrontPowerWaitingFor) =>
    reason === "busy" && busyWith
      ? `${WAITING_FOR_LABELS.busy} (${busyText(busyWith)})`
      : WAITING_FOR_LABELS[reason];
  return `Waiting for ${joinWithAnd(waitingFor.map(label))}.`;
}

/** Whole seconds left in the undo window; the host's clock sets `pendingUntil`. */
export function pendingSecondsLeft(pendingUntil: string | null, nowMs: number): number {
  const until = pendingUntil === null ? Number.NaN : Date.parse(pendingUntil);
  if (Number.isNaN(until)) return 0;
  return Math.min(SLEEP_WHEN_DONE_UNDO_SECONDS, Math.max(0, Math.ceil((until - nowMs) / 1000)));
}

export const cannotWakeText = (host: StorefrontWakeRelayHost) =>
  host.wakeNote?.trim() || "Cannot be woken remotely.";

/** The relay one host named, replacing an older address or token for the same relay. */
export function rememberRelay(
  known: ReadonlyArray<StorefrontWakeRelay>,
  relay: StorefrontWakeRelay,
): ReadonlyArray<StorefrontWakeRelay> {
  const same = known.find((entry) => entry.url === relay.url);
  if (same?.token === relay.token) return known;
  return [...known.filter((entry) => entry.url !== relay.url), relay];
}

export interface RelayHostEntry {
  readonly relay: StorefrontWakeRelay;
  readonly host: StorefrontWakeRelayHost;
}

/** Relay host IDs are environment IDs; hosts no connected environment matches get cards of their own. */
export function splitRelayHosts(
  environmentIds: ReadonlyArray<string>,
  entries: ReadonlyArray<RelayHostEntry>,
) {
  const known = new Set(environmentIds);
  const byEnvironment = new Map<string, RelayHostEntry>();
  const unmatched: RelayHostEntry[] = [];
  for (const entry of entries) {
    if (known.has(entry.host.id)) byEnvironment.set(entry.host.id, entry);
    else if (!unmatched.some((other) => other.host.id === entry.host.id)) unmatched.push(entry);
  }
  return { byEnvironment, unmatched };
}
