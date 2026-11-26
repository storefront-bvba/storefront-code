import { useAtomValue } from "@effect/atom-react";
import type { UsageLimitDisplay } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../../../state/preferences";
import { useAtomCommand } from "../../../../state/use-atom-command";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

const USAGE_LIMIT_DISPLAY_OPTIONS: ReadonlyArray<{
  readonly value: UsageLimitDisplay;
  readonly label: string;
}> = [
  { value: "remaining", label: msg("% left", { $context: "usage limits show the share left" }) },
  { value: "used", label: msg("% used", { $context: "usage limits show the share used" }) },
];

export function UsageLimitsAppearanceSection() {
  const gt = useGT();
  const m = useMessages();
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  const display = loaded ? (preferences.value.usageLimitDisplay ?? "remaining") : null;
  const inThreads = loaded && preferences.value.threadUsageIndicatorEnabled !== false;

  return (
    <View className="gap-3">
      <SettingsSection title={gt("Usage limits")}>
        {USAGE_LIMIT_DISPLAY_OPTIONS.map((option, index) => (
          <ListChoiceRow
            key={option.value}
            label={m(option.label)}
            selected={display === option.value}
            separated={index > 0}
            disabled={display === null}
            onPress={() => {
              void savePreferences({ usageLimitDisplay: option.value });
            }}
          />
        ))}
        <SettingsSwitchRow
          disabled={!loaded}
          icon="chart.bar.xaxis"
          label={gt("Show in threads")}
          value={inThreads}
          onValueChange={(value) => {
            void savePreferences({ threadUsageIndicatorEnabled: value });
          }}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        <T>
          Show usage limits as the share left or the share used. Numbers and bars follow. Threads
          show their account&apos;s tightest limit in the top corner; tap it for all limits.
        </T>
      </Text>
    </View>
  );
}
