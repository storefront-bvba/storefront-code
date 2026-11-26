"use strict";

// Storefront Code (fork): renames "T3 Code" in the strings of the workspace's own code (never
// node_modules) while Metro bundles, so new upstream strings are covered without edits.
// "T3 Connect", "T3 Account" and "the T3 team" stay: they name T3's services, on hidden screens.

const RENAMES = [
  [/T3 Code/g, "Storefront Code"],
  [/\bOpen T3 to\b/g, "Open Storefront Code to"],
  [/\bthe T3 home folder\b/g, "the Storefront Code home folder"],
];
// Whole strings: the app name passed into messages such as "Open {app} to refresh".
const EXACT = new Map([["T3", "Storefront Code"]]);

function rename(text) {
  if (EXACT.has(text)) return EXACT.get(text);
  let result = text;
  for (const [pattern, replacement] of RENAMES) result = result.replace(pattern, replacement);
  return result;
}

function ownCode(state) {
  const file = state.filename ?? "";
  return !file.split(/[\\/]/).includes("node_modules");
}

module.exports = function storefrontNames() {
  return {
    name: "storefront-names",
    visitor: {
      StringLiteral(path, state) {
        if (!ownCode(state)) return;
        const value = rename(path.node.value);
        if (value === path.node.value) return;
        path.node.value = value;
        delete path.node.extra;
      },
      TemplateElement(path, state) {
        if (!ownCode(state)) return;
        const { raw, cooked } = path.node.value;
        const renamed = rename(raw);
        if (renamed === raw) return;
        path.node.value = { raw: renamed, cooked: cooked == null ? cooked : rename(cooked) };
      },
      JSXText(path, state) {
        if (!ownCode(state)) return;
        const value = rename(path.node.value);
        if (value === path.node.value) return;
        path.node.value = value;
        delete path.node.extra;
      },
    },
  };
};

module.exports.rename = rename;
