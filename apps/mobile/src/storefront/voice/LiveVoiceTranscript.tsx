import { useSyncExternalStore, type ReactNode } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { liveVoiceText } from "./liveVoice";

/** The words heard so far, newest kept in view; `fallback` (the waveform) until there are some. */
export function LiveVoiceTranscript(props: { readonly fallback: ReactNode }) {
  const text = useSyncExternalStore(liveVoiceText.subscribe, liveVoiceText.get);
  if (!text || !(text.committed || text.tentative)) return props.fallback;
  return (
    <Text className="min-w-0 flex-1 text-sm text-foreground" ellipsizeMode="head" numberOfLines={2}>
      {text.committed}
      <Text className="text-sm text-foreground-muted">{text.tentative}</Text>
    </Text>
  );
}
