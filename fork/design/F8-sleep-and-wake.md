# F8: sleep when done, stay awake, wake through our own relay

Design of 2026-11-27 (base upstream v0.1.12), approved by Wouter on 2026-11-27. See
[../GOAL.md](../GOAL.md) (wish of 2026-11-27) and F8 in
[../GOAL-CURRENT-STATUS.md](../GOAL-CURRENT-STATUS.md).

## Decisions (Wouter, 2026-11-27)

- "Sleep when done" is one-shot: it turns itself off once the host slept. Arming it again is
  always possible. After a tap it waits 10 seconds, so a mistaken tap can be undone.
- "Stay awake" is a toggle per environment, easy to find in Storefront Code, for when a machine
  must not sleep (the MacBook in particular). It is off by default.
- The MacBook is always on Wi-Fi and must not be kept awake by default. A sleeping Mac on Wi-Fi
  wakes for network access only through a Bonjour Sleep Proxy (Apple TV or HomePod). Wouter will
  buy one later; until then the MacBook cannot be woken remotely, and the app says so.
- The relay runs on o1, which is always on, in the Docker VM (192.168.0.188) as its own Compose
  stack, and has a REST API. It is reached over Tailscale only.
- The controls live in Settings → Sleep & wake, on the phone and on web at once.
- The Omarchy PC already wakes on LAN (Wouter, 2026-11-27).
- Stay awake and Sleep when done exclude each other: turning one on turns the other off.

## What upstream already has

- `apps/server/src/background/KeepAwake.ts` holds a sleep inhibitor while any run is active
  (`preparing`, `starting`, `running`) and 60 seconds after: `systemd-inhibit --what=sleep
  --mode=block` on Linux, `caffeinate -i` on macOS. Setting `keepAwakeWhileAgentsWork` (Settings →
  Server controls, on mobile too). Seen on the Omarchy PC: "T3 Code: Agents are working, block".
- Its `hasActiveRun` query is exactly "no working threads". A thread that waits for your answer
  has no active run, so it does not keep the machine awake.

## Host side (fork, `apps/server/src/storefront/power/`, one mount in `server.ts`)

- **Stay awake:** our own sleep inhibitor while the toggle is on, built like upstream's
  (`systemd-inhibit --who="Storefront Code" --why="Stay awake is on" --mode=block`, macOS
  `caffeinate -i`), tied to the server's PID. On macOS it stops idle sleep, not a closed lid.
- **Sleep when done:** arming starts a 10-second undo window, then waits until upstream's
  inhibitor is released (no active run for 60 s) and the screen is locked, then tells the relay
  "sleeping" and suspends through logind (`systemctl suspend`; macOS `pmset sleepnow`). The toggle
  clears itself when the host sleeps; disarming before that is a tap. A suspend refused by an
  inhibitor (upstream's hold still in its 60 s grace) is retried on the next check.
- **Screen locked:** on Omarchy, `omarchy-hyprland-session-locked` (it asks Hyprland for an
  ext-session-lock), tried for each live Hyprland instance because the server's own
  `HYPRLAND_INSTANCE_SIGNATURE` goes stale when Hyprland restarts. Omarchy's lock screen does not
  set logind's `LockedHint` (checked on 2026-11-27 with the screen locked: `LockedHint=no`, no
  hyprlock process); `LockedHint` is the fallback elsewhere. macOS: `CGSSessionScreenIsLocked`.
- **Heartbeat:** every 20 s the host reports to the relay that it is awake, with whether Stay
  awake or Sleep when done is on; after a resume the next one follows within 20 s.
