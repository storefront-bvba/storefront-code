/* oxlint-disable t3code/no-untranslated-copy -- Storefront Code's own copy, English only so far. */
import { useSyncExternalStore, type ReactNode } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { liveVoiceText } from "./liveVoice";
import { voiceWake } from "./wakingVoice";

/**
 * The words heard so far, newest kept in view; `fallback` (the waveform) until there are some.
 * While the environment wakes, it says so: the words follow once it is awake.
 */
export function LiveVoiceTranscript(props: { readonly fallback: ReactNode }) {
  const text = useSyncExternalStore(liveVoiceText.subscribe, liveVoiceText.get);
  const waking = useSyncExternalStore(voiceWake.subscribe, voiceWake.get);
  if (!text || !(text.committed || text.tentative)) {
    if (!waking) return props.fallback;
    return (
      <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={2}>
        Waking {waking.name}… keep talking, your words follow once it is awake
      </Text>
    );
  }
  return (
    <Text className="min-w-0 flex-1 text-sm text-foreground" ellipsizeMode="head" numberOfLines={2}>
      {text.committed}
      <Text className="text-sm text-foreground-muted">{text.tentative}</Text>
    </Text>
  );
}

/** The status after recording; while the environment still wakes, it says it waits for it. */
export function VoiceWakeLabel(props: { readonly fallback: string }) {
  const waking = useSyncExternalStore(voiceWake.subscribe, voiceWake.get);
  return waking ? `Waiting for ${waking.name} to wake…` : props.fallback;
}
