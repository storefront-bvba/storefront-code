/* oxlint-disable t3code/no-untranslated-copy -- Storefront Code's own screen, English only so far. */
// Storefront Code (fork): the Sleep & wake page's entries in the settings index, spread into
// settingsSearch.ts so upstream's tables carry one line each.
export const SLEEP_WAKE_SEARCH_ID = "sleep-wake";

export const SLEEP_WAKE_SECTION_LABEL = { "/settings/sleep-wake": "Sleep & wake" } as const;

export const SLEEP_WAKE_SEARCH_ITEMS = [
  {
    id: SLEEP_WAKE_SEARCH_ID,
    title: "Sleep & wake",
    to: "/settings/sleep-wake",
    searchTerms: ["sleep when done stay awake wake up wake on lan suspend power machine relay"],
  },
] as const;
