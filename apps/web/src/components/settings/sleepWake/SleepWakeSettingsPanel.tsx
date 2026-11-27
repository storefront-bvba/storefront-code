/* oxlint-disable t3code/no-untranslated-copy -- Storefront Code's own screen, English only so far. */
// Storefront Code (fork): Settings → Sleep & wake, one card per environment plus the relay's other
// hosts (fork/design/F8-sleep-and-wake.md, "App"). Web is served by an awake host, so it can put
// hosts to sleep and wake the others.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, StorefrontPowerStatus } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useState, type ReactNode } from "react";

import { useStableCallback } from "../../../hooks/useStableCallback";
import { useEnvironments } from "../../../state/environments";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import type { PowerSwitch } from "./powerHost";
import {
  knownRelaysAtom,
  powerStatusAtom,
  relayHostsAtom,
  relaysKey,
  setPowerSwitch,
} from "./powerState";
import {
  armedDescription,
  cannotWakeText,
  pendingSecondsLeft,
  relayStateLabel,
  splitRelayHosts,
  type RelayHostEntry,
  type RelayHostState,
} from "./sleepWake.logic";
import { SLEEP_WAKE_SEARCH_ID } from "./sleepWakeSettingsEntry";
import { wakeRelayHost } from "./wakeRelayClient";

const REFRESH_INTERVAL_MS = 10_000;

const STATE_BADGE_VARIANTS = {
  awake: "success",
  waking: "info",
  asleep: "secondary",
  unreachable: "warning",
  unknown: "outline",
} as const satisfies Record<RelayHostState, string>;

export function SleepWakeSettingsPanel() {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const relays = useAtomValue(knownRelaysAtom);
  const relayAtom = relayHostsAtom(relaysKey(relays));
  const relayReads = AsyncResult.getOrElse(useAtomValue(relayAtom), () => []);
  const environmentIds = environments.map((environment) => environment.environmentId);
  const { byEnvironment, unmatched } = splitRelayHosts(
    environmentIds,
    relayReads.flatMap((read) => (read.hosts ?? []).map((host) => ({ relay: read.relay, host }))),
  );

  const refreshRelay = useStableCallback(() => registry.refresh(relayAtom));
  const refreshAll = useStableCallback(() => {
    for (const environmentId of environmentIds) registry.refresh(powerStatusAtom(environmentId));
    registry.refresh(relayAtom);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the hosts and the wake relay every 10 s while the page is visible
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") refreshAll();
    };
    const timer = window.setInterval(refreshIfVisible, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refreshAll]);

  return (
    <SettingsPageContainer>
      {relayReads.some((read) => read.hosts === null) ? (
        <Note error>Could not reach the wake relay.</Note>
      ) : null}
      {environments.map((environment, index) => (
        <EnvironmentCard
          key={environment.environmentId}
          id={index === 0 ? SLEEP_WAKE_SEARCH_ID : undefined}
          environmentId={environment.environmentId}
          name={environment.label}
          relayEntry={byEnvironment.get(environment.environmentId) ?? null}
          onWoken={refreshRelay}
        />
      ))}
      {unmatched.map((entry) => (
        <SettingsSection
          key={entry.host.id}
          aria-label={entry.host.name}
          title={entry.host.name}
          headerAction={<StateBadge state={entry.host.state} />}
        >
          <WakeRow entry={entry} state={entry.host.state} onWoken={refreshRelay} />
        </SettingsSection>
      ))}
    </SettingsPageContainer>
  );
}

function StateBadge({ state }: { state: RelayHostState | null }) {
  if (state === null) return null;
  return (
    <Badge variant={STATE_BADGE_VARIANTS[state]} size="lg">
      {relayStateLabel(state)}
    </Badge>
  );
}

