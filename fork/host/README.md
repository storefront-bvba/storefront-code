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

The server reads it only when it starts, so it applies at the next restart (the next
`fork/scripts/install-runtime.sh`, which checks it with the new runtime first). Check with
`t3 policy show`.

- **Once our own push works (F5):** add `"connect": false` to `limits`. It turns T3 Connect off and
  unlinks the host; push, Live Activities and guest links through T3's relay stop with it.
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

Restart the service for a change to apply, only when no thread runs. Runtimes are installed only
with `fork/scripts/install-runtime.sh` (see [GOAL.md](../GOAL.md#rules-that-always-hold)).
