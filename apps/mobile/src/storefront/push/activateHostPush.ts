// Storefront Code (fork): without T3 Connect, agent awareness runs against the paired hosts
// (fork/design/F5-host-push.md). Called once at startup where upstream drops the relay account.
import { setManagedRelaySession } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { requestAgentNotificationPermission } from "../../features/agent-awareness/notificationPermissions";
import {
  refreshActiveLiveActivityRemoteRegistration,
  refreshAgentAwarenessRegistration,
  setAgentAwarenessRelayTokenProvider,
} from "../../features/agent-awareness/remoteRegistration";
import { deactivateCloudRelayAccount } from "../../features/cloud/cloudAccountService";
import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { hostPushRelay, pushHostsAtom, pushHostsKey } from "./hostPushClient";
import { bumpHostPushAttempt, setHostPushHostsKey } from "./hostPushKey";
import { bindHostRelay } from "./hostRelayClient";

const HOST_PUSH_IDENTITY = "storefront-host-push";
// remoteRegistration asks for a relay token before each call; the hosts know the phone already.
const hostPushToken = () => Promise.resolve<string | null>(HOST_PUSH_IDENTITY);

let stopWatchingHosts: (() => void) | null = null;
let askedForNotifications = false;

/**
 * Upstream asks for notifications after a T3 Connect sign-in, which this build never has. Ask once
 * the first paired host can send push instead; iOS shows its prompt only while nothing was chosen.
 */
async function askForNotificationsOnce(): Promise<void> {
  if (askedForNotifications) return;
  askedForNotifications = true;
  const before = await Notifications.getPermissionsAsync().catch(() => null);
  if (before === null || before.granted || !before.canAskAgain) return;
  const result = await runtime.runPromise(requestAgentNotificationPermission).catch(() => null);
  if (result?.type === "granted") await registerAgain();
}

function registerAgain(): Promise<void> {
  return runtime
    .runPromise(
      Effect.all(
        [refreshAgentAwarenessRegistration(), refreshActiveLiveActivityRemoteRegistration()],
        {
          discard: true,
        },
      ),
    )
    .catch(() => undefined);
}

/** Registers the device and the card with every host again, even when nothing changed. */
export function registerWithHostsAgain(): Promise<void> {
  bumpHostPushAttempt();
  return registerAgain();
}

export function activateHostPush(): void {
  // The hosts reach Apple only; Android would need FCM.
  if (Platform.OS !== "ios") {
    deactivateCloudRelayAccount();
    return;
  }
  bindHostRelay(hostPushRelay);
  setManagedRelaySession(appAtomRegistry, null);
  let previousKey: string | null | undefined;
  stopWatchingHosts?.();
  stopWatchingHosts = appAtomRegistry.subscribe(
    pushHostsAtom,
    (hosts) => {
      const key = pushHostsKey(hosts);
      setHostPushHostsKey(key);
      if (key !== null) void askForNotificationsOnce();
      // A new host, or a new session on one, gets the device and the card at once.
      if (previousKey !== undefined && key !== null && key !== previousKey) void registerAgain();
      previousKey = key;
    },
    { immediate: true },
  );
  setAgentAwarenessRelayTokenProvider(hostPushToken, HOST_PUSH_IDENTITY);
}
