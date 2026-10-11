import { join } from "node:path";
import { ASSETS_PATH, createAssetRoute, type AssetRoute } from "@tiehall/commands/assets";

// The install's own assets, as the web app serves them (app/assets/[...path]/route.ts),
// so the page for a failed render is drawn with its stylesheet, fonts and icons here too.
// `next start` runs in this fixture's folder, five folders under the repository's root.
export const dynamic = "force-dynamic";

/** The route, built on the first call. */
let route: AssetRoute | undefined;

function answer(request: Request, path: readonly string[]): Promise<Response> {
  route ??= createAssetRoute({ folder: join(process.cwd(), "..", "..", "..", "..", "..", "packages", "commands", "assets") });
  return route(request, `${ASSETS_PATH}/${path.join("/")}`);
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return answer(request, (await params).path);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return answer(request, (await params).path);
}
