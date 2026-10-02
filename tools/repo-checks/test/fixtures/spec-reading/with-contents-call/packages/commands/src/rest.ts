export const content = (octokit: { rest: { repos: { getContent(parameters: object): unknown } } }) =>
  octokit.rest.repos.getContent({ owner: "acme", repo: "payments", path: "openapi.yaml" });
