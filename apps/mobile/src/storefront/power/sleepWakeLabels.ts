/* oxlint-disable t3code/no-untranslated-copy -- Storefront Code's own screen, English only so far. */
// Storefront Code (fork): the words of Settings → Sleep & wake, apart so they test without React
// Native (fork/design/F8-sleep-and-wake.md).
import type {
  StorefrontPowerStatus,
  StorefrontPowerWaitingFor,
  StorefrontWakeRelayHost,
} from "@t3tools/contracts";

const WAITING_FOR: Record<StorefrontPowerWaitingFor, string> = {
  activeRun: "agents to finish",
  screenUnlocked: "the screen to lock",
  inhibitor: "another app keeping it awake",
};

export function relayStateLabel(host: StorefrontWakeRelayHost | undefined): string | null {
  switch (host?.state) {
    case undefined:
      return null;
    case "awake":
      return "Awake";
    case "waking":
      return "Waking…";
    case "asleep":
      return "Asleep";
    case "unreachable":
      return "Unreachable";
    case "unknown":
      return "Not seen yet";
  }
}

export function sleepWhenDoneLabel(status: StorefrontPowerStatus, secondsLeft: number): string {
  switch (status.sleepWhenDone.state) {
    case "off":
      return "Sleep when done";
    case "pending":
      return `Sleeping when done in ${secondsLeft} s · tap to undo`;
    case "armed": {
      const waits = status.waitingFor.map((reason) => WAITING_FOR[reason]);
      return waits.length > 0
        ? `Sleeps when done, waiting for ${waits.join(" and ")} · tap to cancel`
        : "Sleeps when done · tap to cancel";
    }
  }
}
