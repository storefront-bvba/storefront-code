// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as DeviceStore from "./DeviceStore.ts";
import * as HostAgentActivity from "./HostAgentActivity.ts";
import { ApnsClient, ApnsProviderTokens } from "./upstreamRelay.ts";

const { privateKey } = NodeCrypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const NOW_MS = Date.parse("2026-11-26T12:00:00.000Z");
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW_MS + offsetMs));
const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const THREAD_ID = ThreadId.make("thread-1");
const SECOND_THREAD_ID = ThreadId.make("thread-2");
const BUNDLE_ID = "be.storefront.code.dev";
const PUSH_TOKEN = "a".repeat(64);
const ACTIVITY_TOKEN = "b".repeat(64);

interface SentRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: {
    readonly aps: Record<string, unknown> & {
      readonly alert?: { readonly title: string; readonly body: string };
      readonly "content-state"?: { readonly name: string; readonly props: string };
    };
    readonly body?: Record<string, unknown>;
  };
}

function state(
  phase: RelayAgentActivityState["phase"],
  updatedAt: string,
  threadId: ThreadId = THREAD_ID,
): RelayAgentActivityState {
  return {
    environmentId: ENVIRONMENT_ID,
    threadId,
    projectTitle: "Project",
    threadTitle: threadId === THREAD_ID ? "Thread" : "Second thread",
    phase,
    headline: "Working",
    modelTitle: "Claude Opus",
    updatedAt,
    deepLink: `/threads/${ENVIRONMENT_ID}/${threadId}`,
  };
}

function registration(
  overrides: Partial<RelayDeviceRegistrationRequest> = {},
): RelayDeviceRegistrationRequest {
  return {
    deviceId: "phone-1",
    label: "iPhone",
    platform: "ios",
    iosMajorVersion: 26,
    appVersion: "0.1.12",
    bundleId: BUNDLE_ID,
    apsEnvironment: "sandbox",
    pushToken: PUSH_TOKEN,
    preferences: {
      liveActivitiesEnabled: true,
      notificationsEnabled: true,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
    ...overrides,
  };
}

const makeHarness = Effect.fnUntraced(function* (
  options: {
    readonly respond?: (request: SentRequest) => {
      readonly status: number;
      readonly reason?: string;
    };
    readonly sessionIds?: ReadonlyArray<string>;
  } = {},
) {
  yield* TestClock.setTime(NOW_MS);
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "storefront-push-" });
  const requests: Array<SentRequest> = [];
  const httpClient = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const raw = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      const sent: SentRequest = {
        url: url.toString(),
        headers: request.headers,
        body: JSON.parse(new TextDecoder().decode(raw)),
      };
      requests.push(sent);
      const answer = options.respond?.(sent) ?? { status: 200 };
      return HttpClientResponse.fromWeb(
        request,
        new Response(answer.reason ? JSON.stringify({ reason: answer.reason }) : null, {
          status: answer.status,
          headers: { "apns-id": `apns-${requests.length}` },
        }),
      );
    }),
  );
  let sessionIds = new Set(options.sessionIds ?? ["session-1"]);
  const auth = {
    listSessions: () =>
      Effect.sync(() => [...sessionIds].map((sessionId) => ({ sessionId })) as never),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
  const store = yield* DeviceStore.make(`${dir}/push-devices.json`);
  const activity = yield* HostAgentActivity.make({
    credentials: {
      keyFile: "unused",
      keyId: "ABCDEFGHIJ",
      teamId: "2Z43A4WSC3",
      topics: [BUNDLE_ID],
      privateKey: Redacted.make(privateKey),
    },
    retryDelaysMs: [],
  }).pipe(
    Effect.provide(
      ApnsClient.layer.pipe(
        Layer.provide(ApnsProviderTokens.layer),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
      ),
    ),
    Effect.provideService(DeviceStore.DeviceStore, store),
    Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
  );
  return {
    activity,
    store,
    requests,
    filePath: `${dir}/push-devices.json`,
    setSessions: (ids: ReadonlyArray<string>) => {
      sessionIds = new Set(ids);
    },
  };
});

const publish = (
  activity: HostAgentActivity.HostAgentActivity["Service"],
  next: RelayAgentActivityState | null,
  threadId: ThreadId = THREAD_ID,
) => activity.publish({ environmentId: ENVIRONMENT_ID, threadId, state: next });

