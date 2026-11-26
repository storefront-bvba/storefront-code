/**
 * Storefront Code: step 2 of dictation on the phone. When the chosen environment transcribes
 * through Deepgram, its transcript goes to that environment's cleanup model (Settings → Voice →
 * Cleanup model) before it lands in the draft, as web does with Transcript cleanup on. A slow or
 * failed cleanup leaves the raw transcript.
 */
import type { VoiceInputControllerDependencies } from "@t3tools/client-runtime/voice-input";
import { postProcessEnvironmentTranscript } from "@t3tools/client-runtime/voice-input";
import type { AtomRegistry } from "effect/reactivity";

import {
  runSpeech,
  voiceConnectionAtom,
  voiceGrantAtom,
} from "../../features/voice-input/voiceDestination";
import { transcribesWithDeepgram } from "./liveVoice";

const CLEANUP_TIMEOUT_MS = 20_000;
const CONTEXT_CHARACTERS = 1_024;

type Draft = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

/** Up to 1,024 characters before, inside and after the selection, as web sends them. */
function cleanupContext({ text, selection }: Draft): Draft {
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  const before = text.slice(Math.max(0, start - CONTEXT_CHARACTERS), start);
  const selected = text.slice(start, Math.min(end, start + CONTEXT_CHARACTERS));
  return {
    text: before + selected + text.slice(end, end + CONTEXT_CHARACTERS),
    selection: { start: before.length, end: before.length + selected.length },
  };
}

export function environmentTranscriptCleanup(
  registry: AtomRegistry.AtomRegistry,
): NonNullable<VoiceInputControllerDependencies["postProcess"]> {
  return (transcript, { signal, draft }) => {
    const grant = registry.get(voiceGrantAtom);
    if (grant?.destination.kind !== "environment") return null;
    const connectionAtom = voiceConnectionAtom(grant.destination.environmentId);
    const prepared = registry.get(connectionAtom);
    if (!prepared || !transcribesWithDeepgram(prepared)) return null;
    const canSend = () =>
      registry.get(voiceGrantAtom) === grant && registry.get(connectionAtom) === prepared;
    return runSpeech(
      postProcessEnvironmentTranscript(
        prepared,
        transcript,
        cleanupContext(draft),
        {
          speechCustomWords: [],
          speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
        },
        canSend,
      ),
      AbortSignal.any([signal, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)]),
      canSend,
    ).then((result) => result.text);
  };
}
