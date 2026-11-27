/* oxlint-disable t3code/no-untranslated-copy -- Storefront Code's own screen, English only so far. */
// Storefront Code (fork): what the Sleep & wake page shows (fork/design/F8-sleep-and-wake.md).
import {
  SLEEP_WHEN_DONE_UNDO_SECONDS,
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
};

function joinWithAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** What an armed Sleep when done still waits for before the host suspends. */
export function armedDescription(waitingFor: ReadonlyArray<StorefrontPowerWaitingFor>): string {
  if (waitingFor.length === 0) return "Going to sleep now.";
  return `Waiting for ${joinWithAnd(waitingFor.map((reason) => WAITING_FOR_LABELS[reason]))}.`;
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
