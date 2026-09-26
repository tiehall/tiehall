# Spec Delta: contract-changes

## MODIFIED Requirements

### Requirement: One report operation that never takes a whole spec

Contract changes SHALL reach Tiehall only through the `contract.report` operation. A report SHALL carry the registered API, the provider PR, the base and head refs with their commit SHAs, the diff engine's name and version, and the engine's classified change list, where each change has its engine id, its level and its operation. `contract.report` SHALL NOT accept an OpenAPI document, and Tiehall SHALL NOT parse one. A report body SHALL be at most 16 MiB, the limit the public-api capability sets for `contract.report`; a larger body SHALL be refused with 413 and the problem type `payload-too-large`, as the public-api capability's error model defines, before it is parsed, and SHALL open or update no request.

Source: D14; D43; design.md, Decisions this change rests on; design.md, Design rules: Request body limit; design.md, Rules carried from add-tiehall-oss-v1

#### Scenario: A report carries refs and classified changes only

- **WHEN** the contract Action reports a provider PR that has two ERR-level changes
- **THEN** the body it sends to `contract.report` holds the registered API, the PR, the base and head refs and SHAs, the engine name and version, and the two classified changes
- **AND** the body holds no OpenAPI document

#### Scenario: The published operation has no field for a spec

- **WHEN** a client reads the input schema of `contract.report` in `https://tiehall.example.com/api/v1/openapi.json`
- **THEN** the schema has no field that holds an OpenAPI document

#### Scenario: A report over the size limit opens nothing

- **WHEN** the contract Action sends a 17 MiB report to `contract.report`
- **THEN** the API answers 413 with an RFC 9457 problem whose problem type is `payload-too-large`
- **AND** no request is opened or updated
