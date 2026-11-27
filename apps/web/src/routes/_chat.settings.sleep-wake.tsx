import { createFileRoute } from "@tanstack/react-router";

import { SleepWakeSettingsPanel } from "../components/settings/sleepWake/SleepWakeSettingsPanel";

export const Route = createFileRoute("/_chat/settings/sleep-wake")({
  component: SleepWakeSettingsPanel,
});
