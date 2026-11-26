import { DEFAULT_CLIENT_SETTINGS, type UsageLimitDisplay } from "@t3tools/contracts/settings";
import { msg, useGT, useMessages } from "gt-react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const USAGE_LIMIT_DISPLAY_LABELS: Record<UsageLimitDisplay, string> = {
  remaining: msg("% left", { $context: "usage limits show the share left" }),
  used: msg("% used", { $context: "usage limits show the share used" }),
};

export function UsageLimitDisplayRow() {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const display = useClientSettings((settings) => settings.usageLimitDisplay);
  return (
    <SettingsRow
      {...searchableSetting("usage-limit-display")}
      description={gt(
        "Show usage limits as the share left or the share used. Numbers, bars and pace marks follow.",
      )}
      resetAction={
        display !== DEFAULT_CLIENT_SETTINGS.usageLimitDisplay ? (
          <SettingResetButton
            ariaLabel={gt("Reset usage limit display to default")}
            onClick={() =>
              void updateClientSettings({
                usageLimitDisplay: DEFAULT_CLIENT_SETTINGS.usageLimitDisplay,
              })
            }
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-40">
          <Select
            value={display}
            onValueChange={(value) => {
              if (value === "remaining" || value === "used") {
                void updateClientSettings({ usageLimitDisplay: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label={gt("Usage limits")}>
              <SelectValue>{m(USAGE_LIMIT_DISPLAY_LABELS[display])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="remaining">{gt("% left (default)")}</SelectItem>
              <SelectItem value="used">{m(USAGE_LIMIT_DISPLAY_LABELS.used)}</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
