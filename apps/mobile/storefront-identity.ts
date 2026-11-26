// Storefront Code: our own app identity on top of upstream's Expo config.
//
// Fork-only file (see fork/GOAL.md). app.config.ts builds upstream's config unchanged and passes
// it through withStorefrontIdentity() as its last step, so upstream edits to app.config.ts rarely
// conflict with ours. Everything that ties the app to T3 Tools' Apple team, Expo account, domains
// or update server is replaced or removed here.
import type { ExpoConfig } from "expo/config";

/** Apple Developer team that signs our builds. Not a secret: it is in every signed app. */
export const STOREFRONT_APPLE_TEAM_ID = "2Z43A4WSC3";

const UPSTREAM_BUNDLE_PREFIX = "com.t3tools.t3code";
const STOREFRONT_BUNDLE_PREFIX = "be.storefront.code";
const UPSTREAM_HOSTS = ["t3.codes", "app.t3.codes", "clerk.t3.codes"];
const STOREFRONT_ICON = "../../fork/assets/storefront-ios-1024.png";

type Json = unknown;

/** Rename identifiers and the product name in every string of the config. */
function rename(value: Json): Json {
  if (typeof value === "string") {
    return value
      .replaceAll(UPSTREAM_BUNDLE_PREFIX, STOREFRONT_BUNDLE_PREFIX)
      .replaceAll("T3 Code", "Storefront Code");
  }
  if (Array.isArray(value)) return value.map(rename);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rename(entry)]));
  }
  return value;
}

type PluginEntry = NonNullable<ExpoConfig["plugins"]>[number];

function mapPlugin(
  plugins: ExpoConfig["plugins"],
  name: string,
  update: (options: Record<string, unknown>) => Record<string, unknown>,
): ExpoConfig["plugins"] {
  return plugins?.map((plugin: PluginEntry) =>
    Array.isArray(plugin) && plugin[0] === name
      ? [name, update((plugin[1] ?? {}) as Record<string, unknown>)]
      : plugin,
  );
}

export function withStorefrontIdentity(upstream: ExpoConfig): ExpoConfig {
  const config = rename(upstream) as ExpoConfig;

  config.slug = "storefront-code";
  delete config.owner;
  config.icon = STOREFRONT_ICON;

  // No over-the-air updates from upstream's Expo project: every change ships as a TestFlight build.
  config.updates = { enabled: false, checkAutomatically: "NEVER", fallbackToCacheTimeout: 0 };

  if (config.ios) {
    config.ios.icon = STOREFRONT_ICON;
    if (STOREFRONT_APPLE_TEAM_ID) config.ios.appleTeamId = STOREFRONT_APPLE_TEAM_ID;
    else delete config.ios.appleTeamId;
    // Universal links and passkeys for T3's domains (Clerk, hosted app) do not apply to us.
    delete config.ios.associatedDomains;
  }

  if (config.android?.intentFilters) {
    config.android.intentFilters = config.android.intentFilters.filter(
      (filter) =>
        !filter.data ||
        ![filter.data].flat().some((data) => UPSTREAM_HOSTS.includes(data.host ?? "")),
    );
  }

  // No Clerk sign-in, so no Sign in with Apple capability.
  config.plugins = mapPlugin(config.plugins, "@clerk/expo", (options) => ({
    ...options,
    appleSignIn: false,
  }));
  config.plugins = mapPlugin(config.plugins, "expo-splash-screen", (options) => ({
    ...options,
    image: STOREFRONT_ICON,
    dark: { ...(options.dark as Record<string, unknown>), image: STOREFRONT_ICON },
  }));

  const extra = (config.extra ?? {}) as Record<string, any>;
  if (extra.eas) delete extra.eas.projectId;
  if (extra.observability) extra.observability.tracesUrl = null;
  config.extra = extra;

  return config;
}
