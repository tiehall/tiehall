export const raw = (repository: string) => fetch(`https://raw.githubusercontent.com/${repository}/main/openapi.yaml`);