describe("HostAgentActivity", () => {
  it.effect("sends upstream's alert to a phone without a Live Activity", () =>
    Effect.gen(function* () {
      const { activity, requests } = yield* makeHarness();
      const outcome = yield* activity.registerDevice({
        sessionId: "session-1",
        registration: registration(),
      });
      assert.equal(outcome, "registered");
      yield* publish(activity, state("running", at(0)));
      assert.equal(requests.length, 0, "running work does not ring");

      yield* TestClock.adjust("1 second");
      yield* publish(activity, state("waiting_for_approval", at(1_000)));
      assert.equal(requests.length, 1);
      const sent = requests[0]!;
      assert.equal(sent.url, `https://api.sandbox.push.apple.com/3/device/${PUSH_TOKEN}`);
      assert.equal(sent.headers["apns-push-type"], "alert");
      assert.equal(sent.headers["apns-topic"], BUNDLE_ID);
      assert.equal(sent.headers["apns-priority"], "10");
      assert.match(sent.headers.authorization ?? "", /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      assert.deepStrictEqual(sent.body, {
        aps: {
          alert: { title: "Thread", body: "Approval: Project" },
          sound: "default",
          "thread-id": `${ENVIRONMENT_ID}/${THREAD_ID}`,
        },
        body: {
          environmentId: ENVIRONMENT_ID,
          threadId: THREAD_ID,
          deepLink: `/threads/${ENVIRONMENT_ID}/${THREAD_ID}`,
        },
      });

      yield* TestClock.adjust("1 second");
      yield* publish(activity, state("completed", at(2_000)));
      assert.equal(requests.length, 2);
      // Storefront: a finished thread rings without a text banner.
      assert.deepStrictEqual(requests[1]!.body.aps, { sound: "default" });
      assert.equal(requests[1]!.headers["apns-push-type"], "alert");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("drives a Live Activity like the relay: silent updates, alerts, idle end", () =>
    Effect.gen(function* () {
      const { activity, requests, store } = yield* makeHarness();
      yield* activity.registerDevice({ sessionId: "session-1", registration: registration() });
      yield* activity.registerLiveActivity({
        deviceId: "phone-1",
        activityPushToken: ACTIVITY_TOKEN,
      });
      assert.equal(requests.length, 0, "a freshly armed card waits for the first state");

      yield* publish(activity, state("running", at(0)));
      assert.equal(requests.length, 1);
      const update = requests[0]!;
      assert.equal(update.url, `https://api.sandbox.push.apple.com/3/device/${ACTIVITY_TOKEN}`);
      assert.equal(update.headers["apns-push-type"], "liveactivity");
      assert.equal(update.headers["apns-topic"], `${BUNDLE_ID}.push-type.liveactivity`);
      assert.equal(update.headers["apns-priority"], "5");
      const aps = update.body.aps;
      assert.equal(aps.event, "update");
      assert.equal(aps["stale-date"], Math.floor(NOW_MS / 1_000) + 600);
      assert.isUndefined(aps.alert);
      assert.equal(aps["content-state"]?.name, "AgentActivity");
      const props = JSON.parse(aps["content-state"]?.props ?? "{}");
      assert.equal(props.title, "T3 Code");
      assert.equal(props.subtitle, "Agent work in progress");
      assert.equal(props.activeCount, 1);
      assert.deepStrictEqual(props.activities[0], {
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        projectTitle: "Project",
        threadTitle: "Thread",
        modelTitle: "Claude Opus",
        phase: "running",
        status: "Working",
        updatedAt: at(0),
        deepLink: `/threads/${ENVIRONMENT_ID}/${THREAD_ID}`,
      });

      // The same state again is a repeat: nothing goes out.
      yield* publish(activity, state("running", at(0)));
      assert.equal(requests.length, 1);

      yield* TestClock.adjust("1 second");
      yield* publish(activity, state("waiting_for_approval", at(1_000)));
      assert.equal(requests.length, 2);
      assert.equal(requests[1]!.headers["apns-priority"], "10");
      assert.deepStrictEqual(requests[1]!.body.aps.alert, {
        title: "Thread",
        body: "Approval: Project",
        sound: "default",
      } as never);

      yield* TestClock.adjust("1 second");
      yield* publish(activity, state("completed", at(2_000)));
      assert.equal(requests.length, 3);
      assert.deepStrictEqual(requests[2]!.body.aps.alert, {
        title: "Thread",
        body: "Done: Project",
        sound: "default",
      } as never);
      const finished = JSON.parse(requests[2]!.body.aps["content-state"]?.props ?? "{}");
      assert.equal(finished.subtitle, "Agent work completed");
      assert.equal(finished.activeCount, 0);

      // Fifteen minutes later the finished row has expired and the idle card ends.
      yield* TestClock.adjust("16 minutes");
      yield* activity.sweep;
      assert.equal(requests.length, 4);
      assert.equal(requests[3]!.body.aps.event, "end");
      assert.isUndefined(requests[3]!.body.aps["content-state"]);
      assert.equal(
        requests[3]!.body.aps["dismissal-date"],
        Math.floor((NOW_MS + 2_000 + 16 * 60_000) / 1_000) + 15,
      );
      const device = yield* store.get("phone-1");
      assert.isNull(
        device?.liveActivity?.activityPushToken ?? null,
        "an ended card's token retires",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replays the card, silently, when the phone registers its token", () =>
    Effect.gen(function* () {
      const { activity, requests } = yield* makeHarness();
      yield* activity.registerDevice({ sessionId: "session-1", registration: registration() });
      yield* publish(activity, state("waiting_for_input", at(0)));
      assert.equal(requests.length, 1, "the alert went to the push token");
      yield* activity.registerLiveActivity({
        deviceId: "phone-1",
        activityPushToken: ACTIVITY_TOKEN,
      });
      assert.equal(requests.length, 2);
      assert.equal(requests[1]!.headers["apns-push-type"], "liveactivity");
      assert.isUndefined(requests[1]!.body.aps.alert, "replays never buzz");
      const snapshot = yield* activity.snapshot;
      assert.equal(snapshot.aggregate?.activities[0]?.status, "Input");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("sends an unchanged unfinished card again before iOS calls it out of date", () =>
    Effect.gen(function* () {
      const { activity, requests } = yield* makeHarness();
      yield* activity.registerDevice({ sessionId: "session-1", registration: registration() });
      yield* activity.registerLiveActivity({
        deviceId: "phone-1",
        activityPushToken: ACTIVITY_TOKEN,
      });
      yield* publish(activity, state("running", at(0)));
      assert.equal(requests.length, 1);

      yield* TestClock.adjust("3 minutes");
      yield* activity.refresh;
      assert.equal(requests.length, 1, "a recent update needs no refresh");

      yield* TestClock.adjust("1 minute");
      yield* activity.refresh;
      assert.equal(requests.length, 2);
      const refreshed = requests[1]!;
      assert.equal(refreshed.headers["apns-priority"], "5");
      assert.isUndefined(refreshed.body.aps.alert, "a refresh never buzzes");
      assert.equal(refreshed.body.aps["stale-date"], Math.floor(NOW_MS / 1_000) + 240 + 600);
      assert.equal(
        refreshed.body.aps["content-state"]?.props,
        requests[0]!.body.aps["content-state"]?.props,
      );

      // A card with only finished rows keeps its look when it goes stale.
      yield* publish(activity, state("completed", at(240_000)));
      const afterCompletion = requests.length;
      yield* TestClock.adjust("5 minutes");
      yield* activity.refresh;
      assert.equal(requests.length, afterCompletion);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "tells the card the host sleeps, then that it woke, though the rows did not change",
    () =>
      Effect.gen(function* () {
        const { activity, requests } = yield* makeHarness();
        yield* activity.registerDevice({ sessionId: "session-1", registration: registration() });
        yield* activity.registerLiveActivity({
          deviceId: "phone-1",
          activityPushToken: ACTIVITY_TOKEN,
        });
        yield* publish(activity, state("running", at(0)));
        const props = (index: number) =>
          JSON.parse(requests[index]!.body.aps["content-state"]?.props ?? "{}");

        yield* TestClock.adjust("1 second");
        yield* activity.hostAsleep(true);
        assert.equal(requests.length, 2);
        assert.equal(props(1).hostAsleepAt, at(1_000));
        assert.isUndefined(requests[1]!.body.aps.alert);

        yield* TestClock.adjust("30 minutes");
        yield* activity.refresh;
        assert.equal(requests.length, 2, "an asleep host sends no refresh");

        yield* activity.hostAsleep(false);
        assert.equal(requests.length, 3);
        assert.isUndefined(props(2).hostAsleepAt);
        assert.deepStrictEqual(props(2).activities, props(0).activities);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("tries the other APNs environment once on BadDeviceToken and remembers it", () =>
    Effect.gen(function* () {
      const { activity, requests, store } = yield* makeHarness({
        respond: (request) =>
          request.url.includes("sandbox")
            ? { status: 400, reason: "BadDeviceToken" }
            : { status: 200 },
      });
      yield* activity.registerDevice({ sessionId: "session-1", registration: registration() });
      yield* publish(activity, state("waiting_for_approval", at(0)));
      assert.deepStrictEqual(
        requests.map((request) => new URL(request.url).host),
        ["api.sandbox.push.apple.com", "api.push.apple.com"],
      );
      assert.equal((yield* store.get("phone-1"))?.apsEnvironment, "production");
      assert.equal((yield* store.get("phone-1"))?.pushToken, PUSH_TOKEN);

      yield* publish(
        activity,
        state("waiting_for_approval", at(0), SECOND_THREAD_ID),
        SECOND_THREAD_ID,
      );
      assert.equal(requests.length, 3);
      assert.equal(new URL(requests[2]!.url).host, "api.push.apple.com");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("drops tokens Apple calls dead, but keeps them on other refusals", () =>
    Effect.gen(function* () {
      let answer: { readonly status: number; readonly reason?: string } = {
        status: 403,
        reason: "ExpiredProviderToken",
      };
      const { activity, requests, store } = yield* makeHarness({ respond: () => answer });
      yield* activity.registerDevice({ sessionId: "session-1", registration: registration() });
      yield* publish(activity, state("waiting_for_approval", at(0)));
      assert.equal(requests.length, 1);
      assert.equal((yield* store.get("phone-1"))?.pushToken, PUSH_TOKEN, "403 is not the token");

      answer = { status: 410, reason: "Unregistered" };
      yield* publish(
        activity,
        state("waiting_for_input", at(0), SECOND_THREAD_ID),
        SECOND_THREAD_ID,
      );
      assert.equal(requests.length, 2);
      assert.isNull((yield* store.get("phone-1"))?.pushToken ?? null);

      yield* publish(activity, state("failed", at(0)));
      assert.equal(requests.length, 2, "nothing more goes to a dead token");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("sends nothing to a phone whose session on this host has ended", () =>
    Effect.gen(function* () {
      const { activity, requests, store, setSessions } = yield* makeHarness();
      yield* activity.registerDevice({ sessionId: "session-1", registration: registration() });
      setSessions(["session-2"]);
      yield* TestClock.adjust("1 minute");
      yield* publish(activity, state("waiting_for_approval", at(60_000)));
      assert.equal(requests.length, 0);
      yield* activity.pruneSessions(new Set(["session-1"]));
      assert.isNull(yield* store.get("phone-1"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts only our own bundle IDs and iOS", () =>
    Effect.gen(function* () {
      const { activity } = yield* makeHarness();
      assert.equal(
        yield* activity.registerDevice({
          sessionId: "session-1",
          registration: registration({ bundleId: "com.t3tools.t3code" }),
        }),
        "topic-not-allowed",
      );
      const status = yield* activity.status({ sessionId: "session-1", deviceId: "phone-1" });
      assert.isTrue(status.enabled);
      assert.isFalse(status.device?.registered ?? true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stores the device list in its own file, readable by the owner only", () =>
    Effect.gen(function* () {
      const { activity, filePath } = yield* makeHarness();
      yield* activity.registerDevice({ sessionId: "session-1", registration: registration() });
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(filePath);
      assert.equal(info.mode & 0o777, 0o600);
      const saved = JSON.parse(yield* fs.readFileString(filePath));
      assert.equal(saved.version, 1);
      assert.equal(saved.devices[0].deviceId, "phone-1");
      const reloaded = yield* DeviceStore.make(filePath);
      assert.equal((yield* reloaded.get("phone-1"))?.sessionId, "session-1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
