# Host configuration

What a Storefront Code host needs outside the repository. Install by hand; nothing here is
applied by a build or script. Which machine has what applied is tracked in
[GOAL-CURRENT-STATUS.md](../GOAL-CURRENT-STATUS.md#host-configuration).

## Managed policy: `policy.json` → `/etc/t3code/policy.json`

Locks what must not be a setting: no product analytics or relay traces, no update checks or
updates (they would install upstream builds), no model manifest or provider version checks.

```sh
t3 policy check fork/host/policy.json
sudo install -d -m 755 /etc/t3code
sudo install -m 644 -o root -g root fork/host/policy.json /etc/t3code/policy.json
```

The server reads it only when it starts, so it applies at the next restart: the next
`fork/scripts/install-runtime.sh` (which checks it with the new runtime first), or
`fork/scripts/restart-when-idle.sh` for a policy change alone. Check with `t3 policy show`.

- **`"connect": false`** (since 2026-11-26, once our own push worked): T3 Connect off. At startup
  the server unlinks the host and starts no tunnel; push, Live Activities and guest links through
  T3's relay stop with it, and so does the official T3 app's access through Connect.
- **Leave out `clients`:** without `remote` the server refuses remote devices and turns off the
  Tailscale Serve route to itself.
- **Leave out `webhookTasks`:** webhook triggers over Tailscale serve the ERP wish (N3).
- A key the runtime does not know stops the server from starting. Check every change first.

## Service environment: `~/.t3/service.env`

- `T3CODE_TELEMETRY_ENABLED=false`: analytics off even without a policy.
- `T3CODE_LAN=false`: devices reach the host over Tailscale Serve only, never plain HTTP on the LAN.
- `T3CODE_HOSTED_APP_URL=https://<host>.<tailnet>.ts.net`: thread links for MCP clients (the ERP)
  point at our own web app instead of `app.t3.codes`. It also moves the pages a new T3 Connect
  sign-in uses; the existing link keeps working.
- `STOREFRONT_CLEANUP_MODEL=claude-sonnet-5-5`: voice cleanup calls that model through the Messages
  API at `ANTHROPIC_BASE_URL` (with `ANTHROPIC_AUTH_TOKEN`), thinking off, in under a second.
  Without it, cleanup starts a Claude Code session (4 to 6 seconds).
- `STOREFRONT_HUB_ORIGIN=https://cpa.storefront.be`: the API origin our CLIProxyAPI hub serves,
  when its usage source (Settings → Providers → Usage providers) has another address (t3hub on
  `http://192.168.0.188:8318`). Threads sent to the hub then find its limits.

Restart the service for a change to apply, only when no thread runs. Runtimes are installed only
with `fork/scripts/install-runtime.sh` (see [GOAL.md](../GOAL.md#rules-that-always-hold)).
