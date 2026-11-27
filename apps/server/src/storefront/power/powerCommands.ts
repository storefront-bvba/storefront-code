// Storefront Code (fork): the system commands behind Stay awake and Sleep when done, per platform
// (fork/design/F8-sleep-and-wake.md). Pure, so each platform's commands can be tested here.

export interface PowerCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** Holds sleep off until it exits; prints a line once held and ends with the server's PID. */
export function stayAwakeCommand(
  platform: NodeJS.Platform,
  serverPid: number,
): PowerCommand | undefined {
  switch (platform) {
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          "--what=sleep:idle",
          "--who=Storefront Code",
          "--why=Stay awake is on",
          "--mode=block",
          "sh",
          "-c",
          'echo && exec tail --pid="$0" -f /dev/null',
          String(serverPid),
        ],
      };
    case "darwin":
      return {
        command: "sh",
        args: ["-c", 'echo && exec caffeinate -i -w "$0"', String(serverPid)],
      };
    default:
      return undefined;
  }
}

export function suspendCommand(platform: NodeJS.Platform): PowerCommand | undefined {
  switch (platform) {
    case "linux":
      return { command: "systemctl", args: ["suspend"] };
    case "darwin":
      return { command: "pmset", args: ["sleepnow"] };
    default:
      return undefined;
  }
}

export const CAN_SUSPEND_COMMAND: PowerCommand = {
  command: "busctl",
  args: [
    "call",
    "org.freedesktop.login1",
    "/org/freedesktop/login1",
    "org.freedesktop.login1.Manager",
    "CanSuspend",
  ],
};

/** logind answers `yes`, `no`, `challenge`, `na` or `inhibited`; busctl prints `s "yes"`. */
export const parseCanSuspend = (output: string) => /"([a-z-]+)"/.exec(output)?.[1] ?? "unknown";

export const DISPLAY_SESSION_COMMAND: PowerCommand = {
  command: "loginctl",
  args: ["show-user", "-p", "Display", "--value"],
};

export const lockedHintCommand = (sessionId: string): PowerCommand => ({
  command: "loginctl",
  args: ["show-session", sessionId, "-p", "LockedHint", "--value"],
});

// Omarchy locks with hyprlock, which may not set logind's LockedHint.
export const HYPRLOCK_COMMAND: PowerCommand = { command: "pidof", args: ["hyprlock"] };

export const MAC_SESSION_COMMAND: PowerCommand = { command: "ioreg", args: ["-n", "Root", "-d1"] };

export const macScreenLocked = (ioregOutput: string) =>
  /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(ioregOutput);
