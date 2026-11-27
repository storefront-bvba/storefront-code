# Storefront Code: goal

Storefront Code is an unofficial fork of the T3 Code source code. It is not affiliated with,
endorsed by, or maintained by T3 Tools, Inc. "T3 Code" is their trademark (see
[TRADEMARK.md](../TRADEMARK.md)); our builds use their own name, icon and identifiers.

This file says what we want and how we work, so the goal survives many rebases. What is done and
what is open lives in [GOAL-CURRENT-STATUS.md](GOAL-CURRENT-STATUS.md): update it whenever
something changes.

## Why this fork exists

We use T3 Code every day to drive Claude Code on several machines, from the desktop and from an
iPhone. Its threads, settling and unsettling, delegation and linked environments are what we
depend on, and we have nothing against the project.

In November 2026 it became public that T3 Code had sent product analytics by default since March
2026, after the homepage had promised "no telemetry unless you opt in" (that promise was removed
in June 2026), and that it derived install IDs from Claude and Codex sign-in files. Upstream
removed the sign-in file reads in v0.1.12, but analytics stay on by default. We want a build where
privacy is not a setting someone can change for us, plus a few fixes and features for our iPhone
workflow.

## How we work

- **Stay close to upstream.** Upstream moves fast (about 6,000 commits a month). Every line we
  carry has to survive a weekly rebase, so the fork stays a thin patch set.
