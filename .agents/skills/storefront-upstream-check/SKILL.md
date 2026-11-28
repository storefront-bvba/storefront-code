---
name: storefront-upstream-check
description: Weekly check whether a newer upstream T3 Code stable release is worth rebasing Storefront Code onto. Reads the release notes, looks for anything new that phones home, new migrations and dependencies, checks whether upstream now fixes something the fork carries, estimates the rebase conflicts with a dry-run merge, runs the fork's guards on the merged tree, and advises. Advice only, it never rebases, builds or restarts. Use when asked whether a new T3 Code version is worth a rebase, "kijk of er goeie dingen in de laatste T3 Code zitten", "is een rebase de moeite waard", for the weekly upstream check, or /storefront-upstream-check.
---

# Storefront Code: weekly upstream check

The fork tracks upstream's stable tags (`vX.Y.Z`, no suffix), which come every 2 to 5 days. This
check tells Wouter whether rebasing `storefront` onto the newest one is worth a server round now.
The rebase itself is a separate job that follows the sync checklist in
[fork/GOAL.md](../../../fork/GOAL.md); do it only when Wouter asks.

## 1. Gather

Run `fork/scripts/upstream-check.sh` (optionally with a tag) from the repo. It takes about 20 s,
reads refs only and prints:

- the versions: fork base, the newest stable tag, how far `main` is ahead;
- the release highlights and every PR line (saved in `/tmp/storefront-upstream-check/<tag>/prs.txt`;
  grep that file, the notes run to 60 KB);
- the watched paths of sync step 1, dependency lines, new migrations, hosts in added lines;
- the files our patches change that upstream changed too, and the files a dry-run merge conflicts in;
- both guards on `storefront` merged with the tag, in a scratch worktree beside the repo that is
  removed afterwards.

If it says "Nothing newer than the fork base", report that and stop.

## 2. Judge

Read the patch list and the Overview table at the top of
[fork/GOAL-CURRENT-STATUS.md](../../../fork/GOAL-CURRENT-STATUS.md) (the whole file is 700+ lines;
those two parts are enough). Then go through `prs.txt` with our setup in mind:

- **What we run:** the server as a background service on the Omarchy PC (Linux); Claude Code as
  the provider, through a CLIProxyAPI hub; the web UI in a browser over Tailscale Serve; the iOS app
  on iPhone and iPad (TestFlight); Deepgram voice through the speech service (`customWords.ts`,
  `/ws/voice`); our own push; sleep and wake.
- **What does not count:** Android, Windows/WSL, the Electron desktop app, the macOS-only code,
  providers we do not run, workflows we do not use, and T3 Connect, the relay, Clerk and the cloud
  (off by policy). Watch those paths for privacy only.
- **Carried patches upstream may now fix**, so we can drop ours (sync step 6). Grep `prs.txt` per item:
  B1 `Live Activity|widget|deep link`, B2 `selection|back gesture|composer editor`, B3
  `dock|tab bar|bottom bar`, F3 `subagent|effort`, F4/N1/N2 `usage|pooled|limit`, F2
  `voice|dictat|speech|transcri`, F5 `push|notification|APNs`, F8 `sleep|wake|idle`, N3
  `MCP|webhook|OAuth`. Read the commit (`git show <hash>`) before claiming that a fix covers ours.
- **Privacy:** `telemetry|analytic|PostHog|trace|Sentry|Axiom|crash|update check`, plus the watched
  paths and the guard. Each new outbound host gets a look at its code. A schema ID or docs link is
  harmless; a fetch is a finding.
- **Guard results:** files that still hold conflict markers give false findings. Since v0.1.13,
  `AnalyticsService.ts` conflicts on the lines patch 2 empties, so the guard reports
  `ingest.t3.codes` and `phc_` there until patch 2 is carried over. To be sure, resolve that file in
  a scratch worktree and run the guard again. Notes that the baseline can shrink are good news.
  Never run `--update` during a check.
- **Upstream follow-up:** the state of our PRs and Ideas in the status doc's Upstream contributions
  table (`gh pr view <n> -R pingdotgg/t3code --json state,reviewDecision`).

Advice, one of:

- **Rebase now**, in its own server round: a security or data-loss fix that hits our setup, a bug
  Wouter runs into, or a carried patch that upstream now ships.
- **With the next server round** (the usual case): useful fixes for our setup, nothing urgent.
  Check "Next" in the status doc for a planned round to join.
- **Skip this tag:** nothing for our setup, or a blocker (a real guard finding, an odd migration, a
  dependency that phones home) that needs work first. Skipping costs little, since the next
  check covers both tags, but conflicts grow with the distance.

Cost, always stated: the conflicts (file and cause, from the dry run), new migrations (forward
only), and what has to ship. Server and app come from one base, so a rebase means a server round
(one restart, only when no thread runs) and a TestFlight build.

## 3. Report and record

Report to Wouter in Dutch:

1. the advice in one sentence, with the reason;
2. what the tag brings us: at most about eight points, each with its PR number and why it matters
   for our setup;
3. carried patches upstream now fixes, or "geen";
4. privacy: the guard outcome, explained;
5. the cost: conflicts, migrations, dependencies, what has to ship;
6. upstream follow-up: our PRs and Ideas.

Then add a row to the sync log in the status doc: date, tag, "check, not synced", the advice in a
few words. Commit it with `fork: upstream check <tag>` only when Wouter asks, or when he ends the
session. When he decides to wait, record that in the same row; the next weekly check advises
again, so no task is needed. Only a rebase he plans for a moment of his own goes on his
"TODO Wouter" list (skill `takenlijst-todo-wouter`), titled "Storefront Code: rebase op <tag>".

## Traps

- `git -C <repo> worktree add <relative path>` creates the worktree inside the repo. Always pass
  an absolute path (the script does).
- `node … | tail` reports `tail`'s exit code, not the guard's. The script checks the guard itself.
- Do not start servers, `vp i` or builds for a check. Everything here runs on refs and plain Node.
