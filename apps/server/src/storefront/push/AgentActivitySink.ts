// Storefront Code (fork): where AgentAwarenessRelay hands its states when this host sends push
// itself (fork/design/F5-host-push.md). Null by default, which keeps upstream's relay path.
import type { ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../../cloud/config.ts";

export interface AgentActivitySinkShape {
  /** Never fails: like the relay, the sink accepts the state and handles delivery itself. */
  readonly publish: (input: {
    readonly environmentId: string;
    readonly threadId: ThreadId;
    readonly state: RelayAgentActivityState | null;
  }) => Effect.Effect<void>;
}

export class AgentActivitySink extends Context.Reference<AgentActivitySinkShape | null>(
  "t3/storefront/push/AgentActivitySink",
  { defaultValue: () => null },
) {}

// While the sink is set the relay's link gates read these instead of the stored secrets, so
// publishing runs without a T3 Connect link and no T3 relay URL or credential is ever loaded.
// `.invalid` never resolves: a publish that slipped past the sink could not reach anyone.
const SINK_RELAY_URL = "https://storefront-host-push.invalid";

export function sinkGateSecret(name: string): string | null {
  switch (name) {
    case PUBLISH_AGENT_ACTIVITY_SECRET:
      return "true";
    case RELAY_URL_SECRET:
    case RELAY_ISSUER_SECRET:
      return SINK_RELAY_URL;
    case RELAY_ENVIRONMENT_CREDENTIAL_SECRET:
      return "storefront-host-push";
    default:
      return null;
  }
}
