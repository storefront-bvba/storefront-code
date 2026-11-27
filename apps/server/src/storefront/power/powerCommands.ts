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

// Omarchy's lock screen does not set logind's LockedHint; its helper asks Hyprland. The server's
// own HYPRLAND_INSTANCE_SIGNATURE goes stale when Hyprland restarts, so try each live instance.
// Exits 0 locked, 1 unlocked, 2 when it cannot tell (no Omarchy, no Hyprland).
export const OMARCHY_LOCKED_COMMAND: PowerCommand = {
  command: "sh",
  args: [
    "-c",
    [
      "check=$(command -v omarchy-hyprland-session-locked || echo /usr/share/omarchy/bin/omarchy-hyprland-session-locked)",
      '[ -x "$check" ] || exit 2',
      'for sig in $(ls -t "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/hypr" 2>/dev/null); do',
      '  HYPRLAND_INSTANCE_SIGNATURE=$sig "$check"; result=$?',
      '  [ "$result" -ne 2 ] && exit "$result"',
      "done",
      "exit 2",
    ].join("\n"),
  ],
};

/** Prints `yes` or `no`: logind's LockedHint for the user's graphical session. */
export const LOGIND_LOCKED_COMMAND: PowerCommand = {
  command: "sh",
  args: [
    "-c",
    's=$(loginctl show-user "$(id -u)" -p Display --value) && [ -n "$s" ] && loginctl show-session "$s" -p LockedHint --value',
  ],
};

export const MAC_SESSION_COMMAND: PowerCommand = { command: "ioreg", args: ["-n", "Root", "-d1"] };

export const macScreenLocked = (ioregOutput: string) =>
  /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(ioregOutput);
