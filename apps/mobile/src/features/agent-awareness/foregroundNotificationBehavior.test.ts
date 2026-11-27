import type { Notification } from "expo-notifications";
import { describe, expect, it } from "vite-plus/test";

import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";

const notification = (content: { title: string | null; body: string | null }) =>
  ({ request: { content: { ...content, data: {} } } }) as unknown as Notification;

describe("foregroundNotificationBehavior", () => {
  it("shows a notification with text and only rings for one without (a finished thread)", () => {
    const shown = foregroundNotificationBehavior(
      notification({ title: "Thread", body: "Approval: Project" }),
      null,
    );
    expect(shown.shouldShowBanner).toBe(true);
    const done = foregroundNotificationBehavior(notification({ title: null, body: null }), null);
    expect(done).toMatchObject({ shouldShowBanner: false, shouldShowList: false });
    expect(done.shouldPlaySound).toBe(true);
  });
});