- **Contribute what upstream will take.** Upstream accepts bug fixes from outside the team (see
  [CONTRIBUTING.md](../CONTRIBUTING.md)): one problem per PR, at most 3 open PRs per person,
  evidence of the bug and the fix (before/after screenshots, a short video for motion). Feature
  ideas go to the [Ideas discussions](https://github.com/pingdotgg/t3code/discussions/categories/ideas)
  first; a feature PR is only opened when a maintainer asks for it. Never automate or spam them.
- **Carry the rest ourselves**, in this order of preference:
  1. configuration (environment, `settings.json`, build variables) over code;
  2. new files with a one-line mount over edits in existing files;
  3. small edits in files that rarely change over edits in hot files.
- **Track stable releases, not `main`.** The fork is rebased onto the newest stable tag
  (`vX.Y.Z`, roughly weekly). Server, desktop and app are built from the same base.
- **Keep the two docs current.** Every change, PR, sync and decision updates
  [GOAL-CURRENT-STATUS.md](GOAL-CURRENT-STATUS.md).
- **One server build, one restart per round.** A host restart interrupts Wouter's work, so all
  changes that touch the server or the web UI are collected and shipped together, and the host
  restarts once (only when no thread runs). App-only changes ship through TestFlight in between.
- **Every sync re-checks every goal.** A clean rebase proves nothing: upstream can add telemetry,
  a new outbound connection or a new dependency without touching our patches, and it can fix a
  bug or add a feature we carry ourselves. Never sync blindly; work through the checklist below.

## Sync checklist (every rebase or update)

Before switching any machine to a new build, and recorded in the sync log of
[GOAL-CURRENT-STATUS.md](GOAL-CURRENT-STATUS.md):

1. **Read what changed upstream** between the old and the new tag (release notes and
   `git diff <old>..<new> --stat`), with extra attention for `apps/server/src/telemetry`,
   `packages/shared/src/cliRelease.ts`, `apps/mobile/app.config.ts`, `infra/relay`,
   `apps/server/src/relay`, `apps/server/src/cloud` and every `package.json`.
2. **Look for anything new that phones home**: new hard-coded hosts and URLs in shipped code (the
   guard lists each host that is not in its reviewed baseline), new analytics, tracing,
   crash-reporting or update SDKs, new defaults that switch something on, new background checks.
   Neutralise each one (config first, a small patch second) before the build ships.
3. **Run the guards** `node fork/scripts/check-telemetry.mjs` (the Linux build runs it too) and
   `node fork/scripts/check-push-port.mjs`. A failure is a finding to resolve, never something to
   `--update` away without reading it.
4. **Check every built artifact**, not only the source: the Linux runtime and the iOS app must not
   contain `ingest.t3.codes`, a PostHog key, Axiom, `u.expo.dev` or upstream's release source
   (`pingdotgg/t3code/releases`), and must contain our update source.
   `node fork/scripts/check-telemetry.mjs --artifact <unpacked build>` checks this; the Linux build
   runs it on its archive.
5. **Walk every wish** in the overview table of the status doc and confirm it still holds on the
   new base (privacy, Tailscale only, own push, own Apple identity, and each fixed bug).
6. **Re-evaluate every carried patch.** If upstream now fixes a bug or ships a feature we carry,
   test whether their version meets our goal. If it does, drop our patch and use theirs. If it
   only partly does, keep what is missing and note why. Never keep two versions of one feature.
7. **Follow up upstream**: PRs merged or closed, Ideas answered. Drop merged patches, record the rest.
8. **Data continuity**: list new database migrations in the diff (they must only move forward),
   back up `~/.t3/userdata`, and switch through `fork/scripts/install-runtime.sh`.

## Rules that always hold

- **No data loss, no fresh start.** We continue on the T3 Code data we already have:
  - Use the same T3 home (`~/.t3`): threads, projects, settings, secrets, the environment ID and
    paired devices stay where they are.
  - Never run a fork build that is older than the version a machine last ran. Database migrations
    only go forward.
  - Never add our own migrations to upstream's migration chain; a renumbered chain locks us out of
    upstream. Fork-only state lives in its own files.
  - Switch runtimes through T3's launcher, which snapshots SQLite and rolls back a failed start,
    and take our own copy of `~/.t3/userdata` before each switch. Keep the previous runtime for
    rollback.
  - Do not interrupt running threads: restart a service only when no thread is running or waiting.
  - Install runtimes only with `fork/scripts/install-runtime.sh`. `npx t3`, `npm install --global
    t3`, `t3.codes/install.sh` and the web UI's update hints install upstream builds, with
    analytics on by default.
- **Zero telemetry.** No product analytics, tracing, crash reporting or install IDs leave our
  machines. A guard test fails the build when a sync brings any of it back.
- **No third party in the data path.** Devices reach hosts over Tailscale (or the trusted LAN at
  home). No T3 Connect, no Clerk, no relay. Push notifications go from our own host straight to
  Apple.
  - _2026-11-26:_ notifications and Live Activities look exactly as they did with upstream, so
    they carry the same fields: project and thread titles, model, phase and status. Apple's push
    service sees those in transit, as it did before. Prompts, replies and file contents never go
    into a push.
- **No secrets in this repository.** It is public (a GitHub fork of a public repository). Apple
  keys, API keys and tokens stay out of git.
- **Our own identity.** App name "Storefront Code", our own icon, bundle IDs, App Group, URL scheme
  and Apple team. Builds go to our own TestFlight.

## Branches

| Branch        | Content                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `main`        | Mirror of upstream `main`. Never commit to it.                                                                                           |
| `storefront`  | Default working branch: the newest upstream stable tag plus our patch stack, one commit per change. The `fork/` folder exists only here. |
| `fix/<topic>` | One upstream PR each, cut from `upstream/main`. Once merged upstream, the matching commit drops out of `storefront` at the next rebase.  |

The `upstream` remote has its push URL disabled on purpose.

## The wishes

Written by Wouter on 2026-11-26. Changes to a wish are noted in place, with a date.

### Essential bug fixes

- Clicking on the "live updates" (an iOS feature on the lock screen) opens the app where it was.
  It would be better if it opened the first "waiting for input" thread, or if there isn't one a
  "done" thread because that's likely the reason you tapped the "live update" widget.
- When typing a prompt in the textarea, you can't select text to the left because the panel moves
  to close. You can select text to the right, just not to the left. This makes text editing hard.
  The panel should not move when trying to select text.
- The app has a small bottom menu bar which is hidden when in a thread. However, there are times
  when you end up in a thread and the footer menu is still shown. This blocks the prompt textarea
  preventing normal interaction. I believe this situation occurs when clicking the live updates or
  other link that takes you to a specific thread while the menu was still open.

### Essential features

- Full privacy and no telemetry or user tracking of any kind.
- 2-step voice input like Claude Code has. This should use the environment's voice capabilities.
  The first step shows words as you speak. When done speaking a 2nd step automatically cleans up
  the input (punctuation, corrections, capitals, ehms, etc). After that you can either edit or send
  the message. In 99.9% of the cases the message should already be good and you send it right
  away. On the environment's side there is support for Deepgram's API which can do the 2-step
  approach.
  - _2026-11-26:_ approach: an "own endpoint" option for transcription on the environment, with our
    own small service behind it that calls Deepgram and returns cleaned-up text. Live words while
    speaking need a streaming path and are the larger part.
  - _2026-11-26:_ optimised for Flemish Dutch (nl-BE) with IT jargon in between and short English
    phrases or words (code-switching). The Deepgram API key is handed over in `~/Desktop/secret.txt`
    and lives on the host, never in this repository.
- When you have subagents running, you can't see which model they are and what effort they run at.
- Seeing a simple usage indicator in a corner while in a thread would be great to know if you're
  running out. This should be accurate for the current thread.
  - _2026-11-26:_ this is display only: the app already has the numbers (Usage page and
    `/usage-limits`); nothing extra has to be fetched.
- No T3 Connect for connecting environments and apps, but using only Tailscale (or the LAN).
- Use our own Apple Developer account for push notifications and live updates instead of T3. We
  deploy using TestFlight.
  - _2026-11-27:_ a finished thread only plays a sound, without a text notification; the Live
    Activity on the lock screen shows what is done, and that is enough.
- _2026-11-27:_ Sleep when done. A "Sleep when done" toggle puts the environment to sleep once it
  is done: no working threads any more and nobody at the computer (screen locked). Waking it up
  goes through Wake-on-LAN, from a small relay on o1 (which is always on), for example in the
  Docker VM on o1 we use for small Docker apps. Both the Omarchy PC and the MacBook should be
  wakeable when they are needed; the MacBook has no environment yet, we will give it one. The iOS
  app gets better sleep/awake detection through the relay and a "Wake up" function. The relay has
  a REST API.
  - _2026-11-27:_ it also waits for a quiet computer: heavy processes still running in the
    background must not be cut off because Storefront Code is done.
- Full end-to-end encryption.
  - _2026-11-26:_ nothing to build. Tailscale encrypts device-to-host traffic, the home LAN is
    trusted, T3 Connect goes away, and our own push payloads carry no content.

### Nice to haves

- The usage graph when you have multiple accounts combined should add up to 1 large meter instead
  of multiple meters stitched together.
- The usage meter should be switchable to % used vs % remaining. This can be confusing as some
  apps report it differently.
- A secure API to create, read, follow, message, settle and unsettle threads from a remote server
  (i.e. a ticket system or ERP starts a thread and work starts automatically).

### Dropped

- _A monospaced font option._ Dropped on 2026-11-26: not worth the effort (web and desktop already
  have font pickers; mobile would need a new setting).
- _A visual cue per thread showing its environment._ Dropped on 2026-11-26: the app already shows
  an environment icon and name when more than one connection is saved.
