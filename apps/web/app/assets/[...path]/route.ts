import { join } from "node:path";
import { ASSETS_PATH, createAssetRoute, type AssetRoute } from "@tiehall/commands/assets";

// The install's own assets: the stylesheet, the live hall's script, the
// icons and the manifest (web-ui: The install serves its own assets;
// design.md, Design: The install's assets; D57 (14)), served
// to anyone, before setup too, with no session read and no cookie set; the
// setup gate lets every path under /assets/ and /favicon.ico through, and
// next.config.ts rewrites /favicon.ico here. The files are read from
// packages/commands/assets/, two folders up from the process's working
// directory, which is the web app's folder wherever it runs: apps/web under
// `next dev`, and the standalone server's own folder once it has started,
// since Next.js's standalone server.js changes into it. next.config.ts's
// outputFileTracingIncludes carries the folder into the standalone output and
// the image.
export const dynamic = "force-dynamic";

/** The route, built on the first call, once the standalone server has changed into its folder. */
let route: AssetRoute | undefined;

function answer(request: Request, path: readonly string[]): Promise<Response> {
  route ??= createAssetRoute({ folder: join(process.cwd(), "..", "..", "packages", "commands", "assets") });
  return route(request, `${ASSETS_PATH}/${path.join("/")}`);
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return answer(request, (await params).path);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return answer(request, (await params).path);
}

/** Any other method gets the error model's 404, as for a path that names no asset. */
async function notOffered(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return answer(request, (await params).path);
}

export { notOffered as POST, notOffered as PUT, notOffered as PATCH, notOffered as DELETE, notOffered as OPTIONS };
