import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, createTiehallClient } from "../src/index.ts";

// The client (public-api: The client package `@tiehall/client`): openapi-fetch
// typed by the generated paths, for one install's URL, sending each call
// through the fetch it is given, with the headers it is given, such as the
// token the CLI signed in with.

describe("the client", () => {
  it("calls the install's /api/v1 through the fetch it is given, with its headers", async () => {
    const sent: Request[] = [];
    const client = createTiehallClient({
      baseUrl: "https://tiehall.example.com",
      headers: { authorization: "Bearer a-token" },
      fetch: async (request) => {
        sent.push(request);
        return Response.json({ id: "x" });
      },
    });
    const { data, response } = await client.GET("/api/v1/requests/{key}", { params: { path: { key: "FE-142" } } });
    expect(response.status).toBe(200);
    expect(data).toEqual({ id: "x" });
    expect(sent.map((request) => [request.method, request.url, request.headers.get("authorization")])).toEqual([
      ["GET", "https://tiehall.example.com/api/v1/requests/FE-142", "Bearer a-token"],
    ]);
  });

  it("carries the CLI's command table", () => {
    expect(Array.isArray(COMMAND_TABLE)).toBe(true);
  });
});
