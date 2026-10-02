import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCatalog, defineCommand, type Catalog } from "@tiehall/catalog";
import { openApiDocument, serializeDocument } from "@tiehall/catalog/openapi";
import { PROBLEM_TYPE_BASE } from "@tiehall/core";
import { createExecute, createRestHandler, defineHandler, type Caller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { tokenOf } from "./support/requests.ts";

// /api/v1 keeps answering after a breaking change goes to /api/v2 (public-api:
// After graduation, breaking changes go to a new major version; public-api:
// The major version is in the path; design.md, Where the specs leave room: Two
// API versions). A synthetic stable operation gains a breaking shape under
// /api/v2. The REST route then answers its /api/v2 path with the new shape and
// its /api/v1 path exactly as before, from the one definition and the one
// handler, which runs the current shape: a v1 call's input is judged by the v1
// schema and carried to the current shape, and the current output is carried
// back to v1. Each major version's document is served at its own
// /api/vN/openapi.json, and the v1 document is the one served before the
// change, byte for byte.

const widgetV1 = defineCommand({
  id: "widgets.get",
  summary: "Read a widget.",
  input: z.object({ id: z.string().regex(/^w[0-9]+$/) }),
  output: z.object({ id: z.string(), name: z.string() }),
  method: "GET",
  path: "/api/v1/widgets/{id}",
  scopes: ["requests:read"],
  commitment: false,
  confirm: false,
  surfaces: ["rest"],
  stability: "stable",
});

const widgetV2 = defineCommand({
  ...widgetV1,
  input: z.object({ id: z.string().regex(/^w[0-9]+$/), locale: z.enum(["en", "tr"]) }),
  output: z.object({ id: z.string(), title: z.string(), locale: z.enum(["en", "tr"]) }),
  path: "/api/v2/widgets/{id}",
  earlier: [
    {
      major: 1,
      method: "GET",
      path: "/api/v1/widgets/{id}",
      input: widgetV1.input,
      output: widgetV1.output,
      stability: "stable",
      toCurrent: (input: { id: string }) => ({ ...input, locale: "en" }),
      fromCurrent: ({ id, title }: { id: string; title: string }) => ({ id, name: title }),
    },
  ],
});

/** The widgets' titles by locale, as the one handler reads them. */
const TITLES: Readonly<Record<string, string>> = { en: "Blue widget", tr: "Blue widget, in Turkish" };

let install: TestInstall;
let caller: Caller;

beforeAll(async () => {
  install = await startTestInstall();
  caller = tokenOf(await addUser(install.owner, { login: "lee" }));
}, 60_000);

afterAll(async () => {
  await install?.close();
});

/** The REST route of an install whose catalog holds the widget operation, as before or after the change. */
function route(catalog: Catalog, documents: Readonly<Record<number, string>>) {
  const definition = catalog.get("widgets.get")!;
  const execute = createExecute({
    catalog,
    handlers: {
      // Before the change the handler answers the v1 shape; after it, the current shape alone.
      [definition.id]: defineHandler(definition, async (input) => {
        const { id, locale } = input as { id: string; locale?: "en" | "tr" };
        return locale === undefined ? { id, name: TITLES["en"] } : { id, title: TITLES[locale], locale };
      }),
    },
    store: { database: install.db, jobs: { send: async () => {} } },
  });
  return createRestHandler({ catalog, document: documents[1] ?? "", documents, execute, authenticate: async () => caller, logger: install.logger });
}

async function get(handler: (request: Request) => Promise<Response>, path: string): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await handler(new Request(`${URL_OF_INSTALL}${path}`));
  return { status: response.status, text: await response.text(), headers: response.headers };
}

describe("a stable operation with a breaking shape under /api/v2", () => {
  const before = defineCatalog([widgetV1]);
  const after = defineCatalog([widgetV2]);
  const v1Before = serializeDocument(openApiDocument(before));
  const v1After = serializeDocument(openApiDocument(after, { major: 1 }));
  const v2 = serializeDocument(openApiDocument(after, { major: 2 }));

  it("keeps /api/v1 answering as before, with its document, while /api/v2 answers the breaking shape", async () => {
    const old = route(before, { 1: v1Before });
    const now = route(after, { 1: v1After, 2: v2 });

    const answeredBefore = await get(old, "/api/v1/widgets/w7");
    const answeredAfter = await get(now, "/api/v1/widgets/w7");
    expect(answeredBefore).toMatchObject({ status: 200 });
    expect(JSON.parse(answeredBefore.text)).toEqual({ id: "w7", name: "Blue widget" });
    expect(answeredAfter.text).toBe(answeredBefore.text);
    expect((await get(now, "/api/v1/openapi.json")).text).toBe((await get(old, "/api/v1/openapi.json")).text);

    const answeredV2 = await get(now, "/api/v2/widgets/w7?locale=tr");
    expect(answeredV2.status).toBe(200);
    expect(JSON.parse(answeredV2.text)).toEqual({ id: "w7", title: "Blue widget, in Turkish", locale: "tr" });
    expect((await get(now, "/api/v2/openapi.json")).text).toBe(v2);
  });

  it("judges a /api/v1 call's input by the v1 schema, and a /api/v2 call's by the current one", async () => {
    const now = route(after, { 1: v1After, 2: v2 });

    const badId = await get(now, "/api/v1/widgets/seven");
    expect(badId.status).toBe(400);
    expect(JSON.parse(badId.text)).toMatchObject({ type: `${PROBLEM_TYPE_BASE}invalid-input`, errors: [{ path: ["id"] }] });
    // A v1 call never names the locale, which v2 requires.
    const noLocale = await get(now, "/api/v2/widgets/w7");
    expect(noLocale.status).toBe(400);
    expect(JSON.parse(noLocale.text)).toMatchObject({ errors: [{ path: ["locale"] }] });
  });

  it("answers 404 for a major version that serves no such operation, and for a document no major version has", async () => {
    const old = route(before, { 1: v1Before });
    expect((await get(old, "/api/v2/widgets/w7?locale=en")).status).toBe(404);
    expect((await get(old, "/api/v2/openapi.json")).status).toBe(404);
  });
});
