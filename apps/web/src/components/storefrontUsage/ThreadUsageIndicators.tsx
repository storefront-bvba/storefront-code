// Storefront Code (fork): the open thread's tightest usage limit, always in view (Wouter,
// 2026-11-27): a slim strip at the bottom of the sidebar, or a ring left of the composer's mic when
// there is no sidebar. Hover lists every window; a click opens or closes the usage panel.
import type { UsageLimitDisplay } from "@t3tools/contracts/settings";
import {
  limitPercentText,
  resetTimeText,
  shownPercent,
  type ThreadLimitWindow,
} from "@t3tools/shared/usageLimitsDisplay";
import { useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useSidebar, useSidebarVisibility } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type ThreadUsage,
  usageTone,
  useReportUsageStripVisible,
  useThreadUsage,
  useUsageStripVisible,
} from "./threadUsage";

type Messages = ReturnType<typeof useMessages>;

/** What is left right after the next reset, and when: "100% at 20:00". */
function resetText(
  window: ThreadLimitWindow,
  display: UsageLimitDisplay,
  now: number,
  m: Messages,
): string | null {
  if (window.nextReset === null) return null;
  const percent = shownPercent(window.nextReset.remainingPercent, display);
  return `${percent}% ${resetTimeText(window.nextReset.at, now, undefined, m)}`;
}

// Called only once there is something to show, so a composer rendered without a router (tests,
// other surfaces) never reaches useNavigate.
function useIndicator(usage: ThreadUsage) {
  const display = useClientSettings((settings) => settings.usageLimitDisplay);
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const m = useMessages();
  const gt = useGT();
  const navigate = useNavigate();
  const open = () => (usage.open ? usage.open() : void navigate({ to: "/usage" }));
  const label = gt("Usage limits: {windows}", {
    windows: usage.windows
      .map((window) => {
        const reset = resetText(window, display, now, m);
        return `${window.label} ${limitPercentText(window.remainingPercent, display, m)}${reset ? `, ${reset}` : ""}`;
      })
      .join("; "),
  });
  return { display, now, m, open, label };
}

function WindowsList(props: {
  readonly usage: ThreadUsage;
  readonly display: UsageLimitDisplay;
  readonly now: number;
  readonly m: Messages;
}) {
  return (
    <div className="flex min-w-48 flex-col gap-1.5 text-xs tabular-nums">
      {props.usage.windows.map((window) => {
        const reset = resetText(window, props.display, props.now, props.m);
        return (
          <div key={window.key} className="flex flex-col gap-1">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{window.label}</span>
              <span className="text-foreground">
                {limitPercentText(window.remainingPercent, props.display, props.m)}
                {reset ? ` · ${reset}` : ""}
              </span>
            </div>
            <Meter remaining={window.remainingPercent} display={props.display} />
          </div>
        );
      })}
    </div>
  );
}

function Meter(props: { readonly remaining: number; readonly display: UsageLimitDisplay }) {
  return (
    <span className="block h-[3px] overflow-hidden rounded-full bg-muted">
      <span
        className={cn("block h-full rounded-full", usageTone(props.remaining).fill)}
        style={{ width: `${shownPercent(props.remaining, props.display)}%` }}
      />
    </span>
  );
}

/** In the sidebar footer, between the thread list and the icons. */
export function SidebarThreadUsage() {
  const visible = useSidebarVisibility();
  useReportUsageStripVisible(visible);
  const usage = useThreadUsage();
  return usage === null ? null : <SidebarStrip usage={usage} />;
}

function SidebarStrip({ usage }: { readonly usage: ThreadUsage }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const { display, now, m, open, label } = useIndicator(usage);
  const { tightest } = usage;
  const reset = resetText(tightest, display, now, m);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={() => {
              if (isMobile) setOpenMobile(false);
              open();
            }}
            className="flex w-full cursor-pointer flex-col gap-1.5 rounded-md px-2 py-1.5 text-left outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <span className="flex min-w-0 items-baseline gap-1.5 text-xs leading-none tabular-nums">
          <span className="shrink-0 text-muted-foreground">{tightest.label}</span>
          <span className="shrink-0 font-medium text-foreground">
            {limitPercentText(tightest.remainingPercent, display, m)}
          </span>
          {reset ? <span className="ms-auto truncate text-muted-foreground">{reset}</span> : null}
        </span>
        <Meter remaining={tightest.remainingPercent} display={display} />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <WindowsList usage={usage} display={display} now={now} m={m} />
      </TooltipPopup>
    </Tooltip>
  );
}

const RING_RADIUS = 14;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** Beside the composer's actions, left of the mic, only while no sidebar strip is in view. */
export function ComposerThreadUsage() {
  const stripVisible = useUsageStripVisible();
  const usage = useThreadUsage();
  return stripVisible || usage === null ? null : <ComposerRing usage={usage} />;
}

function ComposerRing({ usage }: { readonly usage: ThreadUsage }) {
  const { display, now, m, open, label } = useIndicator(usage);
  const { tightest } = usage;
  const shown = shownPercent(tightest.remainingPercent, display);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={open}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 text-xs text-foreground tabular-nums outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <svg aria-hidden viewBox="0 0 36 36" className="size-3.5 -rotate-90">
          <circle
            cx="18"
            cy="18"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="5"
            className="stroke-foreground/15"
          />
          <circle
            cx="18"
            cy="18"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${(shown / 100) * RING_LENGTH} ${RING_LENGTH}`}
            className={cn("stroke-current", usageTone(tightest.remainingPercent).stroke)}
          />
        </svg>
        {shown}%
      </TooltipTrigger>
      <TooltipPopup side="top">
        <WindowsList usage={usage} display={display} now={now} m={m} />
      </TooltipPopup>
    </Tooltip>
  );
}