- **State** in `<stateDir>/storefront/power.json` (no migration); endpoints beside
  `/api/storefront/push`, contract in `packages/contracts/src/storefrontPower.ts`, with the
  `orchestration:operate` scope:
  - `GET /api/storefront/power`: `{ supported, stayAwake, sleepWhenDone: { state: off | pending |
    armed, pendingUntil }, waitingFor: [activeRun | screenUnlocked], lastError, relay: { url,
    token } | null }`. The relay address and client token let the app reach the relay while the
    host sleeps (the app keeps them).
  - `PUT /api/storefront/power/stay-awake` and `PUT /api/storefront/power/sleep-when-done`:
    `{ on }`, answer the new status. Sleep when done goes to `pending` for 10 s, then `armed`.
- **Host variables:** `STOREFRONT_WAKE_RELAY_URL`, `STOREFRONT_WAKE_RELAY_HOST_TOKEN_FILE`,
  `STOREFRONT_WAKE_RELAY_CLIENT_TOKEN_FILE` (token files mode 600 in `~/.t3/storefront/`). Without
  them Stay awake and Sleep when done still work, only the relay part is off.

## Relay ("Storefront Wake", Docker VM on o1)

- A small service in its own Compose stack in `/home/wouter/storefront-wake/` on the Docker VM,
  `network_mode: host` so it can broadcast magic packets on the LAN. Code in this repository under
  `fork/wake-relay/`; its config (hosts, MAC addresses, tokens) only on the VM.
- Reached from the iPhone over Tailscale: a Tailscale container in the same stack, tailnet only,
  like the T3 host. Not on the public internet.
- REST API under `/v1`, JSON, `Authorization: Bearer <token>`. The config stores only SHA-256
  hashes of tokens, each with a role: `client` (the app, web) or `host` bound to one host ID.
  CORS for the configured web origins (`https://omarchy.taila38105.ts.net`).
  - `GET /healthz`: `ok`, no token.
  - `GET /v1/hosts` (client or host): `{ now, hosts: [{ id, name, state, canWake, wakeNote,
    lastSeenAt, sleptAt, wakeRequestedAt, stayAwake, sleepWhenDone }] }`. `state` is `awake`
    (heartbeat under 70 s old), `waking` (wake sent after the last heartbeat, under 3 minutes
    ago), `asleep` (said "sleeping" after its last heartbeat), `unreachable` (heartbeats stopped
    without notice) or `unknown` (never seen).
  - `POST /v1/hosts/{id}/wake` (client): magic packet (6 × `FF` and 16 × the MAC) three times to
    the host's broadcast address on UDP 9; `202 { host }` with `waking`. `409 { error:
    "cannot_wake" }` for a host without a wake method (the MacBook until a sleep proxy exists),
    `404` for an unknown host.
  - `POST /v1/hosts/{id}/heartbeat` (that host's token): `{ stayAwake, sleepWhenDone }`; every 20 s.
  - `POST /v1/hosts/{id}/sleeping` (that host's token): right before it suspends.
  - Host IDs are T3 environment IDs, so the app matches them with its paired environments.
  - State survives a restart (`/data/state.json`).
- Hosts in the config: the Omarchy PC (wired `enp8s0`, magic packet); the MacBook (Wi-Fi, no
  wake until a sleep proxy, and no environment yet: it gets one later).

## App (fork, `apps/mobile/src/storefront/power/`)

- One place for it: **Settings → Sleep & wake**, one card per environment: state from the relay
  ("Awake", "Asleep", "Waking…"), **Wake up**, **Stay awake**, **Sleep when done** (with the
  10-second countdown and Undo). The same card opens from an environment's row.
- Better detection: when a host does not answer, the app asks the relay first and shows "Asleep ·
  Wake up" instead of a connection error; after Wake up it shows "Waking…" until the host answers.
- Web: Settings → Sleep & wake with the same cards. Web is served by a host, so it shows the
  other hosts' state and can wake them; the host serving it can only be put to sleep.

## Omarchy PC

- Wake-on-LAN already works (Wouter, 2026-11-27). Wired `enp8s0`.
- Check once by hand that a suspend resumes cleanly with Tailscale and the T3 service.
