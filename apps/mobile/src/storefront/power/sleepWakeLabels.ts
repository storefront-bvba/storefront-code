/* oxlint-disable t3code/no-untranslated-copy -- Storefront Code's own screen, English only so far. */
// Storefront Code (fork): the words of Settings → Sleep & wake, apart so they test without React
// Native (fork/design/F8-sleep-and-wake.md).
import type {
  StorefrontPowerBusy,
  StorefrontPowerStatus,
  StorefrontPowerWaitingFor,
  StorefrontWakeRelayHost,
} from "@t3tools/contracts";

const WAITING_FOR: Record<StorefrontPowerWaitingFor, string> = {
  activeRun: "agents to finish",
  screenUnlocked: "the screen to lock",
  inhibitor: "another app keeping it awake",
  busy: "the computer to be quiet for 5 minutes",
};

const percent = (cores: number) => `${Math.round(cores * 100)}%`;
const megabytes = (bytesPerSecond: number) => `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;

/** What keeps the host busy, in the words of `top`: "php at 98% CPU". */
export function busyText(busy: StorefrontPowerBusy): string {
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
      const waits = status.waitingFor.map((reason) =>
        reason === "busy" && status.busyWith
          ? `${WAITING_FOR.busy} (${busyText(status.busyWith)})`
          : WAITING_FOR[reason],
      );
      return waits.length > 0
        ? `Sleeps when done, waiting for ${waits.join(" and ")} · tap to cancel`
        : "Sleeps when done · tap to cancel";
    }
  }
}
