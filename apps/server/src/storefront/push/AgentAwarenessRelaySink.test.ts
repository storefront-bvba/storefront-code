// Storefront Code (fork) guard: with host-sent push active, AgentAwarenessRelay never calls
// T3's relay, even while this host still holds a T3 Connect link (fork/design/F5-host-push.md).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as EnvironmentKeys from "../../cloud/environmentKeys.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../../cloud/config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { AgentActivitySink } from "./AgentActivitySink.ts";

const NOW = "2026-11-26T12:00:00.000Z";
const THREAD_ID = ThreadId.make("sink-thread");
const PROJECT_ID = ProjectId.make("sink-project");

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("claude"),
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const unused = (name: string) => () => Effect.die(`unexpected call: ${name}`);

const makeRelay = Effect.fnUntraced(function* (options: { readonly withSink: boolean }) {
  // A host that is still linked to T3 Connect: every relay secret is present.
  const linkedSecrets = new Map<string, Uint8Array>([
    [PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true")],
    [RELAY_URL_SECRET, new TextEncoder().encode("https://relay.t3.example")],
    [RELAY_ISSUER_SECRET, new TextEncoder().encode("https://relay.t3.example")],
    [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("t3-credential")],
  ]);
  const relaySecretNames = new Set([
    PUBLISH_AGENT_ACTIVITY_SECRET,
    RELAY_URL_SECRET,
    RELAY_ISSUER_SECRET,
    RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  ]);
  const secretReads: Array<string> = [];
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.sync(() => {
        if (relaySecretNames.has(name)) secretReads.push(name);
        return Option.fromUndefinedOr(linkedSecrets.get(name));
      }),
    // The environment's signing key lives in the same store.
    create: (name, value) => Effect.sync(() => void linkedSecrets.set(name, value)),
    set: (name, value) => Effect.sync(() => void linkedSecrets.set(name, value)),
    remove: (name) => Effect.sync(() => void linkedSecrets.delete(name)),
    getOrCreateRandom: unused("getOrCreateRandom"),
  });
  const current: { thread: OrchestrationV2ThreadShell | null } = { thread: shell() };
  const known = {
    getAgentAwarenessSnapshot: () =>
      Effect.sync(() => ({
        snapshotSequence: 1,
        threads: current.thread === null ? [] : [current.thread],
      })),
    listActiveShellIndex: () => Effect.succeed([]),
    streamDomainEvents: Stream.empty,
  };
  const threads = new Proxy(known, {
    get: (target, property) =>
      property in target ? target[property as keyof typeof target] : unused(String(property)),
  }) as unknown as ThreadManagementService.ThreadManagementService["Service"];
  const project = {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
  const projects = new Proxy(
    {
      snapshot: Effect.succeed({ projects: [project], updatedAt: NOW }),
      getById: () => Effect.succeedSome(project),
    },
    {
      get: (target, property) =>
        property in target ? target[property as keyof typeof target] : unused(String(property)),
    },
  ) as unknown as ProjectService.ProjectService["Service"];
  const relayCalls: Array<string> = [];
  const fetch = Object.assign(
    (input: Parameters<typeof globalThis.fetch>[0]) => {
      relayCalls.push(String(input));
      return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
    },
    { preconnect: () => {} },
  ) as typeof globalThis.fetch;
  const sinkStates: Array<RelayAgentActivityState | null> = [];
  const relay = yield* AgentAwarenessRelay.make.pipe(
    Effect.provide(EnvironmentKeys.layer),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("sink-environment")),
      getDescriptor: Effect.die("unused"),
    }),
    Effect.provideService(ProjectService.ProjectService, projects),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(
      AgentActivitySink,
      options.withSink
        ? { publish: (input) => Effect.sync(() => void sinkStates.push(input.state)) }
        : null,
    ),
    Effect.provide(NodeCrypto.layer),
  );
  return { relay, relayCalls, secretReads, sinkStates, current };
});

describe("AgentAwarenessRelay with host-sent push", () => {
  it.effect("the harness does reach the T3 relay when no sink is set", () =>
    Effect.gen(function* () {
      const { relay, relayCalls } = yield* makeRelay({ withSink: false });
      yield* relay.publishThread(THREAD_ID);
      assert.equal(relayCalls.length, 1);
      assert.include(relayCalls[0], "relay.t3.example");
    }),
  );

  it.effect("never calls the T3 relay while the sink is set, even when linked", () =>
    Effect.gen(function* () {
      const { relay, relayCalls, secretReads, sinkStates, current } = yield* makeRelay({
        withSink: true,
      });
      yield* relay.publishThread(THREAD_ID);
      assert.equal(sinkStates.length, 1);
      assert.equal(sinkStates[0]?.phase, "running");
      assert.equal(sinkStates[0]?.projectTitle, "Project");
      assert.equal(sinkStates[0]?.threadTitle, "Thread");

      // The startup catch-up runs through the same path.
      yield* relay.start();
      yield* TestClock.adjust("2 seconds");
      yield* relay.drain;

      // A thread that went away is held for confirmation, then cleared through the sink.
      current.thread = null;
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(sinkStates.length, 2);
      assert.strictEqual(sinkStates[1], null);

      assert.deepStrictEqual(relayCalls, [], "no request may reach T3's relay");
      assert.deepStrictEqual(secretReads, [], "T3 Connect's relay secrets are never read");
    }).pipe(Effect.scoped),
  );
});
