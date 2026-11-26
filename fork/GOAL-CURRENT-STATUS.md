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
- **Run the guard** after every rebase: `node fork/scripts/check-telemetry.mjs`.
- **Expected upstream test failure:** `apps/mobile/app.config.test.ts` ("keeps the iOS and Android
  identifiers") asserts T3's bundle IDs and domains, so it fails in the fork by design.

## Overview

Sizes: S = hours, M = a day or two, L = several days. "Upstream" is our estimate of whether
upstream would take it.

| # | Wish | State | Route | Size | Upstream |
| --- | --- | --- | --- | --- | --- |
| B1 | Live Activity tap opens the right thread | Open: cause found in code, not reproduced | Upstream PR (fix); order change in fork | S | Good for the fix |
| B2 | Selecting text to the left closes the panel | Open: likely cause found, not reproduced | Upstream PR | S–M | Good |
| B3 | Bottom menu bar stays visible in a thread | Open: likely cause found, not reproduced | Upstream PR | S–M | Good |
| F1 | No telemetry or tracking | Fork patch and guard done; Omarchy host still runs official builds with opt-outs | Config + small patch + guard | S | No (on by default upstream) |
| F2 | 2-step voice input (Deepgram) | Not started | Own endpoint option (Idea #32516, fork meanwhile) + own Deepgram service; live words in fork | M–L | No for now (closed #32530) |
| F3 | Subagent model and effort visible | Mostly exists; gap for Claude Code's own subagents | Try as bug-fix PR | M | Doubtful to good |
| F4 | Usage indicator in a thread | Not started; data already in the app | Idea #40926, fork meanwhile | S–M | Doubtful (feature) |
| F5 | Only Tailscale or LAN, no T3 Connect | Storefront Code paired over Tailscale Serve (2026-11-26); push and Live Activities still need Connect | Fork: host sends push itself | L | No (new connection method) |
| F6 | Own Apple account, TestFlight | Done: first build uploaded to TestFlight on 2026-11-26 | Fork: `storefront-identity.ts`, `fork/scripts/` | S | No |
| F7 | Full end-to-end encryption | Decided: nothing to build | Follows from F5 and push design | – | – |
| N1 | One combined usage meter for pooled accounts | Not started | Fork | S–M | No |
| N2 | Toggle % used / % remaining | Not started | Fork | S–M | No |
| N3 | Remote API for ERP / ticket system | Exists via `/mcp`; config gaps | Config, maybe a small patch | S | – |

## Machines

| Machine | State |
| --- | --- |
| Omarchy PC (host) | **Runs our build `0.1.12-storefront.31` since 2026-11-26 14:14** (built with `fork/scripts/build-linux-cli.sh`, switched with `fork/scripts/install-runtime.sh`: backup `~/.t3/backups/2026-11-26-1414-before-0.1.12-storefront.31`, threads 432 → 432, telemetry opt-out in the server's environment). `t3` on PATH is ours (`~/.local/bin/t3`). T3 pruned the old 0.1.10 runtime after the switch, so rollback means: restore the database backup and install an earlier archive from `build/linux-cli/`. The web icons, `storefront-mark.svg` and the loading-screen line of `client/index.html` of this runtime were patched in by hand once (the fixes came after the build; the next build has them). `t3code-bin` (desktop app and CLI) removed; Tailscale 1.104.7. The web UI opens from the launcher "Storefront Code" in its own extension-free Chromium profile; the Mac uses `https://omarchy.taila38105.ts.net` in Chrome. |
| iPhone | Storefront Code from TestFlight, paired over Tailscale. The official T3 Code app (through T3 Connect) stays installed until Storefront Code covers push and Live Activities. |
| MacBook Air (2025) | Not used yet. Needed for Xcode builds and TestFlight uploads, unless CI builds take over. |

## Details

### B1: Live Activity tap

- Each Live Activity row already carries a thread deep link (`/threads/<env>/<thread>`): the widget
  turns the chosen row into a `t3code://` URL (`apps/mobile/src/widgets/AgentActivity.tsx`:178-183,
  271) and the app opens it (`apps/mobile/src/App.tsx`:141-166).
- Likely cause: when the app starts a Live Activity itself, the row's deep link is `"/"`
  (`apps/mobile/src/features/agent-awareness/remoteRegistration.ts`:545). That becomes a bare
  `t3code://`, which the app's link filter drops on purpose (`apps/mobile/src/lib/appLinking.ts`:15),
  so a tap does nothing until a relay push replaces the row.
- Today's order of choice: approval/input, failed, running, done. "Done before running" is a
  behaviour change, so fork-only (`AgentActivity.tsx`:178, and `AgentActivityWidget.tsx`:103 for the
  home-screen widget).
- Related upstream: #18997 (Dynamic Island, fixed in #19022), #26544 (open: an approval notification
  does not open its thread).

### B2: text selection closes the panel

- Likely cause: the iOS 26 full-screen swipe-back gesture, which only checks stack depth
  (react-native-screens fork, `RNSStackNavigationController.mm`:29-45, 101-107, vendored in
  `apps/mobile/deps/react-native-screens-5.0.0-t3.63.tgz`). The composer does not stop it
  (`apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift`:598-601, 657-667).
- Caveat: that gesture starts on a left-to-right drag, the opposite of what we see. Reproduce on the
  device first.
- Fix in the composer's Swift module (not in the vendored screens tarball, which cannot be patched
  with pnpm): no back gesture while the text view has focus or a selection.

### B3: bottom menu bar in a thread

- The bar hides when a thread is pushed, the home list is not showing and the window is not split
  (`apps/mobile/src/features/layout/createWorkspaceStackNavigator.ios.tsx`:522-529). "Home list
  showing" comes from native appear/disappear events (`apps/mobile/src/native/createV5StackNavigator.ios.tsx`:179-181,
  218-219) and only resets when the top thread changes (`createWorkspaceStackNavigator.ios.tsx`:497-503).
