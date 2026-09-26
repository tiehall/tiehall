// Stands in for the Next.js standalone server in the web role's tests: like it, it creates its server with
// http.createServer when it is loaded, listens on HOSTNAME and PORT, and prints to the console as Next.js does:
// its version, its addresses and "Ready" at start, and an error it catches with the error itself. /slow answers
// only after SLOW_MS, so a test can hold a call in flight while the role stops; /fail prints an error whose
// message quotes what the call carried, as a library's error can.
import http from "node:http";
import process from "node:process";

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
  response.end("ok");
});
server.listen(Number(process.env["PORT"]), process.env["HOSTNAME"], () => {
  console.log("\u001b[1m\u001b[35m▲ Next.js 16.3.5\u001b[39m\u001b[22m");
  console.log(`   - Local:        http://localhost:${process.env["PORT"]}`);
  console.log("");
  console.log(" \u001b[32m\u001b[1m✓\u001b[22m\u001b[39m Ready in 0ms");
  console.log("fixture: listening");
});
