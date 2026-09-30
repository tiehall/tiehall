// Starts the web app's standalone server as the web role does, for web-app.ts:
// every server it creates adds Accept and Authorization to the Vary of each
// answer of a request URL (negotiation.ts), as the web role's request guard
// does, and the rest of the guard is left out. Its one argument is the
// standalone server's path.
import http, { type RequestListener } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { varyOnNegotiatedUrls } from "../../src/negotiation.ts";

const original = http.createServer;
http.createServer = ((...args: unknown[]) => {
  const index = args.findIndex((argument) => typeof argument === "function");
  if (index !== -1) {
    const listener = args[index] as RequestListener;
    args[index] = ((request, response) => {
      varyOnNegotiatedUrls(request, response);
      return listener(request, response);
    }) satisfies RequestListener;
  }
  return (original as (...args: unknown[]) => http.Server).apply(http, args);
}) as typeof http.createServer;
syncBuiltinESMExports();

await import(pathToFileURL(process.argv[2] ?? "").href);
