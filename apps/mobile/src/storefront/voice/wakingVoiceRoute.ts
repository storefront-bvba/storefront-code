// Storefront Code (fork): the voice route for an environment that sleeps (F8). Upstream offers no
// transcriber without a connection and cancels a recording whenever the route changes; here a
// sleeping environment the wake relay can wake still takes dictation, and its waking up does not
// cancel the recording it was woken for.
import type { EnvironmentId } from "@t3tools/contracts";
import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import { AsyncResult, type Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { relayHostsAtom } from "../power/wakeRelayClient";
import { nudgeEnvironment } from "../power/nudgeEnvironment";
import { wakingTranscriber } from "./wakingVoice";

/** A transcriber that wakes `environmentId` first, or null when the relay cannot wake it. */
export function wakingVoiceTranscriber<Connection>(
  get: Atom.AtomContext,
  environmentId: EnvironmentId,
  connectionAtom: Atom.Atom<Connection | null>,
  transcriber: (connection: Connection) => VoiceTranscriber,
): VoiceTranscriber | null {
  const relay = get(relayHostsAtom);
  if (!AsyncResult.isSuccess(relay) || relay.value._tag !== "Ok") return null;
  const host = relay.value.hosts.find((candidate) => candidate.id === environmentId);
  if (!host?.canWake) return null;
  return wakingTranscriber({
    environmentId,
    name: host.name,
    connection: () => appAtomRegistry.get(connectionAtom),
    onConnection: (listener) => appAtomRegistry.subscribe(connectionAtom, listener),
    nudge: nudgeEnvironment,
    transcriber,
  });
}
