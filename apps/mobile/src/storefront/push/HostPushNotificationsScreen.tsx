/* oxlint-disable t3code/no-untranslated-copy -- Storefront Code's own screen, English only so far. */
// Storefront Code (fork): notification settings without T3 Connect. The paired hosts send push
// themselves; this screen asks for permission, switches Live Activities and shows each host.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settleAsyncResult,
  settlePromise,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import * as Notifications from "expo-notifications";
import { useGT } from "gt-react-native";
import { useState, useSyncExternalStore } from "react";
import { Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { setLiveActivityUpdatesEnabled } from "../../features/agent-awareness/liveActivityPreferences";
import { requestAgentNotificationPermission } from "../../features/agent-awareness/notificationPermissions";
import {
  agentAwarenessNotificationsReady,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../../features/agent-awareness/remoteRegistration";
import { SettingsRow } from "../../features/settings/components/SettingsRow";
import { SettingsScreen } from "../../features/settings/components/SettingsScreen";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../features/settings/components/SettingsSwitchRow";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import { runtime } from "../../lib/runtime";
import { loadAgentAwarenessDeviceId } from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { registerWithHostsAgain } from "./activateHostPush";
import {
  hostPushStatusAtom,
  pushHostsAtom,
  sendHostTestPush,
  type HostAnswer,
  type HostPushStatus,
  type PushHost,
} from "./hostPushClient";

const permissionAtom = makePermissionStatusAtom<"checking" | "enabled" | "disabled">({
  label: "storefront:host-push-permission",
  initial: "checking",
  read: async () => {
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    return result._tag === "Success" && result.value.granted ? "enabled" : "disabled";
  },
});

function describeHost(state: HostAnswer<HostPushStatus> | null): string {
  if (state === null) return "Checking…";
  switch (state._tag) {
    case "Unsupported":
      return "This host cannot send push";
    case "Refused":
      return state.status === 0 ? "Not reachable right now" : `Answered ${state.status}`;
    case "Ok": {
      const status = state.value;
      if (!status.enabled) return "Push is not set up on this host";
      const device = status.device;
      if (!device?.registered) return "This phone is not registered yet";
      return [
        device.hasPushToken ? "Notifications" : "No push token",
        device.hasLiveActivity ? "Live Activity" : null,
        device.apsEnvironment,
      ]
        .filter(Boolean)
        .join(" · ");
    }
  }
}

function HostRow(props: {
  readonly host: PushHost;
  readonly label: string;
  readonly onPress: () => void;
}) {
  const state = useAtomValue(hostPushStatusAtom(props.host.environmentId));
  return (
    <SettingsRow
      icon="server.rack"
      label={props.label}
      value={describeHost(AsyncResult.isSuccess(state) && !state.waiting ? state.value : null)}
      valuePosition="below"
      onPress={props.onPress}
    />
  );
}

export function HostPushNotificationsScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const hosts = useAtomValue(pushHostsAtom);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const permission = useAtomValue(permissionAtom);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const liveActivitiesEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;
  const notificationsReady = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    agentAwarenessNotificationsReady,
    () => false,
  );
  const [busy, setBusy] = useState(false);
  const refreshHosts = () => {
    for (const host of hosts) appAtomRegistry.refresh(hostPushStatusAtom(host.environmentId));
  };

  const enableNotifications = async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((granted) =>
            granted.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    appAtomRegistry.refresh(permissionAtom);
    refreshHosts();
    if (result._tag === "Success" && result.value.type === "denied" && !result.value.canAskAgain) {
      Dialog.alert(
        gt("Notifications disabled"),
        gt("Notifications were denied for this app. Open Settings to enable them."),
        [
          { text: gt("Cancel"), style: "cancel" },
          { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
        ],
      );
    }
  };

  const setLiveActivities = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          enabled,
          previousEnabled: liveActivitiesEnabled,
          clerkToken: null,
          connections: [],
          updateEnvironment: () => Effect.succeed("unsupported" as const),
          linkEnvironment: () => Effect.void,
          canUpdateEnvironment: () => false,
          canConfigureEnvironment: () => false,
          saveLocalPreference: (value) =>
            saveMobilePreferences.run(appAtomRegistry, { liveActivitiesEnabled: value }),
        }),
      ),
    );
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(gt("Live Activities unavailable"), "No host took the new setting. Try again.");
    }
    refreshHosts();
  };

  const testHost = async (environmentId: EnvironmentId) => {
    const deviceId = await loadAgentAwarenessDeviceId().catch(() => null);
    if (deviceId === null) return;
    const result = await Effect.runPromise(sendHostTestPush(environmentId, deviceId));
    if (result._tag === "Ok" && result.value.ok) {
      Dialog.alert("Test sent", "Apple accepted it; the notification should appear shortly.");
      return;
    }
    Dialog.alert(
      "Test not sent",
      result._tag === "Ok"
        ? `${result.value.apnsStatus ?? ""} ${result.value.apnsReason ?? ""}`.trim()
        : describeHost(result),
    );
  };

  return (
    <SettingsScreen title={gt("Notifications")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={gt("Agent activity")}>
          <SettingsSwitchRow
            icon="bell.badge"
            label={gt("Device Notifications")}
            disabled={Platform.OS !== "ios" || permission === "checking"}
            subtitle="Sent by your hosts straight to Apple"
            value={permission === "enabled" && notificationsReady}
            onValueChange={(enabled) => {
              if (enabled) {
                void enableNotifications();
                return;
              }
              Dialog.alert(
                gt("Disable notifications"),
                gt("Open system Settings to disable notifications for {product}.", {
                  product: "Storefront Code",
                }),
                [
                  { text: gt("Cancel"), style: "cancel" },
                  { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
                ],
              );
            }}
          />
          <SettingsSwitchRow
            icon="bolt.circle"
            label={gt("Live Activity Updates")}
            disabled={Platform.OS !== "ios" || busy}
            subtitle="Fed by the first host below"
            value={liveActivitiesEnabled}
            onValueChange={(enabled) => void setLiveActivities(enabled)}
          />
        </SettingsSection>
        <SettingsSection title="Hosts">
          {hosts.length === 0 ? (
            <SettingsRow icon="server.rack" label="No paired host sends push yet" />
          ) : (
            hosts.map((host) => (
              <HostRow
                key={host.environmentId}
                host={host}
                label={
                  savedConnectionsById[host.environmentId]?.environmentLabel ?? host.environmentId
                }
                onPress={() => void testHost(host.environmentId)}
              />
            ))
          )}
          <SettingsRow
            icon="arrow.clockwise"
            label="Register this phone again"
            onPress={() => void registerWithHostsAgain().then(refreshHosts)}
          />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
