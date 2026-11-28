/* oxlint-disable t3code/no-untranslated-copy -- Storefront Code's own copy, English only so far. */
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { ScrollView, type ScrollViewInstance } from "react-native";

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

// About seven lines: a longer dictation scrolls, newest words in view (web shows about five).
const BLOCK_MAX_HEIGHT = 168;

/**
 * The words heard so far as a block above the dictation row, for composers with room for it:
 * it grows with the text up to about seven lines, then keeps the newest words in view.
 */
export function LiveVoiceTranscriptBlock() {
  const text = useSyncExternalStore(liveVoiceText.subscribe, liveVoiceText.get);
  const waking = useSyncExternalStore(voiceWake.subscribe, voiceWake.get);
  const scroll = useRef<ScrollViewInstance>(null);
  const hasWords = text !== null && Boolean(text.committed || text.tentative);
  if (!hasWords && !waking) return null;
  return (
    <ScrollView
      ref={scroll}
      accessibilityLabel="Live transcription"
      showsVerticalScrollIndicator={false}
      style={{ maxHeight: BLOCK_MAX_HEIGHT, marginHorizontal: 16, marginTop: 6, marginBottom: 2 }}
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
    >
      {hasWords ? (
        <Text className="text-base leading-6 text-foreground">
          {text.committed}
          <Text className="text-base leading-6 text-foreground-muted">{text.tentative}</Text>
        </Text>
      ) : (
        <Text className="text-base leading-6 text-foreground-muted">
          Waking {waking?.name}… keep talking, your words follow once it is awake
        </Text>
      )}
    </ScrollView>
  );
}

/** The status after recording; while the environment still wakes, it says it waits for it. */
export function VoiceWakeLabel(props: { readonly fallback: string }) {
  const waking = useSyncExternalStore(voiceWake.subscribe, voiceWake.get);
  return waking ? `Waiting for ${waking.name} to wake…` : props.fallback;
}
