// Reads a pull request and lists the repositories an installation covers, as the server does.
export const pull = (octokit: { request(route: string, parameters: object): unknown }) =>
  octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner: "acme", repo: "payments", pull_number: 310 });
export const covered = (octokit: { request(route: string): unknown }) => octokit.request("GET /installation/repositories");
// The App asks for no Contents permission, so it reads no file of a repository.
