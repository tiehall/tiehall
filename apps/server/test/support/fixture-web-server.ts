// Stands in for the Next.js standalone server in the web role's tests: like it, it creates its server with
// http.createServer when it is loaded, listens on HOSTNAME and PORT, and prints to the console as Next.js does:
// its version, its addresses and "Ready" at start, and an error it catches with the error itself. /slow answers
// only after SLOW_MS, so a test can hold a call in flight while the role stops; /fail prints an error whose
// message quotes what the call carried, as a library's error can.
//
// /api/v1/events/wait holds, as the app's wait endpoint does, until the process's shutdown signal, which the web
// role gives when it starts to stop, and then answers 503 with Retry-After: 0.
//
// For the tests of request bodies, three paths answer as the app's routes do, and print what they did with the
// body: /api/v1/… answers as the setup gate does before setup is complete, 503 setup-required, without reading
// the body; /mcp reads the body and answers 200, as an MCP server answers a JSON-RPC call; a form posted to
// /setup or /admin/invites is read and answered 200; and a delivery posted to /webhooks/github is read and answered 202. With LOG_CONNECTIONS=on it also prints how many bytes each connection read
// from its socket when it closes. With LOG_HEADS=on it prints each call's method and path as soon as the server
// has its head, from a listener of its own that the request guard does not wrap, so a test knows the server
// holds a call whose body is still arriving. A request URL, /FE-142 with or without .md or .json, and
// /members/page answer as Next.js answers a page, with its own Vary.
import http from "node:http";
import process from "node:process";
import { shutdownSignal } from "@tiehall/commands";
import { httpProblem, Refusal } from "@tiehall/core";

const SETUP_REQUIRED = JSON.stringify({
  type: "https://tiehall.com/problems/setup-required",
  title: "Setup is not complete",
  status: 503,
  detail: "Setup is not complete. The install's operator completes it on the setup screen at /setup.",
});

/** Reads the whole body, prints how many bytes it held, and answers 200 with this content type and body. */
function readThenAnswer(request: http.IncomingMessage, response: http.ServerResponse, type: string, body: (bytes: number) => string): void {
  let bytes = 0;
  request.on("data", (chunk: Buffer) => (bytes += chunk.length));
  request.on("end", () => {
    console.log(`fixture: ${request.url} read ${bytes} bytes`);
    response.writeHead(200, { "content-type": type });
    response.end(body(bytes));
  });
}

const server = http.createServer((request, response) => {
  if (request.url === "/slow") {
    console.log("fixture: slow call started");
    setTimeout(() => response.end("slow call done"), Number(process.env["SLOW_MS"] ?? "1500"));
    return;
  }
  if (request.url?.startsWith("/fail") === true) {
    console.error("⨯", new Error(`the call failed on ${decodeURIComponent(request.url)}`));
    response.statusCode = 500;
    response.end();
    return;
  }
  if (request.url?.startsWith("/api/v1/events/wait") === true) {
    // As the app's wait endpoint does, the wait holds until the process's shutdown signal, then answers 503.
    console.log("fixture: wait started");
    const answer = () => {
      const { status, headers, body } = httpProblem(new Refusal("shutting-down", "Tiehall is shutting down. Retry the call; it is answered once Tiehall is back."));
      response.writeHead(status, headers);
      response.end(JSON.stringify(body));
    };
    const signal = shutdownSignal();
    if (signal.aborted) answer();
    else signal.addEventListener("abort", answer, { once: true });
    return;
  }
  if (request.url?.startsWith("/api/v1/") === true) {
    console.log(`fixture: ${request.url} answered 503 without reading the body`);
    response.writeHead(503, { "content-type": "application/problem+json" });
    response.end(SETUP_REQUIRED);
    return;
  }
  if (request.url === "/mcp" && request.method === "POST") {
    readThenAnswer(request, response, "application/json", () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    return;
  }
  if (request.url === "/webhooks/github" && request.method === "POST") {
    readThenAnswer(request, response, "text/plain", (bytes) => `delivery of ${bytes} bytes`);
    return;
  }
  if ((request.url === "/setup" || request.url === "/admin/invites") && request.method === "POST") {
    readThenAnswer(request, response, "text/plain", (bytes) => `form of ${bytes} bytes`);
    return;
  }
  if (/^\/(FE-142(\.md|\.json)?|members\/page)$/.test(request.url ?? "")) {
    // As Next.js answers a page: its own Vary, set while it renders.
    response.setHeader("Vary", "rsc, next-router-state-tree");
    response.end("page");
    return;
  }
  response.end("ok");
});
if (process.env["LOG_HEADS"] === "on") {
  server.on("request", (request: http.IncomingMessage) => console.log(`fixture: the server has the head of ${request.method} ${request.url}`));
}
if (process.env["LOG_CONNECTIONS"] === "on") {
  server.on("connection", (socket) => {
    socket.on("close", () => console.log(`fixture: a connection closed after reading ${socket.bytesRead} bytes`));
  });
}
server.listen(Number(process.env["PORT"]), process.env["HOSTNAME"], () => {
  console.log("\u001b[1m\u001b[35m▲ Next.js 16.3.5\u001b[39m\u001b[22m");
  console.log(`   - Local:        http://localhost:${process.env["PORT"]}`);
  console.log("");
  console.log(" \u001b[32m\u001b[1m✓\u001b[22m\u001b[39m Ready in 0ms");
  console.log("fixture: listening");
});
