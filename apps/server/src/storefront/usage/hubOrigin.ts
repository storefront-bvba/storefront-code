/**
 * Storefront Code: our hub serves the Claude API at ANTHROPIC_BASE_URL but its usage through a
 * translator at another address. STOREFRONT_HUB_ORIGIN names the API origin, so a thread sent to
 * the hub finds the hub's limits (clients pair the two by origin).
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const HubOrigin = Config.String("STOREFRONT_HUB_ORIGIN").pipe(Config.option);

export const hubOrigin = (url: URL) =>
  HubOrigin.pipe(
    Effect.map(
      (configured) =>
        (Option.isSome(configured) ? URL.parse(configured.value.trim())?.origin : undefined) ??
        url.origin,
    ),
    Effect.orElseSucceed(() => url.origin),
  );
