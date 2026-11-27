import type { UsageLimitDisplay } from "@t3tools/contracts/settings";
import { msg, useMessages } from "gt-react-native";

import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUsageLimitDisplay } from "./useUsageLimitDisplay";

const OPTIONS = [
  { value: "remaining", label: msg("% left", { $context: "usage limits show the share left" }) },
  { value: "used", label: msg("% used", { $context: "usage limits show the share used" }) },
] as const satisfies ReadonlyArray<{ readonly value: UsageLimitDisplay; readonly label: string }>;

/** Flips the limits between the share left and the share used, beside the meters themselves. */
export function UsageLimitDisplayControl(props: { readonly className?: string }) {
  const m = useMessages();
  const display = useUsageLimitDisplay();
  const savePreferences = useAtomCommand(saveMobilePreferences);
  return (
    <SegmentedControl
      options={OPTIONS.map((option) => ({ value: option.value, label: m(option.label) }))}
      selected={display}
      onSelect={(value) => void savePreferences({ usageLimitDisplay: value })}
      size="compact"
      {...(props.className ? { className: props.className } : {})}
    />
  );
}
