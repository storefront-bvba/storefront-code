# F5: the host sends push notifications and Live Activities itself

Design of 2026-11-26 (base upstream v0.1.12). Paths are relative to the repository root; line
numbers drift. See [../GOAL.md](../GOAL.md) and the F5 section of
[../GOAL-CURRENT-STATUS.md](../GOAL-CURRENT-STATUS.md).

## Decisions

- Notifications and Live Activities look exactly as with upstream (decision 2026-11-26): same
  fields (project and thread titles, model, phase, status), same texts, same timing. We reuse
  upstream's aggregation, alert and payload code instead of writing our own.
- Two deviations from upstream (Wouter, 2026-11-27, after a day of "Done" banners): a finished
  thread sent as a plain notification (no Live Activity token on the host) carries only a sound,
  no text (`HostAgentActivity.ts`, and the app rings without an empty banner while open,
  `foregroundNotificationBehavior.ts`); and a queued run counts as live work for the card
  (`packages/shared/src/agentAwareness.ts`), as upstream's own `LIVE_SHELL_STATUSES` has it. Before,
  a follow-up waiting to start after an interrupt projected to nothing and ended the card mid-work;
  the phone only registers a new card when it opens, so every later "Done" was a text banner.
  Upstream's relay did the same (41 such banners in the T3 relay days of the boot log).
- The host talks to APNs directly (HTTP/2, token auth) with our key "Storefront Code Push"
  (Key ID `R2MGM4T6A5`, team `2Z43A4WSC3`, Sandbox & Production, team scoped). The key file lives
  on the host outside the repository: `~/.t3/storefront/AuthKey_R2MGM4T6A5.p8` (mode 600).
- The phone registers its tokens with the host over the authenticated direct connection
  (Tailscale). No relay, no Clerk.
- When the host sink is active, the server never calls T3's relay, even if the host is still
  linked to T3 Connect. After our push works: `t3 connect unlink` on the host.
