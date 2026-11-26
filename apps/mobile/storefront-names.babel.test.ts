// Storefront Code (fork): the Babel plugin that renames "T3 Code" in the app's strings.
import * as NodeModule from "node:module";

import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const plugin = require("./storefront-names.babel.cjs") as (() => object) & {
  readonly rename: (text: string) => string;
};
const { transformSync } = require("@babel/core") as {
  readonly transformSync: (code: string, options: object) => { readonly code?: string } | null;
};

const transform = (code: string, filename = "/repo/apps/mobile/src/Example.tsx") =>
  transformSync(code, {
    babelrc: false,
    configFile: false,
    filename,
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [plugin],
  })?.code ?? "";

describe("storefront-names Babel plugin", () => {
  it("renames the product in string literals, templates and JSX text", () => {
    const out = transform(
      [
        'const a = gt("Update T3 Code on {environment}");',
        "const b = `T3 Code ${version}`;",
        "const c = <Text>T3 Code</Text>;",
        'const d = <View accessibilityLabel="T3 Code, Threads" />;',
      ].join("\n"),
    );
    expect(out).not.toContain("T3 Code");
    expect(out).toContain('"Update Storefront Code on {environment}"');
    expect(out).toContain("`Storefront Code ${version}`");
    expect(out).toContain("<Text>Storefront Code</Text>");
    expect(out).toContain('"Storefront Code, Threads"');
  });

  it("renames the bare app name passed into messages", () => {
    const out = transform(
      'msg("Open {app} to refresh", { app: "T3" }); const x = "Open T3 to connect";',
    );
    expect(out).toContain('app: "Storefront Code"');
    expect(out).toContain('"Open Storefront Code to connect"');
  });

  it("keeps the names of T3's own services and identifiers", () => {
    expect(plugin.rename("Sign in to T3 Connect")).toBe("Sign in to T3 Connect");
    expect(plugin.rename("Open T3 Account")).toBe("Open T3 Account");
    expect(plugin.rename("Feedback for the T3 team")).toBe("Feedback for the T3 team");
    expect(plugin.rename("T3Mark")).toBe("T3Mark");
    expect(plugin.rename("t3code://threads")).toBe("t3code://threads");
  });

  it("leaves dependencies alone", () => {
    const out = transform('const a = "T3 Code";', "/repo/node_modules/some-lib/index.js");
    expect(out).toContain('"T3 Code"');
  });
});