function Note({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return error ? (
    <p role="alert" className="px-3 py-3 text-xs text-destructive sm:px-4">
      {children}
    </p>
  ) : (
    <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">{children}</p>
  );
}

function EnvironmentCard({
  id,
  environmentId,
  name,
  relayEntry,
  onWoken,
}: {
  id: string | undefined;
  environmentId: EnvironmentId;
  name: string;
  relayEntry: RelayHostEntry | null;
  onWoken: () => void;
}) {
  const registry = useContext(RegistryContext);
  const atom = powerStatusAtom(environmentId);
  const result = useAtomValue(atom);
  const setSwitch = useAtomCommand(setPowerSwitch, { reportFailure: false });
  // A change's answer shows until a read started after it lands; the read before it is `basis`.
  const [written, setWritten] = useState<{
    readonly status: StorefrontPowerStatus;
    readonly basis: typeof result;
  } | null>(null);
  if (written !== null && written.basis !== result && !result.waiting) setWritten(null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const read =
    written !== null
      ? ({ _tag: "Ok", status: written.status } as const)
      : AsyncResult.isSuccess(result)
        ? result.value
        : null;
  const status = read?._tag === "Ok" ? read.status : null;
  // A host that answers is awake, whatever its last heartbeat told the relay.
  const state = read !== null ? "awake" : (relayEntry?.host.state ?? null);

  const change = async (which: PowerSwitch, on: boolean) => {
    setBusy(true);
    setWriteError(null);
    const outcome = await setSwitch({ environmentId, which, on });
    setBusy(false);
    if (AsyncResult.isSuccess(outcome) && outcome.value._tag === "Ok") {
      setWritten({ status: outcome.value.status, basis: registry.get(atom) });
      registry.refresh(atom);
    } else {
      setWriteError("Could not change this setting. Try again.");
    }
  };
  const refreshStatus = useStableCallback(() => registry.refresh(atom));

  return (
    <SettingsSection
      id={id}
      aria-label={name}
      title={name}
      headerAction={<StateBadge state={state} />}
    >
      {read === null ? (
        AsyncResult.isFailure(result) ? (
          <Note>Could not reach this environment.</Note>
        ) : (
          <Note>Checking…</Note>
        )
      ) : status === null ? (
        <Note>This environment does not offer Sleep & wake.</Note>
      ) : !status.supported ? (
        <Note>This machine cannot be kept awake or put to sleep from here.</Note>
      ) : (
        <>
          <SettingsRow
            title="Stay awake"
            description="Keeps this machine from going to sleep."
            control={
              <Switch
                aria-label="Stay awake"
                checked={status.stayAwake}
                disabled={busy}
                onCheckedChange={(checked) => void change("stayAwake", checked)}
              />
            }
          />
          <SleepWhenDoneRow
            status={status}
            busy={busy}
            onChange={(on) => void change("sleepWhenDone", on)}
            onUndoWindowOver={refreshStatus}
          />
        </>
      )}
      {writeError ? <Note error>{writeError}</Note> : null}
      {status?.lastError ? <Note error>{status.lastError}</Note> : null}
      {relayEntry !== null && state !== null ? (
        <WakeRow entry={relayEntry} state={state} onWoken={onWoken} />
      ) : null}
    </SettingsSection>
  );
}

function SleepWhenDoneRow({
  status,
  busy,
  onChange,
  onUndoWindowOver,
}: {
  status: StorefrontPowerStatus;
  busy: boolean;
  onChange: (on: boolean) => void;
  onUndoWindowOver: () => void;
}) {
  const { state, pendingUntil } = status.sleepWhenDone;
  const button = (label: string, on: boolean) => (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => onChange(on)}>
      {label}
    </Button>
  );
  if (state === "pending") {
    return (
      <SettingsRow
        title="Sleep when done"
        description={
          <UndoCountdown key={pendingUntil} pendingUntil={pendingUntil} onOver={onUndoWindowOver} />
        }
        control={button("Undo", false)}
      />
    );
  }
  if (state === "armed") {
    return (
      <SettingsRow
        title="Sleeps when done"
        description={armedDescription(status.waitingFor)}
        control={button("Cancel", false)}
      />
    );
  }
  return (
    <SettingsRow
      title="Sleep when done"
      description="Puts this machine to sleep once its agents are done and the screen is locked."
      control={button("Sleep when done", true)}
    />
  );
}

function UndoCountdown({
  pendingUntil,
  onOver,
}: {
  pendingUntil: string | null;
  onOver: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const seconds = pendingSecondsLeft(pendingUntil, now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks the undo countdown each second, then asks the host for its armed state
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (pendingSecondsLeft(pendingUntil, next) > 0) return;
      window.clearInterval(timer);
      onOver();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pendingUntil, onOver]);
  return seconds > 0 ? `Starts in ${seconds} s. Undo keeps it awake.` : "Starting…";
}

function WakeRow({
  entry,
  state,
  onWoken,
}: {
  entry: RelayHostEntry;
  state: RelayHostState;
  onWoken: () => void;
}) {
  const { host, relay } = entry;
  const [sending, setSending] = useState(false);
  // Set once the relay took the wake-up; the relay's next answer carries a new wakeRequestedAt.
  const [sentBefore, setSentBefore] = useState<{ readonly at: string | null } | null>(null);
  if (sentBefore !== null && sentBefore.at !== host.wakeRequestedAt) setSentBefore(null);
  const [error, setError] = useState<string | null>(null);

  if (!host.canWake) return <Note>{cannotWakeText(host)}</Note>;
  if (state === "awake") return null;
  const waking = sending || sentBefore !== null || state === "waking";

  const wake = async () => {
    setSending(true);
    setError(null);
    const at = host.wakeRequestedAt;
    const sent = await wakeRelayHost(relay, host.id).then(
      () => true,
      () => false,
    );
    setSending(false);
    if (sent) {
      setSentBefore({ at });
      onWoken();
    } else {
      setError("Could not send the wake-up.");
    }
  };

  return (
    <>
      <SettingsRow
        title="Wake up"
        description="Wakes this machine over the network."
        control={
          <Button size="sm" variant="outline" disabled={waking} onClick={() => void wake()}>
            {waking ? "Waking…" : "Wake up"}
          </Button>
        }
      />
      {error ? <Note error>{error}</Note> : null}
    </>
  );
}
