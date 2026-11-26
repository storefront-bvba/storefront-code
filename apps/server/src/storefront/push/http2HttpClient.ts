// Storefront Code (fork): an Effect HttpClient over node:http2 for APNs, which only speaks
// HTTP/2 (the global fetch is HTTP/1.1). One session per origin, reused across requests and
// replaced after GOAWAY, an error or a long idle spell (fork/design/F5-host-push.md).
import * as NodeHttp2 from "node:http2";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

// APNs asks providers to keep connections open; close only sessions nobody used for a while.
const SESSION_IDLE_TIMEOUT_MS = 15 * 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
// HTTP/2 forbids connection-specific headers.
const FORBIDDEN_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export interface Http2Connector {
  readonly connect: (origin: string) => NodeHttp2.ClientHttp2Session;
}

const defaultConnector: Http2Connector = { connect: (origin) => NodeHttp2.connect(origin) };

function requestBody(request: HttpClientRequest.HttpClientRequest): Uint8Array | string | null {
  switch (request.body._tag) {
    case "Empty":
      return null;
    case "Uint8Array":
      return request.body.body;
    case "Raw":
      return typeof request.body.body === "string" || request.body.body instanceof Uint8Array
        ? request.body.body
        : null;
    default:
      return null;
  }
}

function transportError(request: HttpClientRequest.HttpClientRequest, cause: unknown) {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause }),
  });
}

// A stream refused because its session is going away never reached APNs; it is safe to resend.
function isSessionGoneError(cause: unknown): boolean {
  const code = (cause as { readonly code?: unknown } | null)?.code;
  return (
    code === "ERR_HTTP2_GOAWAY_SESSION" ||
    code === "ERR_HTTP2_INVALID_SESSION" ||
    code === "ERR_HTTP2_STREAM_CANCEL" ||
    code === "ERR_HTTP2_SESSION_ERROR"
  );
}

export const make = Effect.fn("storefront.push.http2HttpClient.make")(function* (
  connector: Http2Connector = defaultConnector,
) {
  const sessions = new Map<string, NodeHttp2.ClientHttp2Session>();

  const forget = (origin: string, session: NodeHttp2.ClientHttp2Session) => {
    if (sessions.get(origin) === session) sessions.delete(origin);
  };

  const sessionFor = (origin: string): NodeHttp2.ClientHttp2Session => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connector.connect(origin);
    // A server-wide process must not stay alive for an idle push connection.
    session.unref();
    session.setTimeout(SESSION_IDLE_TIMEOUT_MS, () => session.close());
    session.on("goaway", () => {
      forget(origin, session);
      session.close();
    });
    session.on("error", () => forget(origin, session));
    session.on("close", () => forget(origin, session));
    sessions.set(origin, session);
    return session;
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    }),
  );

  const exchange = (
    request: HttpClientRequest.HttpClientRequest,
    url: URL,
    signal: AbortSignal,
  ): Effect.Effect<Response, HttpClientError.HttpClientError> =>
    Effect.callback<Response, HttpClientError.HttpClientError>((resume) => {
      const body = requestBody(request);
      if (body === null && request.body._tag !== "Empty") {
        resume(
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.EncodeError({
                request,
                description: "The HTTP/2 client sends only buffered bodies",
              }),
            }),
          ),
        );
        return;
      }
      let session: NodeHttp2.ClientHttp2Session;
      let stream: NodeHttp2.ClientHttp2Stream;
      try {
        session = sessionFor(url.origin);
        const headers: NodeHttp2.OutgoingHttpHeaders = {
          ":method": request.method,
          ":path": `${url.pathname}${url.search}`,
        };
        for (const [name, value] of Object.entries(request.headers)) {
          if (!FORBIDDEN_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
        }
        stream = session.request(headers, { endStream: body === null });
      } catch (cause) {
        resume(Effect.fail(transportError(request, cause)));
        return;
      }
      let settled = false;
      const settle = (effect: Effect.Effect<Response, HttpClientError.HttpClientError>) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resume(effect);
      };
      const onAbort = () => {
        stream.close(NodeHttp2.constants.NGHTTP2_CANCEL);
        settle(Effect.fail(transportError(request, signal.reason)));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      let status = 0;
      const responseHeaders = new Headers();
      const chunks: Array<Buffer> = [];
      let received = 0;
      stream.on("response", (incoming) => {
        status = Number(incoming[":status"] ?? 0);
        for (const [name, value] of Object.entries(incoming)) {
          if (name.startsWith(":") || value === undefined) continue;
          responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
        }
      });
      stream.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received <= MAX_RESPONSE_BYTES) chunks.push(chunk);
      });
      stream.on("end", () => {
        // A null-body status cannot carry a body in a Web Response.
        const bytes = Buffer.concat(chunks);
        const nullBody = status === 204 || status === 205 || status === 304;
        settle(
          Effect.try({
            try: () =>
              new Response(nullBody ? null : new Uint8Array(bytes), {
                status,
                headers: responseHeaders,
              }),
            catch: (cause) => transportError(request, cause),
          }),
        );
      });
      stream.on("error", (cause) => {
        if (isSessionGoneError(cause)) forget(url.origin, session);
        settle(Effect.fail(transportError(request, cause)));
      });
      stream.on("close", () => {
        if (!settled) settle(Effect.fail(transportError(request, "HTTP/2 stream closed")));
      });
      if (body !== null) stream.end(body);
      return Effect.sync(() => {
        if (!settled) stream.close(NodeHttp2.constants.NGHTTP2_CANCEL);
      });
    });

  return HttpClient.make((request, url, signal) =>
    exchange(request, url, signal).pipe(
      // A session that went away between lookup and send gets one fresh session.
      Effect.catchIf(
        (error) => error.reason._tag === "TransportError" && isSessionGoneError(error.reason.cause),
        () => exchange(request, url, signal),
      ),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  );
});

export const layer: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  make(),
);
