import * as NodeHttp2 from "node:http2";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as Http2HttpClient from "./http2HttpClient.ts";

// A cleartext HTTP/2 server that answers like APNs and counts its sessions.
const startServer = Effect.acquireRelease(
  Effect.callback<{
    readonly origin: string;
    readonly server: NodeHttp2.Http2Server;
    readonly sessions: Array<NodeHttp2.ServerHttp2Session>;
    readonly requests: Array<{ readonly headers: NodeHttp2.IncomingHttpHeaders; body: string }>;
  }>((resume) => {
    const sessions: Array<NodeHttp2.ServerHttp2Session> = [];
    const requests: Array<{ readonly headers: NodeHttp2.IncomingHttpHeaders; body: string }> = [];
    const server = NodeHttp2.createServer();
    server.on("session", (session) => sessions.push(session));
    server.on("stream", (stream, headers) => {
      const request = { headers, body: "" };
      requests.push(request);
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        request.body += chunk;
      });
      stream.on("end", () => {
        stream.respond({
          ":status": 400,
          "apns-id": "test-apns-id",
          "content-type": "application/json",
        });
        stream.end(JSON.stringify({ reason: "BadDeviceToken" }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resume(Effect.succeed({ origin: `http://127.0.0.1:${port}`, server, sessions, requests }));
    });
  }),
  ({ server, sessions }) =>
    Effect.callback<void>((resume) => {
      for (const session of sessions) session.destroy();
      server.close(() => resume(Effect.void));
    }),
);

describe("http2HttpClient", () => {
  it.live("speaks HTTP/2 and reuses one session per origin", () =>
    Effect.gen(function* () {
      const { origin, sessions, requests } = yield* startServer;
      const client = yield* Http2HttpClient.make();
      const send = (token: string) =>
        HttpClientRequest.post(`${origin}/3/device/${token}`).pipe(
          HttpClientRequest.setHeaders({ "apns-push-type": "alert", "apns-topic": "be.example" }),
          HttpClientRequest.bodyJson({ aps: { alert: { title: "T", body: "B" } } }),
          Effect.flatMap(client.execute),
        );
      const first = yield* send("one");
      assert.equal(first.status, 400);
      assert.equal(first.headers["apns-id"], "test-apns-id");
      assert.deepStrictEqual(yield* first.json, { reason: "BadDeviceToken" });
      const second = yield* send("two");
      assert.equal(second.status, 400);
      assert.equal(sessions.length, 1, "the second request rides the same connection");
      assert.equal(requests[0]?.headers[":path"], "/3/device/one");
      assert.equal(requests[0]?.headers[":method"], "POST");
      assert.equal(requests[0]?.headers["apns-topic"], "be.example");
      assert.deepStrictEqual(JSON.parse(requests[0]?.body ?? "null"), {
        aps: { alert: { title: "T", body: "B" } },
      });
    }).pipe(Effect.scoped),
  );

  it.live("opens a fresh session after the server sends GOAWAY", () =>
    Effect.gen(function* () {
      const { origin, sessions } = yield* startServer;
      const clientSessions: Array<NodeHttp2.ClientHttp2Session> = [];
      const client = yield* Http2HttpClient.make({
        connect: (target) => {
          const session = NodeHttp2.connect(target);
          clientSessions.push(session);
          return session;
        },
      });
      const get = () =>
        HttpClient.get(`${origin}/health`).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
      assert.equal((yield* get()).status, 400);
      // The client's own GOAWAY handler runs first; it was attached when the session opened.
      yield* Effect.callback<void>((resume) => {
        clientSessions[0]!.once("goaway", () => resume(Effect.void));
        sessions[0]!.goaway();
      });
      assert.equal((yield* get()).status, 400);
      assert.equal(clientSessions.length, 2);
      assert.equal(sessions.length, 2);
    }).pipe(Effect.scoped),
  );
});
