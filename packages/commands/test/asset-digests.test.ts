import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSET_FILES, computeAssetDigests } from "../src/assets.ts";
import { ASSET_DIGESTS } from "../src/asset-digests.ts";

// The committed table of the assets' digests (web-ui: The install serves its
// own assets; design.md, Design: The install's assets; D57 (14)). Every
// bundle that renders a page names each asset by its digest, and none of them
// can find the files at run time: the request guard's refusal pages are
// rendered in apps/server's bundle, and Next.js's bundle names a chunk by
// import.meta.url. So the digests are a table in the code, which `pnpm
// assets:digests` writes from the files; this test recomputes it and fails on
// any difference.

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));

describe("the committed digests of the assets", () => {
  it("name every asset the route serves, and nothing else", () => {
    expect(Object.keys(ASSET_DIGESTS).sort()).toEqual(Object.keys(ASSET_FILES).sort());
  });

  it("are the digests of the files as they are served; run `pnpm assets:digests` after changing an asset", async () => {
    expect(await computeAssetDigests(ASSETS), "the committed digests are stale: run `pnpm assets:digests`").toEqual(ASSET_DIGESTS);
  });
});
