// Reads a provider's OpenAPI document from its repository, which the server must never do.
export const spec = (octokit: { request(route: string, parameters: object): unknown }) =>
  octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner: "acme", repo: "payments", path: "openapi.yaml" });
