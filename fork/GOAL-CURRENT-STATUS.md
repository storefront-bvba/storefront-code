# Storefront Code: current status

How each wish in [GOAL.md](GOAL.md) stands today. Update this file whenever something changes: a
patch, a PR, a sync, a decision, a finding.

- **Fork base:** upstream `v0.1.12` (2026-11-24), branch `storefront`.
- **Last checked against upstream:** `main` at `00fa6cd60c` (2026-11-26). File references below are
  from that commit; line numbers drift.
- **Patches carried** (commits on `storefront`, oldest first):
  1. `fork:` goal and status docs; `CLAUDE.md` imports `fork/GOAL.md`.
  2. `fork(server):` product analytics off by default, empty built-in PostHog key and host
     (`apps/server/src/telemetry/AnalyticsService.ts`, 4 lines).
  3. `fork(mobile):` app identity in `apps/mobile/storefront-identity.ts`, applied by the last line
     of `apps/mobile/app.config.ts` (plus one import), icon in `fork/assets/`.
  4. `fork:` telemetry guard `fork/scripts/check-telemetry.mjs` with `fork/telemetry-baseline.json`.
  5. `fork(shared):` update source `storefront-bvba/storefront-code` instead of `pingdotgg/t3code`
     (`packages/shared/src/cliRelease.ts`, 1 line), so no client or `t3 update` swaps in an upstream build.
  6. `fork:` build and install scripts in `fork/scripts/` (iOS TestFlight, build keychain, App Store
     Connect API, Linux runtime in an Ubuntu container, runtime install with backup).
  7. F5, host-sent push (6 commits, 2026-11-26): new files in `apps/server/src/storefront/push/`
     and `apps/mobile/src/storefront/push/`, `packages/contracts/src/storefrontPush.ts`,
     `fork/scripts/check-push-port.mjs` and `fork/scripts/apns-check.mjs`; edits of 2-7 lines in
     `AgentAwarenessRelay.ts`, `cloud/config.ts`, `server.ts`, `environmentHttp.ts`,
     `CloudAuthProvider.tsx`, `lib/runtime.ts`, `remoteRegistration.ts`,
     `SettingsNotificationsRouteScreen.tsx` and `SettingsRouteScreen.tsx` (see F5 below).
  8. `fork(shared):` no favicon lookups at Google: `faviconUrlForOrigin` returns `null`
     (`packages/shared/src/favicon.ts`, 1 line plus a comment; two tests follow).
  9. `fork:` the guard checks hard-coded hosts and built artifacts; the Linux build runs it.
  10. `fork:` the runtime install backs up `secrets/` and `attachments/` and checks the managed
      policy with the new runtime before the switch.
  11. `fork(server):` triage off: no triage capability (`apps/server/src/environment/ServerEnvironment.ts`,
      1 line) and `t3 triage` refuses unless `STOREFRONT_TRIAGE=1` (`apps/server/src/cli/triage.ts`, 5 lines).
  12. `fork(web):` "Storefront Code" in window titles and the web manifest (`apps/web/src/branding.ts`,
      `apps/web/vite.config.ts`, `apps/web/public/manifest.webmanifest`, 1 line each).
  13. `fork:` typecheck and test gate `fork/scripts/check-build.sh` and a boot check of the built web
      client in the Linux build.
  14. `fork:` host configuration templates in `fork/host/` (managed policy, service environment).
  15. `fork(server):` Deepgram transcription on the environment (`apps/server/src/storefront/deepgram/`,
      one line in `apps/server/src/server.ts`). F2.
  16. `fork(mobile):` live words while dictating to an environment (`apps/mobile/src/storefront/voice/`,
      one-line mounts in `VoiceInputProvider.tsx`, `voiceDestination.ts`, `ComposerDictationControl.tsx`). F2.
  17. `fork(mobile):` transcript cleanup on the phone after Deepgram dictation
      (`apps/mobile/src/storefront/voice/transcriptCleanup.ts`, one line in `VoiceInputProvider.tsx`). F2.
  18. `fork(server):` a Claude Code subagent's effort follows its transcript
      (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, plus a test). F3.
  19. `fork:` usage display: `packages/shared/src/usageLimitsDisplay.ts`, one pooled meter on web and
      mobile, the % used / % remaining setting, `ThreadUsageIndicator.tsx` in a thread. F4, N1, N2.
  20. `fork(mobile):` B1-B3 (4 commits, 2026-11-26): the dock stays hidden when the app opens straight
      into a thread; a Live Activity the app starts links to its thread; taps open a thread that
      needs you, else a finished one; a drag in the focused composer selects text (see B1-B3 below).
  21. `fork(mobile):` our names and look in the app: "Code" on the home screen, icon, splash, the S
      mark in the title, widget and Live Activity, no "Beta" badge, and a Babel plugin that renames
      "T3 Code" in the app's strings (see F6 below; assets from `fork/scripts/brand-assets.py`).
- **Run the guards** after every rebase: `node fork/scripts/check-telemetry.mjs` and
  `node fork/scripts/check-push-port.mjs` (upstream changed relay code that F5 copied). The Linux build runs
  it on the source, runs `fork/scripts/check-build.sh`, and checks its own archive with
  `check-telemetry.mjs --artifact`. The iOS build runs the source guard only; check the app by hand.
  The gate and the web boot check add about 5 minutes; a whole Linux build took 7 minutes with warm
  caches (2026-11-26).
