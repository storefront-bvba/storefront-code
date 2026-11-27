// Storefront Code (fork): Rename and Regenerate title sit on the first level of a thread's menu
// instead of under More, because they are used often (Wouter, 2026-11-27). Wraps upstream's
// layout so its own rules (and tests) stay as they are.
import { layoutThreadListV2RowMenuActions as layoutUpstream } from "../../features/threads/threadListV2";

const FIRST_LEVEL = new Set(["rename", "regenerate-title"]);
const firstLevel = (action: { readonly id?: string }) => FIRST_LEVEL.has(action.id ?? "");

export const layoutThreadListV2RowMenuActions: typeof layoutUpstream = (input, resolve) =>
  layoutUpstream(
    input.nested
      ? {
          ...input,
          direct: [...input.direct, ...input.secondary.filter(firstLevel)],
          secondary: input.secondary.filter((action) => !firstLevel(action)),
        }
      : input,
    resolve,
  );