- Likely cause: a deep link replaces the stack while a menu is open over Home; the overlay's
  dismissal fires the root's "will appear" event after the push, and reopening the same thread keeps
  its route key, so the reset never runs.
- Fix: derive visibility from the router state instead of the last native event. Upstream fixed a
  sibling bug themselves (#36975).

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
- Web: link favicons are fetched from each linked site (`packages/shared/src/favicon.ts`:3-8).

Plan for the fork: analytics default off (or no ingest URL) in `AnalyticsService.ts`, mobile updates
off in `app.config.ts`, build without `.env` (no Connect, Clerk, relay, Axiom), and a guard test
modelled on pseudoseed/t3code_dev's `scripts/no-upstream-telemetry.test.ts` (MIT).
`AnalyticsService.ts` changed 11 times in 30 days, but lines 70-80 only 4 times since August.

### F2: voice

- Mobile today: on-device Apple Speech (iOS 26), passing final results only
  (`apps/mobile/modules/t3-voice-transcription/ios/AppleSpeechEngine.swift`:77), or environment and
  cloud transcription that upload the recording when you stop. No live words on mobile.
- Cloud transcription URLs are hard-coded: OpenAI, xAI, OpenRouter
  (`apps/server/src/speech/CloudSpeech.ts`:30-34). The cleanup model can already be any
  OpenAI-compatible endpoint (`textGenerators` with `kind: "openaiCompatible"`).
- Cleanup and "send after dictation" exist on web only (`apps/web/src/speech/voiceInputSession.ts`:194-230).
- Deepgram is not supported anywhere.
- Plan: (1) an "own endpoint (OpenAI-compatible)" transcription option, with our own service on the
  host that calls Deepgram and returns cleaned-up text; supported upstream in Idea #32516, carried in
  the fork meanwhile, starting from closed PR #32530 plus the mobile destination
  (`CloudSpeech.ts` changed twice in 30 days). (2) Live words: a streaming path from the phone
  through the host to Deepgram, fork-only.

### F3: subagent model and effort

- Mobile already shows "provider · model · effort" for subagents
  (`apps/mobile/src/features/threads/SubagentRow.tsx`:151-186); web in a tooltip.
- Gap: Claude Code's own (Task) subagents. The model is known only when the Task call names one,
  else after the first streamed reply; the effort only after the subagent finishes
  (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`:8770-8787, 12220-12245).
- That adapter is the hottest file we would touch (175 commits in 30 days): try as an upstream fix.

### F4: usage indicator

- The composer's `/usage-limits` panel already reads the thread's account limits
  (`apps/mobile/src/features/threads/ComposerUsageLimits.tsx`), the same data as the Usage page.
- Web and desktop have it as an option (Settings → Appearance → Thread details → Usage limits).
- Plan: a small always-visible indicator in its own file, one-line mount in the thread screen
  (`ThreadDetailScreen.tsx` is hot: 57 commits in 30 days).

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
- Payloads: IDs, phase and counts only. Live Activity pushes cannot be decrypted on the device, so
  titles come from what the app caches in its App Group.

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

### N3: remote API

- `/mcp` (OAuth) already covers all six: `t3_thread_launch`, `t3_thread_read`/`list`/`search`,
  `t3_thread_wait` and MCP events, `t3_thread_send`, `t3_thread_organize` (settle/unsettle).
- Gaps: OAuth needs HTTPS (Tailscale Serve); sign-ins last 30 days without refresh; webhooks to
  Tailscale addresses need `T3CODE_MCP_WEBHOOK_ALLOWED_HOSTS`; the events buffer is in memory.

## Upstream contributions

| Item | Kind | State |
| --- | --- | --- |
| Own transcription endpoint (F2) | Existing Idea [#32516](https://github.com/pingdotgg/t3code/discussions/32516) (16 upvotes, many +1s, no maintainer reply) | Upvote and add our case (draft for Wouter) |
| Deepgram as provider (F2) | Existing Idea [#36900](https://github.com/pingdotgg/t3code/discussions/36900) | Covered by #32516 for us |
| Usage indicator in a thread (F4) | Existing Ideas [#40926](https://github.com/pingdotgg/t3code/discussions/40926), [#41449](https://github.com/pingdotgg/t3code/discussions/41449) | Upvote #40926 and add the mobile case (draft for Wouter) |
| % used / % remaining (N2) | Existing Ideas [#32499](https://github.com/pingdotgg/t3code/discussions/32499) (15 upvotes), [#30076](https://github.com/pingdotgg/t3code/discussions/30076) | Upvote #32499 |
| B1, B2, B3 | PRs (3 = the open-PR limit) | After reproducing on our own build |

Upstream's stance on outside provider work (2026-11-12, Theo closing
[#32530](https://github.com/pingdotgg/t3code/pull/32530), a custom OpenAI-compatible speech provider
that a collaborator had already fixed up): "We are not expanding provider support through outside
PRs right now. This includes presets, ACP flavors, speech providers and usage integrations." So F2
stays in the fork until a maintainer approves the scope. #32530 (MIT) is a good starting point for
our patch: it is close to what upstream would accept, but it hides the option on mobile, which we
need.

## Sync log

| Date | Upstream tag | Notes |
| --- | --- | --- |
| 2026-11-26 | v0.1.12 | Omarchy host switched to `0.1.12-storefront.31` (Storefront mark in the web UI). |
| 2026-11-26 | v0.1.12 | First own builds: iOS TestFlight `202611261129`, Linux runtime `0.1.12-storefront.25` (verified: no `ingest.t3.codes`, no PostHog key, no Axiom, update source `storefront-bvba/storefront-code`). |
| 2026-11-26 | v0.1.12 | Fork created (`storefront-bvba/storefront-code`); `storefront` branched from the tag. GitHub Actions disabled in the fork (upstream workflows need upstream's runners). |

## Decisions

| Date | Decision |
| --- | --- |
| 2026-11-26 | Fork upstream directly. Not m3code (huge diff, CI never runs, renumbered migrations) or pseudoseed/t3code_dev (one maintainer, keeps Clerk). |
| 2026-11-26 | Name: Storefront Code. |
| 2026-11-26 | Keep T3 Connect until our own push works. |
| 2026-11-26 | No separate E2E work; the home LAN is trusted. |
| 2026-11-26 | Dropped: monospaced font option, environment cue per thread. |
| 2026-11-26 | Web UI branding kept minimal: only the SVG behind `T3Wordmark` and the web icons change, so the sidebar reads "S Code". |
| 2026-11-26 | Feature ideas go to upstream's Ideas discussions first; where an Idea already exists, we upvote it and add our case instead of opening a new one. |
