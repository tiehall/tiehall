// Stands in for the Next.js standalone server in the web role's tests: like it, it creates its server with
// http.createServer when it is loaded and listens on HOSTNAME and PORT. /slow answers only after SLOW_MS, so
// a test can hold a call in flight while the role stops.
import http from "node:http";
import process from "node:process";

const server = http.createServer((request, response) => {
  if (request.url === "/slow") {
    process.stdout.write("fixture: slow call started\n");
    setTimeout(() => response.end("slow call done"), Number(process.env["SLOW_MS"] ?? "1500"));
    return;
  }
  response.end("ok");
});
server.listen(Number(process.env["PORT"]), process.env["HOSTNAME"], () => process.stdout.write("fixture: listening\n"));
