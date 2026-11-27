import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it } from "vite-plus/test";

import { layoutThreadListV2RowMenuActions } from "./threadMenuLayout";

const actions = (...ids: string[]): MenuAction[] => ids.map((id) => ({ id, title: id }));
const full = {
  direct: actions("new-thread-on-branch", "copy-thread", "copy-thread-id", "settle"),
  reorder: actions("arrange", "move-up", "move-down"),
  pin: actions("unpin"),
  secondary: actions("rename", "regenerate-title", "mark-unread", "archive", "delete"),
};

describe("Storefront thread menu layout", () => {
  it("puts Rename and Regenerate title beside the other first-level actions on iOS", () => {
    const nested = layoutThreadListV2RowMenuActions({ ...full, nested: true });
    expect(nested.map((action) => action.id)).toEqual([
      "new-thread-on-branch",
      "copy-thread",
      "copy-thread-id",
      "settle",
      "rename",
      "regenerate-title",
      "unpin",
      "more",
    ]);
    expect(nested.at(-1)?.subactions?.map((action) => action.id)).toEqual([
      "arrange-menu",
      "mark-unread",
      "archive",
      "delete",
    ]);
  });

  it("leaves the flat Android menu as upstream orders it", () => {
    const flat = layoutThreadListV2RowMenuActions({ ...full, nested: false });
    expect(flat.map((action) => action.id).slice(-5)).toEqual(
      full.secondary.map((action) => action.id),
    );
  });
});
