# Storefront Wake

A small relay that knows which Storefront Code hosts are awake and wakes them with a Wake-on-LAN
magic packet. Hosts report to it while they are awake and right before they sleep; the app asks
it about a host that does not answer and can wake it. Design:
[F8-sleep-and-wake.md](../design/F8-sleep-and-wake.md#relay-storefront-wake-docker-vm-on-o1).

It runs on o1's Docker VM in its own Compose stack: `relay.ts` (Node, no dependencies) on the
VM's network so its broadcasts reach the LAN, and a Tailscale container that serves it over HTTPS
on the tailnet only (`https://wol.<tailnet>.ts.net`, "wol" for Wake-on-LAN). No Funnel, nothing
on the internet.

## API

JSON, `Authorization: Bearer <token>`. A token is `client` (the app, web) or `host` (one host).

- `GET /healthz`: `ok`, no token.
- `GET /v1/hosts` (any token): `{ now, hosts: [{ id, name, state, canWake, wakeNote, lastSeenAt,
  sleptAt, wakeRequestedAt, stayAwake, sleepWhenDone }] }`. `state` is `awake`, `waking`,
  `asleep`, `unreachable` or `unknown`.
- `POST /v1/hosts/{id}/wake` (client): sends the magic packet three times; `202 { host }`, `409`
  when the host cannot be woken, `404` for an unknown host.
- `POST /v1/hosts/{id}/heartbeat` (that host): `{ stayAwake, sleepWhenDone }`, every 20 s.
- `POST /v1/hosts/{id}/sleeping` (that host): right before it suspends.

Host IDs are T3 environment IDs. State is kept in `data/state.json`.

## Deploy on o1's Docker VM

```sh
# from this checkout
rsync -a --exclude .env --exclude config/relay.json --exclude data \
  fork/wake-relay/ <docker-vm>:/home/wouter/storefront-wake/
```

On the VM, in `/home/wouter/storefront-wake/`, the first time:

1. `.env` (mode 600) with `TS_AUTHKEY=tskey-auth-…`: a one-off auth key from the Tailscale admin
   console. Or no key: the `tailscale` container then logs a login link to approve the machine.
   After the first start the node stays logged in through its state volume; disable key expiry
   for the `wol` machine in the admin console, or it drops off the tailnet after months.
2. `config/relay.json` (mode 600), after `config/relay.example.json`: the hosts with their MAC
   address and broadcast address, the token hashes, and the web origins allowed by CORS.
3. `sudo install -d -o 1000 -g 1000 data`: the relay runs as uid 1000 and writes its state there.
4. `docker compose up -d`, then check `curl https://wol.<tailnet>.ts.net/healthz` from a device
   on the tailnet.

After a change to `relay.ts`: copy it again and `docker compose restart relay`.

## Tokens, hosts and reloading

Only the SHA-256 of a token goes into `relay.json`; the token itself goes to the device or host
(on a host: `STOREFRONT_WAKE_RELAY_*_TOKEN_FILE`, mode 600).

```sh
t="$(openssl rand -base64 32)"
printf '%s\n' "$t"                            # give this to the device or host
printf %s "$t" | sha256sum | cut -d' ' -f1    # put this in relay.json
```

- A client: `{ "sha256": "<hash>", "role": "client", "name": "iPhone" }`.
- A host: an entry in `hosts` (`wake` is `magic-packet` with `mac` and `broadcast`, or `none` with
  a `wakeNote` the app shows), and a token `{ "sha256": "<hash>", "role": "host", "hostId": "<id>" }`.
- To revoke a token, remove its line.

Reload `relay.json` without a restart: `docker compose kill -s HUP relay`. A config that does not
parse is refused and the old one stays; `docker compose logs relay` says which.

## Test

```sh
node --test fork/wake-relay/relay.test.ts
```
