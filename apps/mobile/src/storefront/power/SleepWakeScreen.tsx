/* oxlint-disable t3code/no-untranslated-copy -- Storefront Code's own screen, English only so far. */
// Storefront Code (fork): Settings → Sleep & wake (fork/design/F8-sleep-and-wake.md). One section
// per paired host with its state, Wake up, Stay awake and Sleep when done; machines the wake relay
// knows without a pairing (the MacBook) follow under "Other machines".
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import type {
  EnvironmentId,
  StorefrontPowerStatus,
  StorefrontWakeRelayHost,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useCallback, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsRow } from "../../features/settings/components/SettingsRow";
import { SettingsScreen } from "../../features/settings/components/SettingsScreen";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../features/settings/components/SettingsSwitchRow";
import { useDeadlinePassed } from "../../lib/clock";
import { appAtomRegistry } from "../../state/atom-registry";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import type { HostAnswer } from "../push/hostPushClient";
import { relayStateLabel, sleepWhenDoneLabel } from "./sleepWakeLabels";
import { hostPowerStatusAtom, setSleepWhenDone, setStayAwake } from "./hostPowerClient";
import { type RelayHosts, relayHostsAtom, wakeHost } from "./wakeRelayClient";

const REFRESH_MS = 10_000;

/** Whole seconds until `untilMs`, re-rendered once a second without a timer of its own. */
function useSecondsLeft(untilMs: number | null): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const next = untilMs === null ? null : Math.min(untilMs, nowMs + 1000);
  const passed = useDeadlinePassed(next);
  if (passed && untilMs !== null && nowMs < untilMs) setNowMs(() => Date.now());
  return untilMs === null ? 0 : Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

const refreshHost = (environmentId: EnvironmentId) =>
  appAtomRegistry.refresh(hostPowerStatusAtom(environmentId));

function WakeRow(props: { readonly host: StorefrontWakeRelayHost }) {
  const [busy, setBusy] = useState(false);
  if (props.host.state === "awake") return null;
  if (!props.host.canWake) {
    return (
      <SettingsRow
        icon="slash.circle"
        label="Cannot be woken remotely"
        value={props.host.wakeNote ?? undefined}
        valuePosition="below"
      />
    );
  }
  const wake = async () => {
    setBusy(true);
    const outcome = await Effect.runPromise(wakeHost(props.host.id));
    setBusy(false);
    if (outcome !== "waking") {
      Dialog.alert(
        "Not woken",
        outcome === "cannotWake"
          ? "The relay cannot wake this machine."
          : "The wake relay did not answer. Try again in a moment.",
      );
    }
  };
  return (
    <SettingsRow
      icon="alarm"
      label={busy ? "Waking…" : "Wake up"}
      disabled={busy}
      onPress={() => void wake()}
    />
  );
}

function HostSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly relayHost: StorefrontWakeRelayHost | undefined;
}) {
  const result = useAtomValue(hostPowerStatusAtom(props.environmentId));
  const answer: HostAnswer<StorefrontPowerStatus> | null = AsyncResult.isSuccess(result)
    ? result.value
    : null;
  const status = answer?._tag === "Ok" ? answer.value : null;
  const pendingUntil =
    status?.sleepWhenDone.state === "pending" && status.sleepWhenDone.pendingUntil !== null
      ? Date.parse(status.sleepWhenDone.pendingUntil)
      : null;
  const secondsLeft = useSecondsLeft(pendingUntil);
  const [busy, setBusy] = useState(false);
  const relayLabel = relayStateLabel(props.relayHost);
  const hostLabel =
    answer === null
      ? "Checking…"
      : answer._tag === "Ok"
        ? "Connected"
        : answer._tag === "Unsupported"
          ? "This host has no sleep controls (older build)"
          : "Not reachable right now";

  const change = async (action: Effect.Effect<HostAnswer<StorefrontPowerStatus>>) => {
    setBusy(true);
    const next = await Effect.runPromise(action);
    setBusy(false);
    refreshHost(props.environmentId);
    if (next._tag !== "Ok") Dialog.alert("Not changed", "The host did not answer. Try again.");
  };
  const toggleSleep = () => {
    if (status === null) return;
    const on = status.sleepWhenDone.state === "off";
    void change(setSleepWhenDone(props.environmentId, on));
  };

  return (
    <SettingsSection title={props.label}>
      <SettingsRow
        icon="desktopcomputer"
        label={relayLabel ?? hostLabel}
        value={relayLabel !== null && answer?._tag !== "Ok" ? hostLabel : undefined}
        valuePosition="below"
      />
      {props.relayHost ? <WakeRow host={props.relayHost} /> : null}
      {status?.supported ? (
        <>
          <SettingsSwitchRow
            icon="sun.max"
            label="Stay awake"
            subtitle="Keeps this machine from sleeping until you turn it off"
            disabled={busy}
            value={status.stayAwake}
            onValueChange={(on) => void change(setStayAwake(props.environmentId, on))}
          />
          <SettingsRow
            icon="moon"
            label={sleepWhenDoneLabel(status, secondsLeft)}
            value={
              status.lastError ??
              (status.sleepWhenDone.state === "off"
                ? "Sleeps once no agent works and the screen is locked; then turns itself off"
                : undefined)
            }
            valuePosition="below"
            disabled={busy}
            onPress={toggleSleep}
          />
        </>
      ) : null}
    </SettingsSection>
  );
}

export function SleepWakeScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const relayResult = useAtomValue(relayHostsAtom);
  const relay: RelayHosts | null = AsyncResult.isSuccess(relayResult) ? relayResult.value : null;
  const relayHosts = relay?._tag === "Ok" ? relay.hosts : [];
  const environments = Object.values(savedConnectionsById);
  const paired = new Set<string>(environments.map((connection) => connection.environmentId));
  const others = relayHosts.filter((host) => !paired.has(host.id));

  useFocusEffect(
    useCallback(() => {
      const refresh = () => {
        appAtomRegistry.refresh(relayHostsAtom);
        for (const connection of environments) refreshHost(connection.environmentId);
      };
      refresh();
      const interval = setInterval(refresh, REFRESH_MS);
      return () => clearInterval(interval);
    }, [environments]),
  );

  return (
    <SettingsScreen title={gt("Sleep & wake")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environments.length === 0 ? (
          <SettingsSection title="Hosts">
            <SettingsRow icon="server.rack" label="No paired host yet" />
          </SettingsSection>
        ) : (
          environments.map((connection) => (
            <HostSection
              key={connection.environmentId}
              environmentId={connection.environmentId}
              label={connection.environmentLabel}
              relayHost={relayHosts.find((host) => host.id === connection.environmentId)}
            />
          ))
        )}
        {others.length > 0 ? (
          <SettingsSection title="Other machines">
            {others.map((host) => (
              <SettingsRow
                key={host.id}
                icon="laptopcomputer"
                label={`${host.name}: ${relayStateLabel(host) ?? ""}`}
                value={host.canWake ? undefined : (host.wakeNote ?? "Cannot be woken remotely")}
                valuePosition="below"
              />
            ))}
            {others
              .filter((host) => host.canWake)
              .map((host) => (
                <WakeRow key={`wake-${host.id}`} host={host} />
              ))}
          </SettingsSection>
        ) : null}
        {relay?._tag === "NoRelay" ? (
          <SettingsSection title="Wake relay">
            <SettingsRow
              icon="wifi"
              label="Not known yet"
              value="A host hands out the wake relay once it is set up there"
              valuePosition="below"
            />
          </SettingsSection>
        ) : relay?._tag === "Unreachable" ? (
          <SettingsSection title="Wake relay">
            <SettingsRow
              icon="wifi.slash"
              label="Not reachable"
              value="Check Tailscale on this phone"
              valuePosition="below"
            />
          </SettingsSection>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