- Push-to-start: not used (upstream removed it in `d8e0ba3ea0`, #3685); the app starts the card
  itself, as upstream does.

## Today's upstream flow

Host → relay:

- `apps/server/src/relay/AgentAwarenessRelay.ts` watches domain events (80-151), builds a state per
  thread (326-374), sanitises failure detail (212-224), holds back "completed" and tombstones for
  5 s (633-689), skips repeats, retries with backoff (824-856).
- It reads the relay URL and credential from secrets in `~/.t3/userdata/secrets/`
  (`cloud-relay-url`, `cloud-relay-environment-credential`, `cloud-publish-agent-activity`,
  452-465), not from `.env`.
- `publishState` (535-580): `POST /v1/environments/:env/threads/:thread/agent-activity`
  (`packages/contracts/src/relay.ts`:1243-1254), body `{state, proof}`.
- State (`relay.ts`:119-131): `environmentId, threadId, projectTitle, threadTitle, phase,
  headline, detail?, modelTitle, updatedAt, deepLink`; headline and detail are fixed strings
  (`packages/shared/src/agentAwareness.ts`:128-150, 193-210).

Relay (`infra/relay/src/agentActivity/`):

- Rows per thread, fan-out to linked users (`AgentActivityPublisher.ts`:183-225); aggregate only
  when a device has a Live Activity token (61-93).
- Aggregate (`agentActivityAggregate.ts`:74-121): title, order approval/input → failed → running,
  max 5 rows, finished rows 15 min (58); running rows expire after 2 h, waiting after 24 h
  (`agentActivityPayloads.ts`:16-17).
- Deliveries (`ApnsDeliveries.ts`:156-299): Live Activity update when new, count changed, a row
  needs attention or a phase changed, else at most every 15 s; alerts ride inside the Live
  Activity push for rows that newly need approval/input (`agentActivityAlerts.ts`:68-79) or newly
  finished/failed within 2 min (14, 81-114); null aggregate ends the card unless armed < 2 min
  ago; end sends a separate alert (1062-1093); no Live Activity → plain alert (194-206).
- Dead tokens: 410, or 400 `BadDeviceToken` / `DeviceTokenNotForTopic` / `Unregistered` (58-62,
  310-318).

APNs requests (`ApnsClient.ts`; JWT `apnsJwt.ts`:69-120, ES256, reused 45 min,
`ApnsProviderTokens.ts`:13):

- Alert (214-238, 355-363): `POST https://api[.sandbox].push.apple.com/3/device/<token>`,
  `apns-push-type: alert`, `apns-topic: <bundleId>`, priority 10, body
  `{"aps":{"alert":{"title":threadTitle,"body":"Approval: <projectTitle>"},"sound":"default",
  "thread-id":"<env>/<thread>"},"body":{environmentId,threadId,deepLink}}`; several rows →
  "N agents need attention" / "N agents finished" (116-128).
- Live Activity (171-206, 294-300): `apns-push-type: liveactivity`,
  `apns-topic: <bundleId>.push-type.liveactivity` (the app's bundle ID), priority 5 silent / 10
  with alert; update `aps:{timestamp, event:"update", "content-state":{"name":"AgentActivity",
  "props":"<aggregate JSON>"}, "stale-date":+600, alert?}`; end `event:"end"`, dismissal +300
  (+15 without content); payload fitted to 4 KB (122-162).

Phone (`apps/mobile/src/features/agent-awareness/remoteRegistration.ts`):

- Relay token from Clerk (`relay.ts`:1158-1172, `cloudAccountService.ts`:37-51).
- `POST /v1/mobile/devices` `{deviceId, label, platform, iosMajorVersion, appVersion, bundleId,
  apsEnvironment, pushToken, preferences}` (`relay.ts`:46-68, 1027; built 696-768; skipped when
  unchanged 424-441).
- `POST /v1/mobile/live-activities` `{deviceId, activityPushToken}`, max once per 60 s, replays
  state (931-1009).
- `GET /v1/mobile/agent-activity` snapshot for the home widget and local start (563-583).
- `DELETE /v1/mobile/devices/:deviceId` on sign-out.
- Gates: `readRelayConfig` (173-180); `CloudAuthProvider.tsx`:16-20; host descriptor flag
  `agentActivityPublishing` (491-496, set in `apps/server/src/cloud/config.ts`:51-76) is false on
  our host, so the phone never starts a card when you send.

## Design

Server, new files in `apps/server/src/storefront/push/`:

- `HostPushConfig.ts` (~60): `STOREFRONT_APNS_KEY_FILE`, `STOREFRONT_APNS_KEY_ID`,
  `STOREFRONT_APNS_TEAM_ID`, `STOREFRONT_APNS_TOPICS` (allowlist of bundle IDs) from the service
  environment (`~/.t3/service.env`). Push is off when the key is not configured.
- `http2HttpClient.ts` (~130): an Effect `HttpClient` on `node:http2`, one session per APNs host,
  reconnect after GOAWAY (global fetch is HTTP/1.1, `outboundHttp.ts`:30-32).
- `DeviceStore.ts` (~170): `~/.t3/userdata/storefront/push-devices.json`, mode 600, atomic
  writes; per `deviceId`: `{sessionId, registration, liveActivity:{token, armedAt,
  lastAggregate, lastDeliveryAt}}`. Its own file, never a database migration.
- `HostAgentActivity.ts` (~260): rows in memory (rebuilt by the publisher's catch-up at start,
  `AgentAwarenessRelay.ts`:858-904), aggregate, delivery decisions, token pruning, idle-card end
  every 5 min.
- `AgentActivitySink.ts` (~25): a `Context.Reference`, default null.
- `http.ts` (~130): `HttpApiBuilder.group(EnvironmentHttpApi, "storefrontPush")` behind
  `EnvironmentAuthenticatedAuth` with `requireEnvironmentScope("orchestration:read")`
  (`auth/http.ts`:243): `PUT /api/storefront/push/devices/:id`, `DELETE …/devices/:id`,
  `POST …/live-activities` (replays state), `GET …/agent-activity`, `GET …/status`. Bodies reuse
  the relay schemas (`relay.ts`:46, 108, 1049); bundle IDs checked against the allowlist.
- `packages/contracts/src/storefrontPush.ts` (~80): the endpoint group.

Imported from upstream as is (pure Effect code in `infra/relay/src/agentActivity/`):
`agentActivityAggregate.ts`, `agentActivityAlerts.ts`, `agentActivityPayloads.ts`,
`ApnsClient.ts`, `ApnsProviderTokens.ts`, `apnsJwt.ts`, `../Config.ts`, given our HTTP/2 client.
Confirm that the server bundle resolves them (`@noble` from `infra/relay/node_modules`).

Copied (private helpers or Cloudflare-bound), each with a header naming the upstream commit, and
`fork/scripts/check-push-port.mjs` (~40) flags upstream changes at sync:

- `ApnsDeliveries.ts`:150-318 and 1045-1095 (~150);
- publish, replay and idle-end logic of `AgentActivityPublisher.ts` (~80);
- the "keep arming time" rule of `LiveActivities.ts`:159-163.

Edits in existing files (~11 lines):

| File (commits in 30 days)                           | Edit                                                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/relay/AgentAwarenessRelay.ts` (17) | read `AgentActivitySink`; when set, `readSecretString` gates pass and `publishState` hands the state to the sink first and never calls the relay; `layer` provides `HostPush.layer` |
| `apps/server/src/server.ts` (65)                    | provide `StorefrontPushHttp.layer` (append)                                                                                                                                         |
| `apps/server/src/cloud/config.ts` (0)               | `agentActivityPublishing` true when APNs is configured                                                                                                                              |
| `packages/contracts/src/environmentHttp.ts` (17)    | `.add(StorefrontPushHttpApi)` (append)                                                                                                                                              |

Mobile, new files in `apps/mobile/src/storefront/push/`:

- `hostPushClient.ts` (~150): per environment, `executeConnectedEnvironmentHttpRequest` with
  group `storefrontPush` via `connectionAtomRuntime` (reuses DPoP renewal; pattern
  `linkEnvironment.ts`:166-200); 404 = host without support.
- `hostRelayClient.ts` (~60): replaces `registerDevice`, `unregisterDevice`,
  `registerLiveActivity`, `getAgentActivitySnapshot` of `ManagedRelayClient`
  (`managedRelay.ts`:420-434), bound late to avoid an import cycle.
- `activateHostPush.ts` (~50): placeholder token provider; `hostPushRelayKey()` =
  `host-push|<environment IDs>|<day>` so the phone re-registers when a host is added and daily.
- `HostPushNotificationsScreen.tsx` (~160): permission, Live Activity switch, status per host,
  test push.

Mobile edits:

| File (commits in 30 days)                                            | Edit                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `apps/mobile/src/features/cloud/CloudAuthProvider.tsx` (0)           | `activateHostPush()` instead of `deactivateCloudRelayAccount()` |
| `apps/mobile/src/lib/runtime.ts` (1)                                 | wrap `ManagedRelayLayer.layer(...)`                             |
| `apps/mobile/src/features/agent-awareness/remoteRegistration.ts` (9) | `?? hostPushRelayKey()`                                         |
| `SettingsNotificationsRouteScreen.tsx` (9)                           | one line that shows our screen instead of "requires T3 Connect" |

Targets, pruning, environments:

- Notify every device whose `sessionId` is still an active session
  (`EnvironmentAuth.listSessions()`, cached 30 s); prune at once on `clientRemoved`; expire a
  registration not refreshed for 14 days.
- Prune like upstream (410, 400 `BadDeviceToken` / `DeviceTokenNotForTopic` / `Unregistered`),
  separately for push and Live Activity tokens; 403 `ExpiredProviderToken` = new JWT, not prune;
  429/5xx = back off.
- `apsEnvironment` from the phone (dev build = sandbox, else production; TestFlight =
  production) picks `api.sandbox.push.apple.com` or `api.push.apple.com`; on 400
  `BadDeviceToken` try the other environment once and remember it.
- Several hosts later: rows carry `environmentId`; one card per host or one aggregating host.

## Rebase risks

- `AgentAwarenessRelay.ts`: a refactor could open a second publish path around the seam →
  a guard test (no relay call while the sink is set), and `t3 connect unlink` on the host.
- Moved infra files fail loudly at compile time; copied helpers drift quietly → the port check.
- `server.ts` and `environmentHttp.ts` edits are append-only.
- Upstream rewrote phone registration once (July): signature changes fail at compile time.
- New APNs hosts change `fork/telemetry-baseline.json`: update it on purpose, not with `--update`.

Size: about 1,350 new lines (incl. ~500 tests) and 17 edited lines.

Order: confirm the bundle resolves the imported relay modules; send one test push with the key
and the HTTP/2 client; store and endpoints; sink seam and descriptor flag; mobile client and
screen; build, install on the host, TestFlight; check on the phone; `t3 connect unlink`.