- **Expected upstream test failures** (skipped by name in `fork/scripts/check-build.sh`):
  - `apps/mobile/app.config.test.ts` ("keeps the iOS and Android identifiers"): T3's bundle IDs.
  - `apps/mobile/src/features/settings/environment-maintenance.test.ts` (2 cases) and
    `packages/ssh/src/tunnel.test.ts` ("only downloads a release archive the host can run: Darwin
    arm64"): upstream's release repository, which patch 5 replaces.
  - `apps/server/src/cli/update.test.ts` (1 case, upstream's release repository, patch 5) and
    `apps/server/src/telemetry/AnalyticsService.test.ts` (7 cases, analytics off by default, patch 2).
  - Only on the Omarchy PC, not in the build container: `scripts/install.test.ts` (Arch's `sh` is
    bash, which sets `SHELL`) and `apps/web/src/lib/bootError.test.ts` (counts "outer", which
    `/home/wouter` contains).

## Overview

Sizes: S = hours, M = a day or two, L = several days. "Upstream" is our estimate of whether
upstream would take it.

| #   | Wish                                         | State                                                                                                                                                                                                                     | Route                                                                                                                 | Size | Upstream                                   |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------ |
| B1  | Live Activity tap opens the right thread     | Fixed in fork, on `storefront` since 2026-11-26 (reproduced and verified in the simulator); in TestFlight build 202611261654; tap with real pushes on the iPhone open                                                     | Upstream PR (fix); order change in fork                                                                               | S    | Good for the fix                           |
| B2  | Selecting text to the left closes the panel  | Fixed in fork, on `storefront` since 2026-11-26 (page slide reproduced and fixed in the simulator); in TestFlight build 202611261654; finger check on the iPhone open                                                     | Upstream PR                                                                                                           | S    | Good                                       |
| B3  | Bottom menu bar stays visible in a thread    | Fixed in fork, on `storefront` since 2026-11-26 (reproduced and verified in the simulator); in TestFlight build 202611261654                                                                                              | Upstream PR                                                                                                           | S    | Good                                       |
| F1  | No telemetry or tracking                     | Fork patches, guard and build checks done; host runs our build with opt-outs; managed policy installed, active from the next restart                                                                                      | Config + small patch + guard                                                                                          | S    | No (on by default upstream)                |
| F2  | 2-step voice input (Deepgram)                | Host side live since 2026-11-26 16:59 (`0.1.12-storefront.68`, key file in `service.env`); app side in TestFlight build 202611261527, device test open                                                                    | Fork: Deepgram backend behind the environment's speech service, live stream from web and app, upstream's cleanup step | M–L  | No for now (closed #32530)                 |
| F3  | Subagent model and effort visible            | Fixed in fork, live on the host since 2026-11-26 (`.68`): effort shows while a Claude Code subagent runs                                                                                                                  | Fork patch now, upstream bug-fix PR later                                                                             | S    | Good (follows #35333 and #43023)           |
| F4  | Usage indicator in a thread                  | Done in fork; web live (`.68`), app in TestFlight build 202611261527, not yet seen on a device                                                                                                                            | Own file + one mount; Idea #40926                                                                                     | S–M  | Doubtful (feature)                         |
| F5  | Only Tailscale or LAN, no T3 Connect         | Paired over Tailscale Serve; host push live since 2026-11-26 16:59 (`.68`); the app's Notifications screen was unreachable in build 202611261527, fixed in build 202611261654; phone check open, then `t3 connect unlink` | Fork: host sends push itself                                                                                          | L    | No (new connection method)                 |
| F6  | Own Apple account, TestFlight                | Done: first build uploaded to TestFlight on 2026-11-26                                                                                                                                                                    | Fork: `storefront-identity.ts`, `fork/scripts/`                                                                       | S    | No                                         |
| F7  | Full end-to-end encryption                   | Decided: nothing to build                                                                                                                                                                                                 | Follows from F5 and push design                                                                                       | –    | –                                          |
| N1  | One combined usage meter for pooled accounts | Done in fork; web live (`.68`), app in TestFlight, not yet seen on a device                                                                                                                                               | Fork                                                                                                                  | S–M  | No                                         |
| N2  | Toggle % used / % remaining                  | Done in fork; web live (`.68`), app in TestFlight; new strings not in the catalogs yet                                                                                                                                    | Fork; design follows Ideas #32499 and #30076                                                                          | S–M  | Possible once a maintainer agrees (#32499) |
| N3  | Remote API for ERP / ticket system           | Exists via `/mcp`; config gaps                                                                                                                                                                                            | Config, maybe a small patch                                                                                           | S    | –                                          |

## Machines

| Machine            | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Omarchy PC (host)  | **Runs our build `0.1.12-storefront.68` since 2026-11-26 16:59** (built with `fork/scripts/build-linux-cli.sh`, switched with `fork/scripts/install-runtime.sh`: backup `~/.t3/backups/2026-11-26-1658-before-0.1.12-storefront.68`, threads 448 → 448, telemetry opt-out in the server's environment; before that `.31` from 14:14). `t3` on PATH is ours (`~/.local/bin/t3`). T3 pruned the old 0.1.10 runtime after the switch, so rollback means: restore the database backup and install an earlier archive from `build/linux-cli/`. `.68` has the web icons, `storefront-mark.svg` and the loading-screen logo built in. `t3code-bin` (desktop app and CLI) removed; Tailscale 1.104.7. The web UI opens from the launcher "Storefront Code" in its own extension-free Chromium profile; the Mac uses `https://omarchy.taila38105.ts.net` in Chrome. |
| iPhone             | Storefront Code from TestFlight, paired over Tailscale. The official T3 Code app (through T3 Connect) stays installed until Storefront Code covers push and Live Activities.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| MacBook Air (2025) | Not used yet. Needed for Xcode builds and TestFlight uploads, unless CI builds take over.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Host configuration

What the Omarchy host needs outside the repository; how to install it is in
[host/README.md](host/README.md).

- **Managed policy** `/etc/t3code/policy.json` (root-owned, mode 644), from
  [host/policy.json](host/policy.json): telemetry off, no update checks or updates, provider update
  checks locked off. **Installed on 2026-11-26 at 17:43**, after the switch to
  `0.1.12-storefront.68` (checked with that runtime's `t3 policy check`). The running server loads
  it at its next restart, the next server round; `t3 policy show` says so until then.
  `fork/scripts/install-runtime.sh` checks it with every new runtime before switching.
- **Later, once our own push works (F5):** add `"connect": false` to `limits` (unlinks T3 Connect).
- **`~/.t3/service.env`** must hold `T3CODE_TELEMETRY_ENABLED=false` and `T3CODE_LAN=false` (both
  there) and gets `T3CODE_HOSTED_APP_URL=https://omarchy.taila38105.ts.net` (new: thread links for
  MCP clients such as the ERP point at our own web app instead of `app.t3.codes`).

## Details

### B1: Live Activity tap

- Fixed on `storefront` since 2026-11-26 (cherry-picked from `storefront-ios-bugs`), two commits: the link fix (for upstream) and
  the tap order (fork only). Evidence in `~/.local/share/storefront-code/evidence/B1/` (README there).
- Cause (confirmed in the simulator): a Live Activity the app starts itself, after you send a
  message, had a row without a thread and the deep link `"/"`. The widget turns that into a bare
  `t3code://`, which the link filter drops on purpose (`apps/mobile/src/lib/appLinking.ts`:15), so a
  tap brought the app forward where it was until a relay push replaced the row.
- Fix: the composer passes the thread (`apps/mobile/src/features/threads/ThreadComposer.tsx`:589)
  and the row links to `/threads/<env>/<thread>`
  (`apps/mobile/src/features/agent-awareness/remoteRegistration.ts`:498-546). Test in
  `remoteRegistration.test.ts`. Files changed 9 and 41 times upstream in 30 days.
- Fork-only order: a tap opens a thread waiting for approval or input, else a failed or done one,
  else a running one (`apps/mobile/src/widgets/AgentActivity.tsx`:179 and
  `AgentActivityWidget.tsx`:103; 3 and 2 commits in 30 days). The rows keep their order on screen.
  Test in `src/widgets/agentActivityTapTarget.storefront.test.ts` (new file).
- The app starts Live Activities only with T3 Connect signed in; the simulator test bypassed those
  checks in a patch that was not committed.
- Open: a real iPhone with real pushes (F5 is live on the host since 2026-11-26), and the
  home-screen widget tap (unit-tested only).
- Related upstream: #18997 (Dynamic Island, fixed in #19022), #26544 (open: an approval notification
  does not open its thread).

### B2: text selection closes the panel

- Fixed on `storefront` since 2026-11-26 (cherry-picked from `storefront-ios-bugs`). Evidence in
  `~/.local/share/storefront-code/evidence/B2/`.
- Cause (reproduced in the simulator): iOS 26's full-screen back gesture starts on a rightward drag
  anywhere on the page, also inside the focused composer, so the thread page slides away under
  the finger. The selection handles themselves worked in both directions in the simulator.
- Fix: a pan recognizer on the composer's text view
  (`apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift`:76-107, 637; 13 commits
  in 30 days). While the editor has focus, the stack's back gestures wait for it to fail; an
  unfocused composer, the message list and the screen edge still go back (checked). The vendored
  screens tarball is untouched.
- Open: the gesture as described in the bug (selecting to the left) with a real finger on the
  iPhone; the simulator can only drag, not long-press and then drag.

### B3: bottom menu bar in a thread

- Fixed on `storefront` since 2026-11-26 (cherry-picked from `storefront-ios-bugs`). Evidence in
  `~/.local/share/storefront-code/evidence/B3/`.
- Cause (confirmed in the simulator with logging): when the app opens straight into a thread (a
  Live Activity or notification tap after iOS ended the app, or restoring the last thread), the
  hidden tabs prewarm their headers (`apps/mobile/src/features/layout/workspace/WorkspaceNativeTabs.ios.tsx`:70, 118);
  UIKit then lays out their root screens, and each root's "will appear" set the shared
  "primary visible" flag while the shown tab had a thread on top. The dock then covers the
  composer. Warm links (from Home, another tab, an open menu, the background) did not reproduce.
- Fix: only the shown tab's stack reports root visibility
  (`apps/mobile/src/features/layout/createWorkspaceStackNavigator.ios.tsx`:590; 25 commits in 30
  days). No unit test: the fix is callback wiring in a native view; before/after captures are the
  proof.
- Upstream fixed a sibling bug themselves (#36975).

### Testing the app in the simulator

- `vp run mobile:install` assumes upstream's bundle ID and workspace name; build the development
  client on the Mac with `expo prebuild` and `xcodebuild` for `generic/platform=iOS Simulator`
  (workspace `ios/StorefrontCodeDev.xcworkspace`), install it, and run Metro on the Mac.
- Use a throwaway server (`t3 serve --base-dir ~/.local/share/storefront-code/dev-home --port 3790
  --lan`) and pair through its Tailscale address; this PC's firewall blocks the LAN address.
- A deep link given to the development client at a cold start is handed to the app again on every
  activation. Restart the simulator after such a test, or it skews later tests.

### F1: telemetry

What upstream sends by default (verified in code):

- Server: PostHog product analytics to `ingest.t3.codes`; the key is in the code
  (`apps/server/src/telemetry/AnalyticsService.ts`:69-76), so source builds send it too. Off with
  `T3CODE_TELEMETRY_ENABLED=false`, `DO_NOT_TRACK=1` (v0.1.12+) or a managed policy.
- Server: hourly model manifest from GitHub and provider update checks (off with
  `enableProviderUpdateChecks: false`); daily LiteLLM price table from GitHub when usage is computed
  (`apps/server/src/usage/UsageService.ts`:72-75, no switch).
- Desktop: auto-update checks against upstream's GitHub releases (off with
  `T3CODE_DISABLE_AUTO_UPDATE` or policy).
- Mobile: EAS Update check at `u.expo.dev` on every launch, also in source builds (off with
  `T3CODE_MOBILE_UPDATES_ENABLED=0`, `apps/mobile/app.config.ts`:250-255). Crash reports and
  connection traces are only active in official builds (they need a relay URL and build-time tokens).
- Web: link favicons came from Google's favicon service (`www.google.com/s2/favicons`); patch 7
  shows a local globe instead. Tool-activity icons still load `<site>/favicon.ico` from sites the
  agent visited (`packages/shared/src/favicon.ts`:3-11).
- Runtime: the Cursor provider's SDK (`node_modules/@cursor/sdk`) bundles PostHog and Statsig. It
  loads only when the Cursor provider runs; `limits.providers.allowedDrivers` in the policy would
  rule it out.

Plan for the fork: analytics default off (or no ingest URL) in `AnalyticsService.ts`, mobile updates
off in `app.config.ts`, build without `.env` (no Connect, Clerk, relay, Axiom), and a guard test
modelled on pseudoseed/t3code_dev's `scripts/no-upstream-telemetry.test.ts` (MIT).
`AnalyticsService.ts` changed 11 times in 30 days, but lines 70-80 only 4 times since August.

### F2: voice

Built on branch `storefront-f2-voice` (2026-11-26). The environment does the work; the API key never
leaves the host.

- **Design.** With `STOREFRONT_DEEPGRAM_KEY_FILE` in the server's environment, the host's speech
  service is replaced by a Deepgram backend (`apps/server/src/storefront/deepgram/DeepgramSpeech.ts`,
  mounted with one line in `apps/server/src/server.ts`). Clients see it as the environment's only
  active model, "Deepgram Nova-3", which streams. Nothing in the wire contracts changed. Without the
  variable, the host behaves exactly as upstream.
  - Live words: Deepgram runs behind upstream's existing speech WebSocket (`/ws/voice`), which until
    now only served local streaming models. Interim results show as tentative text, finals as
    committed text, as for local models.
  - Uploads (`/api/voice/transcribe`) go to Deepgram's pre-recorded API, with the same options.
  - Step 2 is upstream's own cleanup (`/api/voice/postProcess`, the environment's cleanup model).
  - Web and desktop: no code change. Live preview comes from upstream's streaming path; cleanup needs
    **Settings → Voice → Transcript cleanup** turned on once (upstream's consent model).
  - iPhone and iPad: a new recorder on expo-audio's `AudioStream` (16 kHz mono 16-bit, no new native
    code) streams to `/ws/voice` while you speak; the words show in the dictation row of every
    composer; the final text gets cleaned up automatically when the environment uses Deepgram, then
    lands in the draft. The recorder also writes a WAV file, so a dropped stream falls back to
    uploading the whole recording. Android and cloud destinations keep upstream's upload path.
- **Deepgram settings** (defaults, overridable in `service.env`):
  - `model=nova-3` (`STOREFRONT_DEEPGRAM_MODEL`): the only Deepgram model with both Flemish and keyterm
    prompting. Flux has no `nl-BE` and no smart formatting; Nova-2 has no keyterms.
  - `language=multi&language_hint=nl-BE&language_hint=en` (`STOREFRONT_DEEPGRAM_LANGUAGE=nl-BE,en`; a
    single code such as `nl-BE` means monolingual). Monolingual `nl-BE` drops English speech; in our
    test it turned "the build is still failing on the CI pipeline" into "de beelden". Multi kept the
    English and spelled loanwords better (`rollback`, `pull request`, `stagingserver`), at about
    $0.001/min more.
  - `smart_format=true` (punctuation, numerals), `interim_results=true`, `endpointing=100` (Deepgram's
    value for code-switching; 300 for one language). Left out: `filler_words` and `dictation`
    (English only), `numerals` and `punctuate` (in smart_format), `no_delay`, `utterance_end_ms` (you
    stop recording yourself).
  - `keyterm`: dictionary hints first, then personal and project words (web sends them), then the
    environment's project dictionary (so the phone gets those too); at most 50 terms.
  - Always `mip_opt_out=true` (no model training on our audio; no price impact since 2026-03-05) and
    `redact_usage=true` (keyterms stay out of Deepgram's usage logs).
  - EU endpoint `api.eu.deepgram.com` (`STOREFRONT_DEEPGRAM_URL`): audio stays in the EU; same key and
    price.
- **Test with the real key** (2026-11-26, Piper TTS: Flemish voice `nl_BE-nathalie`, English voice
  `en_US-lessac` for the mixed clip, streamed at real time through `runSpeechSocket` and upstream's
  `openSpeechStream` client):
  - Mixed clip, live: interim text about every second; final 100 ms after stop: "Ik heb de bug in de
    checkout gefixt, maar de beeld is stil failing on the CI pipeline. Kan jij dat even bekijken en
    daarna de branch mergen?"
  - Flemish with jargon, final: "Kan je de pull request van gisteren nog eens reviewen? En, de unit
    tests falen op de staging server, nee ik bedoel op de productieserver. Schek ook even de Docker
    Compose Config en de README."
  - After upstream's cleanup prompt (Claude Haiku via the CLI, about 6 s): "… maar de build is still
    failing on the CI pipeline …", "Zet de feature vlag af … want de API geeft een time-out. Daarna
    moeten we de cache van Redis leegmaken …", and the spoken correction resolved ("… falen op de
    productieserver").
  - TTS reads English words with Dutch sounds, so real speech should do better on the jargon.
- **New outbound destination**, on purpose: `api.eu.deepgram.com` (HTTPS and WSS), only when the key
  file is set. It receives the audio of a dictation and the dictionary words. The telemetry guard
  watches telemetry vendors and SDKs, not hosts, so it passes unchanged; the baseline was not touched.
- **Host setup:** add to `~/.t3/service.env`:
  `STOREFRONT_DEEPGRAM_KEY_FILE=/home/wouter/.t3/storefront/deepgram-api-key` (the file stays mode
  600). Pick a fast **Cleanup model** in Settings → Voice (a text generator such as Claude Haiku over
  the API): with a coding agent each cleanup starts a session and takes several seconds.
- **Open:**
  - Device test of the app part (needs a TestFlight build).
  - The live recorder follows the iOS audio route and ignores the microphone list in Settings; with
    expo-audio's `.record` category that likely means the built-in microphone, not AirPods.
  - The phone sends no personal dictionary and no thread-project dictionary (upstream mobile has
    neither); only the environment-wide project dictionary reaches Deepgram.
  - The phone has no "skip cleanup" button and uses the default cleanup instructions; cleanup longer
    than 20 s inserts the raw transcript.
  - While Deepgram is on, local models stay listed but none of them transcribes.
- **Upstream:** stays in the fork (Theo's stance on speech providers, see Upstream contributions).
  Related Ideas: #32516 (own endpoint), #36900 (Deepgram).

### F3: subagent model and effort

- Clients already show "provider · model · effort" from the subagent's `modelSelection`: mobile in
  `apps/mobile/src/features/threads/SubagentRow.tsx`, web in `SubagentTooltipContent.tsx`. No
  client change is needed. T3-delegated subagents have both values from the start.
- What Claude Code exposes (CLI 2.1.329, measured with stream-json runs on 2026-11-26):
  - The Agent tool input has `model` and `effort`, but only when the call sets them.
  - `task_started` and `background_tasks_changed` carry neither value. A background launch result
    carries `resolvedModel`, and streamed subagent frames carry `message.model`. A foreground
    subagent that only replies with text streams no frames at all.
  - The effort is recorded only in the subagent's transcript
    (`<claude config>/projects/<project>/<session>/subagents/agent-<task>.jsonl`). It is the
    `effort` on each assistant line from the first reply on (0.5 to 3 s after start in our runs),
    and also `params.output_config.effort` on an `api-request` line about 0.7 s after start.
  - Where it comes from: the parent's effort when the model is the same (parent `low` gave `low`),
    the agent's frontmatter `effort` (`medium`), or the model's own default when the model
    differs (Haiku gave `medium`). The adapter cannot know this at start without the transcript.
- Model: visible from the start. It is the model the call names, the parent's model for `inherit`,
  or else the parent's model until the first streamed frame or the settle corrects it. Built-in
  agents inherit the model, so this is right unless a custom agent or a default subagent model
  picks another one.
- Fix (`fork(server):` commit): from `task_started` on, the adapter reads the subagent's transcript
  every second until the first reply, then sets the effort while the subagent still runs. Before
  this, the effort was read only at the settle (upstream #35333). Edits in
  `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`: one new block, one line in the
  effort derivation, one call in the `task_started` handling. The split-out
  `findSubagentTranscriptDir` is copied verbatim from upstream `main` (#43023), so the next rebase
  merges cleanly there. The test is in `ClaudeAdapterV2.test.ts` ("reports a running subagent's
  effort once its transcript records the first reply"): it fails on the base and passes with
  the fix.
- Not used: the earlier `api-request` line. It would show the effort about 2 s sooner, but it is
  an internal request log, and the shared transcript parser drops it. Worth a follow-up if the
  wait for the first reply turns out to matter.
- Upstream PR (not opened yet), as a bug fix: "fix(server): running Claude subagents show their
  reasoning effort". The commit cherry-picks onto `upstream/main` `fc1f1bafde` without conflicts.
  There the new test fails without the fix and passes with it, and all 511 adapter tests and the
  server typecheck pass. The PR still needs before/after
  captures of the web hover card and the mobile row while a Claude Code subagent runs: no effort
  before, effort after. The adapter is upstream's hottest file (169 commits in 30 days), so cut
  the branch fresh from `upstream/main` right before opening it.

### F4: usage indicator

- Done on 2026-11-26 (branch `storefront-usage-display`, commit `fork(mobile): usage indicator in
  threads`): `apps/mobile/src/features/threads/ThreadUsageIndicator.tsx`, mounted once in
  `ThreadDetailScreen.tsx` next to `ThreadBrowserFloat` (an import and one element; the file is hot,
  55 commits in 30 days).
- A glass pill at the top right below the header shows the thread's tightest limit: window label,
  "% left" or "% used" (N2) and a mini bar, amber at 20% left and red at 10%. Tap opens the existing
  `/usage-limits` panel above the composer. Hidden in drafts and when the account reports no limits.
- Accurate for the thread: the same resolution as web's thread details card, the instance's own
  limits or, for an instance behind a CLIProxyAPI hub, the pool of accounts the hub routes the
  model to. Model-only windows of other models (a "Weekly · Fable" limit for an Opus thread) are
  left out. That logic moved from `apps/web/src/components/chat/ThreadDetailsUsage.logic.ts` to
  `packages/shared/src/usageLimitsDisplay.ts` (`resolveThreadLimits`); web re-exports it under its
  old name, so an upstream change to the web logic must be carried over to the shared copy.
- Off switch: Settings → Appearance → Usage limits → Show in threads (`threadUsageIndicatorEnabled`
  in mobile preferences, unset means on).
- Display only: it shows what the app last received; nothing is fetched for it.
- Not seen on a device yet (no Mac or simulator in that session); unit test with mocked React Native.
  It covers the end of message lines at the top right; the floating browser preview sits above it.

### F5: no T3 Connect, own push

- The app works without Connect: pairing over Tailscale (`t3 pair --tailscale`) or LAN. Without
  Connect, push notifications, Live Activities and the Agent Activity widget stop
  (`remoteRegistration.ts`:503, 575).
- Today's push path: host → T3 relay (Cloudflare Worker, Clerk, Postgres) → APNs, with T3's push key
  and bundle ID (`infra/relay/src/agentActivity/ApnsClient.ts`:286-299).
- Chosen design: the host sends APNs pushes itself with our own key; the phone registers its tokens
  over the direct connection. Mostly new files on the server (about 1,500 lines, porting the relay's
  MIT code, using `node:http2`) and about 300 lines in the app behind the existing relay-client
  interface (`packages/client-runtime/src/relay/managedRelay.ts`:420-432).
- APNs key (2026-11-26): "Storefront Code Push", Key ID `R2MGM4T6A5`, Sandbox & Production, team
  scoped. On the Omarchy host in `~/.t3/storefront/AuthKey_R2MGM4T6A5.p8` (mode 600, outside the
  repo); a backup copy is in Wouter's password manager.
- Payloads: the same fields as upstream (decision 2026-11-26), so alerts and Live Activities look as before.
- **Built on 2026-11-26** (design: [design/F5-host-push.md](design/F5-host-push.md)):
  - Server (`apps/server/src/storefront/push/`): `HostPushConfig` (the four `STOREFRONT_APNS_*`
    variables; off without them), `http2HttpClient` (Effect HttpClient on `node:http2`),
    `DeviceStore` (`<stateDir>/storefront/push-devices.json`, mode 600, no migration),
    `deliveryPort` (upstream's `ApnsDeliveries.ts` rules, copied), `HostAgentActivity` (publish,
    replay, idle end, 5-minute sweep, 14-day expiry, session pruning), `HostPush` (one layer for
    the sink and the endpoints), `http` (the `storefrontPush` endpoints). Upstream's aggregate,
    alerts, payloads, `ApnsClient`, provider tokens and JWT are imported as they are
    (`upstreamRelay.ts`); the server bundle resolves `@noble` from `infra/relay/node_modules`.
  - Seam: with the sink set, `AgentAwarenessRelay` passes its link gates without reading T3
    Connect's secrets and never calls the relay (guard test `AgentAwarenessRelaySink.test.ts`);
    the descriptor's `agentActivityPublishing` is true when APNs is configured.
  - App (`apps/mobile/src/storefront/push/`): the relay client's four agent-awareness calls go
    to every paired host that publishes agent activity; the first host feeds the Live Activity;
    a stand-in relay key (hosts, sessions, day) re-registers when a host or session changes and
    daily; notification settings screen with each host's state and a test push.
  - APNs check without a phone (`node fork/scripts/apns-check.mjs`, made-up token): sandbox and
    production both answered 400 `BadDeviceToken`, so Apple accepts the key, team and JWT.
  - To switch it on, add to `~/.t3/service.env` and restart in the next round:
    `STOREFRONT_APNS_KEY_FILE=/home/wouter/.t3/storefront/AuthKey_R2MGM4T6A5.p8`,
    `STOREFRONT_APNS_KEY_ID=R2MGM4T6A5`, `STOREFRONT_APNS_TEAM_ID=2Z43A4WSC3`,
    `STOREFRONT_APNS_TOPICS=be.storefront.code,be.storefront.code.dev`.
  - Server live on the Omarchy host since 2026-11-26 16:59 (`0.1.12-storefront.68`, the
    `STOREFRONT_APNS_*` lines in `service.env`; the log says "Storefront host push enabled").
  - TestFlight build 202611261527 did not show the Notifications row: without T3 Connect, Settings
    shows upstream's local list, which has only Environments. Fixed on 2026-11-26: the local list
    shows Notifications too, and the app asks for notification permission itself once the first
    paired host can push (upstream asks after a Connect sign-in), then registers with the hosts.
  - Checked on the iPhone on 2026-11-26 with build 202611261654: alerts and Live Activities work.
  - Still running: T3 Connect's tunnel. The host still starts `cloudflared` to T3's managed endpoint
    (`t3coderelay-managedendpoint-prod-…`, `logs/relay-client.ndjson`) from the link stored in
    `secrets/cloud-*`, so T3's relay can still reach this host. `t3 connect unlink` does not exist in
    our build (no T3 Connect configuration). Next server round: `"connect": false` in the managed
    policy; at startup the server then unlinks itself and starts no tunnel (`CloudLink.ts`:1690).
  - Android gets nothing (no FCM). Two push hosts: alerts from both, the card only from the first.

### F6: own Apple account

- To change in `apps/mobile/app.config.ts`: bundle IDs (app, `.widgets`, `.sharing`), App Group,
  URL schemes (also `src/App.tsx`:144-146), `appleTeamId`, associated domains (remove), keychain
  groups, Clerk Sign in with Apple (off), Expo `slug`, update URL, `eas.projectId` and `owner`, the
  `app.t3.codes` link filters. In `eas.json`: `ascAppId`.
- Apple side: App IDs for the app and both extensions with Push Notifications and App Groups, one
  App Group, an APNs key (.p8).
- Build without EAS: `expo prebuild -p ios` with `T3CODE_MOBILE_UPDATES_ENABLED=0`, then Xcode
  Archive and upload. Internal TestFlight needs no Beta App Review; builds expire after 90 days.
- Done in `apps/mobile/storefront-identity.ts` (verified by evaluating `app.config.ts` for the
  production and development variants: no `t3tools`, "T3 Code" or `t3.codes` left in the config):
  - name "Storefront Code" (Dev/Preview variants get the suffix), icon from the Storefront mark;
  - bundle IDs `be.storefront.code`, `.dev`, `.preview`, each with `.widgets` and `.sharing`;
    App Group `group.<bundle ID>`; keychain group follows the bundle ID;
  - no associated domains, no Sign in with Apple, no Expo `owner`, project ID or updates, no
    default trace URL, no `app.t3.codes` Android intent filter.
- Names and look in the app (2026-11-26, after Wouter saw "T3 Code BETA" and the "T3" mark on
  the lock screen in build 202611261654):
  - The home screen says "Code" (`CFBundleDisplayName`, Wouter's choice); texts say
    "Storefront Code".
  - App icon B (Wouter's choice of three): a purple-to-cyan gradient with a white glass S, as an
    iOS 26 Icon Composer project (`fork/assets/storefront-code.icon`), so iOS draws the dark, tinted
    and clear looks. Splash: the gradient S. All generated by `fork/scripts/brand-assets.py` from
    `fork/assets/storefront-mark.svg`, also the widget and Live Activity mark
    (`apps/mobile/assets/widget/T3Mark.svg`, upstream's asset name).
  - The title reads "S Code" (`T3Wordmark.tsx` draws the S mark, as on web); no "Beta" badge
    (`CompactBrandTitle.tsx`, `BrandMark.tsx`); the loading screen shows our icon (`brandAssets.ts`).
  - Strings: a Babel plugin (`apps/mobile/storefront-names.babel.cjs`, one line in
    `babel.config.js`) turns "T3 Code" into "Storefront Code" in every string of the workspace's
    own code while Metro bundles, so new upstream strings are covered too. It keeps "T3 Connect",
    "T3 Account" and "the T3 team": those name T3's services, on screens this build hides. Two
    native strings (photo permission) are edited in Swift. Other locales fall back to English for
    the renamed strings. `fork/scripts/ios-testflight.sh` empties Metro's cache first and prints the
    home-screen name and the count of "T3 Code" left in the bundle.
  - Not renamed: the `t3code://` link scheme, internal names (`T3Mark`, `font-t3-*`) and the web
    app's strings (those need a server round).
- Apple side (2026-11-26):
  - Team ID `2Z43A4WSC3` set in `storefront-identity.ts`.
  - App Store Connect API key (Admin) for builds and `fork/scripts/asc.mjs`. Key ID and issuer ID
    live outside the repo (on the Omarchy PC in `~/.local/share/storefront-code/asc.env`), the key
    in `~/.appstoreconnect/private_keys/` (mode 600). Never commit either.
  - Registered with `node fork/scripts/asc.mjs register`: `be.storefront.code` and
    `be.storefront.code.dev`, each with `.widgets` and `.sharing`; Push Notifications on both apps,
    App Groups on all six. The App Group containers themselves are created by Xcode's automatic
    signing at the first build (the API has no endpoint for them).
  - App record "Storefront Code" (`be.storefront.code`, App Store Connect ID 6839547728), created by
    hand on 2026-11-26 (the API cannot create apps).
  - Internal TestFlight group "Storefront" with access to all builds, every team user in it
    (`node fork/scripts/asc.mjs testers`).
- Build Mac: MacBook Air (macOS 27.0.1), reachable over Tailscale as `macbook` (key
  `id_system_storefront`). Toolchain: Homebrew, mise (node 26.13.1, pnpm 12.14.0), CocoaPods
  1.17.0, the API key in `~/.appstoreconnect/private_keys/`, the fork in
  `~/Business/Workspace/storefront-code`. Xcode from the App Store is 27.2 (upstream builds with
  27.1). Keep the lid open: a sleeping Mac drops SSH and stops builds.
- Build: `fork/scripts/ios-testflight.sh` on the Mac (telemetry guard, prebuild, archive, upload).
- Signing: automatic, through the API key. The login keychain is locked over SSH, so signing uses
  our own keychain `~/Library/Keychains/storefront-build.keychain-db` on the Mac
  (`fork/scripts/ios-build-keychain.sh`): random password in `~/.config/storefront-code/` (mode
  600), Apple Development and Apple Distribution identities created through the API from keys
  generated on the Mac. No user password is needed for builds.
- Development signing during archive needs at least one registered device: the iPhone 16 Pro Max
  and the iPad Pro 12.9" (5th generation) are registered (`node fork/scripts/asc.mjs device …`).
- **First TestFlight upload: build `202611261129` on 2026-11-26** (base v0.1.12 + fork patches,
  commit `3aa379cbe`). Follow processing with `node fork/scripts/asc.mjs builds`. The export warns
  about missing dSYMs for prebuilt frameworks; harmless (we have no crash reporting).
- The build Mac is reached over the LAN (`192.168.0.153`) when Tailscale is slow to connect.
- **Storefront Code paired with the Omarchy host on 2026-11-26** over Tailscale Serve:
  `https://omarchy.taila38105.ts.net` proxies to `127.0.0.1:3773` (tailnet only). The host keeps
  "Local network" off (`T3CODE_LAN=false`), so the LAN never sees plain HTTP. Pair a device with
  `~/.t3/runtime/versions/0.1.10/t3 pair --tailscale --label "<device>"` (use the runtime's own
  `t3`: the AUR `t3` on PATH is 0.1.11 and refuses to touch the 0.1.10 server's database), and scan
  the code from inside Storefront Code, not the Camera app (both apps register `t3code://`).
- App Groups cannot be created or assigned through the API: `group.be.storefront.code` and
  `group.be.storefront.code.dev` are created and assigned by hand in the developer portal.
- Still open:
  - URL scheme stays `t3code` (and `t3code-dev`, `t3code-preview`): changing it means editing
    `src/App.tsx`:143-145, both widget files and `package.json` scripts. Widget and Live Activity
    taps go to the app that owns them, but a `t3code://` link opened elsewhere may open the
    official app while both are installed.
  - The widget mark (`apps/mobile/assets/widget/T3Mark.svg`) and texts inside the app still say
    T3; fine for our own TestFlight, to replace before any wider distribution.
  - `eas.json` still names T3's App Store app (`ascAppId`); unused, because we do not build or
    submit with EAS.
- Requirements from upstream: Xcode 27.1 on macOS Tahoe 26.6 (`eas.json` build image), Node
  26.13.1, pnpm 12.14.0.

### N1: one combined usage meter

- Done on 2026-11-26 (branch `storefront-usage-display`, commit `fork: pooled usage limits draw one
  combined meter`). Usage → Limits draws one meter per pooled window on web and mobile
  (`UsageLimitsPooled.tsx` in both apps). Each account fills its share of the pool's capacity times
  what it has left, so the fill ends at the pool's headline number. The shares are the plan weights
  the pool's number already used (Codex Plus and Pro, Claude session Pro, Max and Ultra; equal when
  any plan is unknown), now exposed as `LimitPoolWindow.shares` (3 lines in
  `packages/shared/src/usageLimits.ts`).
- Each account keeps its column number in its part of the meter and in its legend row, which now
  shows at every width and opens the account (web popover, mobile account screen). The coming
  resets are hatched after the fill; the even-pace mark is the share-weighted time left.
- Geometry in `poolMeter` (`packages/shared/src/usageLimitsDisplay.ts`), shared by both apps.
- Not covered: the home-screen widget (`apps/mobile/src/widgets`) still draws one segment per account.
- Checked on web through Vitest browser screenshots; mobile not seen on a device.

### N2: % used / % remaining

- Done on 2026-11-26 (branch `storefront-usage-display`, commit `fork: usage limits read as % left
  or % used`). One setting, "% left" (default, unchanged) or "% used", as Ideas #32499 and #30076
  propose: it flips the numbers, words, bar fill, even-pace mark and screen-reader labels on
  Usage → Limits (meter, legend, account details, HTTP quota sources), the composer's
  `/usage-limits` panel, web's thread details card and the mobile thread indicator (F4). Warning
  colors keep following what is left. Read as used, the pooled meter draws no refill hatching.
- Web and desktop: `usageLimitDisplay` client setting (`UsageLimitDisplay` in
  `packages/contracts/src/settings.ts`), Settings → Appearance → Usage limit display
  (`UsageLimitDisplayRow.tsx`, in the settings search). Mobile: `usageLimitDisplay` in mobile
  preferences, Settings → Appearance → Usage limits. Each device keeps its own choice.
- Copy and `shownPercent` live in `packages/shared/src/usageLimitsDisplay.ts`; the "% left" strings
  keep their existing catalog keys.
- Translations: the new strings are not in the catalogs (`vp run i18n:check` lists them) and render
  in English. Run `vp run i18n:generate` in `apps/web` and `apps/mobile` before upstreaming; it was
  left out so parallel fork branches do not conflict in 20 catalog files.
- Not covered: the home-screen widgets; web's Appearance "Restore defaults" does not reset it (the
  row has its own reset).

### N3: remote API

- `/mcp` (OAuth) already covers all six: `t3_thread_launch`, `t3_thread_read`/`list`/`search`,
  `t3_thread_wait` and MCP events, `t3_thread_send`, `t3_thread_organize` (settle/unsettle).
- Gaps: OAuth needs HTTPS (Tailscale Serve); sign-ins last 30 days without refresh; webhooks to
  Tailscale addresses need `T3CODE_MCP_WEBHOOK_ALLOWED_HOSTS`; the events buffer is in memory;
  thread links in MCP replies point at `app.t3.codes` until `T3CODE_HOSTED_APP_URL` is set (see
  [Host configuration](#host-configuration)).

## Upstream contributions

| Item                             | Kind                                                                                                                                                         | State                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own transcription endpoint (F2)  | Existing Idea [#32516](https://github.com/pingdotgg/t3code/discussions/32516) (16 upvotes, many +1s, no maintainer reply)                                    | Upvote and add our case (draft for Wouter)                                                                                                                                                    |
| Deepgram as provider (F2)        | Existing Idea [#36900](https://github.com/pingdotgg/t3code/discussions/36900)                                                                                | Covered by #32516 for us                                                                                                                                                                      |
| Usage indicator in a thread (F4) | Existing Ideas [#40926](https://github.com/pingdotgg/t3code/discussions/40926), [#41449](https://github.com/pingdotgg/t3code/discussions/41449)              | Upvote #40926 and add the mobile case (draft for Wouter)                                                                                                                                      |
| % used / % remaining (N2)        | Existing Ideas [#32499](https://github.com/pingdotgg/t3code/discussions/32499) (15 upvotes), [#30076](https://github.com/pingdotgg/t3code/discussions/30076) | Upvote #32499                                                                                                                                                                                 |
| B1, B2, B3                       | PRs (3 = the open-PR limit)                                                                                                                                  | Ready: reproduced and fixed on our build (on `storefront`; branch `storefront-ios-bugs`); each fix applies cleanly on upstream `main`; evidence in `~/.local/share/storefront-code/evidence/` |

Upstream's stance on outside provider work (2026-11-12, Theo closing
[#32530](https://github.com/pingdotgg/t3code/pull/32530), a custom OpenAI-compatible speech provider
that a collaborator had already fixed up): "We are not expanding provider support through outside
PRs right now. This includes presets, ACP flavors, speech providers and usage integrations." So F2
stays in the fork until a maintainer approves the scope. #32530 (MIT) is a good starting point for
our patch: it is close to what upstream would accept, but it hides the option on mobile, which we
need.

## Sync log

| Date       | Upstream tag | Notes                                                                                                                                                                                                                                                                                        |
| ---------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-26 | v0.1.12      | Hardening branch built as `0.1.12-storefront.48` (not installed): guard, gate (typecheck, tests), web boot, smoke test and artifact check passed; title and manifest say Storefront Code, no Google favicon URL. The previous script would have failed after the web build (quoting), fixed. |
| 2026-11-26 | v0.1.12      | Omarchy host switched to `0.1.12-storefront.31` (Storefront mark in the web UI).                                                                                                                                                                                                             |
| 2026-11-26 | v0.1.12      | First own builds: iOS TestFlight `202611261129`, Linux runtime `0.1.12-storefront.25` (verified: no `ingest.t3.codes`, no PostHog key, no Axiom, update source `storefront-bvba/storefront-code`).                                                                                           |
| 2026-11-26 | v0.1.12      | Fork created (`storefront-bvba/storefront-code`); `storefront` branched from the tag. GitHub Actions disabled in the fork (upstream workflows need upstream's runners).                                                                                                                      |

## Decisions

| Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-26 | Fork upstream directly. Not m3code (huge diff, CI never runs, renumbered migrations) or pseudoseed/t3code_dev (one maintainer, keeps Clerk).                                                                                                                                                                                                                                                      |
| 2026-11-26 | Name: Storefront Code.                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-11-26 | Keep T3 Connect until our own push works.                                                                                                                                                                                                                                                                                                                                                         |
| 2026-11-26 | Notifications and Live Activities look exactly as before: same fields as upstream's payloads (titles, model, phase, status); Apple sees them in transit.                                                                                                                                                                                                                                          |
| 2026-11-26 | No separate E2E work; the home LAN is trusted.                                                                                                                                                                                                                                                                                                                                                    |
| 2026-11-26 | Dropped: monospaced font option, environment cue per thread.                                                                                                                                                                                                                                                                                                                                      |
| 2026-11-26 | Web UI branding kept minimal: only the SVG behind `T3Wordmark`, the web icons, window titles and the web manifest's name change, so the sidebar reads "S Code" and tabs say "Storefront Code"; body texts keep "T3 Code".                                                                                                                                                                         |
| 2026-11-26 | Feature ideas go to upstream's Ideas discussions first; where an Idea already exists, we upvote it and add our case instead of opening a new one.                                                                                                                                                                                                                                                 |
| 2026-11-26 | Hardening after the fork review (`~/.local/share/storefront-code/fork-analysis-2026-11-26.md`): privacy goes into a managed policy, triage is off (it reports to upstream), and the Linux build gates on typecheck, tests, the telemetry guard and an artifact check. Copied "Copy thread" links in the web UI keep pointing at `app.t3.codes` (changing them is M and touches `threadLinks.ts`). |
| 2026-11-26 | Voice (F2): Deepgram runs behind the environment's own speech service and stream, not as a separate service; nova-3 multilingual with nl-BE and en hints on the EU endpoint; on the phone, cleanup runs automatically when the environment uses Deepgram.                                                                                                                                         |
