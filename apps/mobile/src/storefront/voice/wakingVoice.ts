// Storefront Code (fork): dictation to a sleeping environment (F8, wish of 2026-11-27). Recording
// starts at once while the environment is woken; once it is awake its live stream gets the audio
// the phone held back, or the recording file is uploaded, so nothing has to be said again.
import type { EnvironmentId } from "@t3tools/contracts";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

import { livePcm } from "./liveVoice";

const WAIT_FOR_WAKE_MS = 3 * 60_000;
const NUDGE_EVERY_MS = 5_000;

/** The environment a recording waits for, for the composer's dictation row. */
export const voiceWake = (() => {
  let waiting: { readonly name: string } | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => waiting,
    set(next: { readonly name: string } | null) {
      if (next === waiting) return;
      waiting = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
})();

export interface WakingTarget<Connection> {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly connection: () => Connection | null;
  readonly onConnection: (listener: () => void) => () => void;
  readonly nudge: (environmentId: EnvironmentId) => void;
  readonly transcriber: (connection: Connection) => VoiceTranscriber;
}

/** Resolves with the environment's connection once it is back, or fails after a few minutes. */
function awaitConnection<Connection>(target: WakingTarget<Connection>, signal: AbortSignal) {
  return new Promise<Connection>((resolve, reject) => {
    const finish = (outcome: () => void) => {
      clearInterval(nudging);
      clearTimeout(deadline);
      stopWatching();
      signal.removeEventListener("abort", aborted);
      outcome();
    };
    const check = () => {
      const connection = target.connection();
      if (connection !== null) finish(() => resolve(connection));
    };
    const aborted = () =>
      finish(() => {
        try {
          throwIfVoiceTranscriptionAborted(signal);
        } catch (error) {
          reject(error);
        }
      });
    const stopWatching = target.onConnection(check);
    const nudging = setInterval(() => target.nudge(target.environmentId), NUDGE_EVERY_MS);
    const deadline = setTimeout(
      () =>
        finish(() =>
          reject(
            new VoiceTranscriptionError({
              code: "unavailable",
              message: `${target.name} did not wake up. Try again once it is awake.`,
            }),
          ),
        ),
      WAIT_FOR_WAKE_MS,
    );
    signal.addEventListener("abort", aborted, { once: true });
    target.nudge(target.environmentId);
    check();
  });
}

const wakingTranscribers = new WeakSet<VoiceTranscriber>();

export function wakingTranscriber<Connection>(target: WakingTarget<Connection>): VoiceTranscriber {
  const transcriber: VoiceTranscriber = {
    async prepare({ signal }) {
      livePcm.hold();
      voiceWake.set({ name: target.name });
      const done = () => voiceWake.set(null);
      signal.addEventListener("abort", done, { once: true });
      // Prepared as soon as the environment answers, while the user may still be speaking.
      const awake: Promise<PreparedVoiceTranscription> = awaitConnection(target, signal).then(
        (connection) => {
          done();
          return target.transcriber(connection).prepare({ signal });
        },
      );
      awake.catch(done);
      return {
        locale: "auto",
        async transcribe(uri, transcription) {
          return (await awake).transcribe(uri, transcription);
        },
      };
    },
  };
  wakingTranscribers.add(transcriber);
  return transcriber;
}

const routeGrants = new WeakMap<VoiceTranscriber, object>();

/** Notes which voice choice a route's transcriber serves, so a wake-up can be told apart. */
export function markVoiceRoute<T extends VoiceTranscriber | null>(
  transcriber: T,
  grant: object,
): T {
  if (transcriber !== null) routeGrants.set(transcriber, grant);
  return transcriber;
}

type Route = { readonly transcriber: VoiceTranscriber | null } | null;

/**
 * The recording started while its environment slept; that environment waking up (or the relay
 * briefly not answering) keeps it. A changed voice choice still cancels, as upstream does.
 */
export function keepsRecordingOnRouteChange(previous: Route, next: Route): boolean {
  const before = previous?.transcriber;
  if (before == null || !wakingTranscribers.has(before) || next === null) return false;
  return next.transcriber === null || routeGrants.get(next.transcriber) === routeGrants.get(before);
}
