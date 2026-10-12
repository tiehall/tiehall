# The handoff packet, `tiehall.packet/v1` (beta)

A Tiehall request carries a handoff packet: the typed content that one team's agent hands to another's, written so that agents can read it. This directory holds the packet's JSON Schema (draft 2020-12), [`schema/v1-beta.json`](schema/v1-beta.json), its conformance fixtures of [valid](fixtures/valid) and [invalid](fixtures/invalid) packets, and, under `src/`, the validator and the code with which Tiehall renders what agents read; `@tiehall/packet`, once it is published, carries the schema, its types, the validator and the fixtures, and leaves the renderer out. The directory is licensed under Apache-2.0, as its [LICENSE](LICENSE) file says, while the rest of Tiehall's server is licensed under AGPL-3.0, so anyone may build on the packet format.

The schema is beta: it can still change, with notice, until it is published as v1.0. This page explains each field, how the fields people write are marked untrusted, the rules for `extensions`, the beta label and the versioning rules.

## The beta label

- The schema's `$id` is `https://tiehall.com/schemas/packet/v1-beta.json`, which differs from every URL a published release will have. It names the schema, and need not resolve before publication.
- Every packet carries `schema_version` with the value `"1-beta"`.
- Every install serves the schema at its own `/schemas/packet/v1-beta.json`, such as `https://tiehall.example.com/schemas/packet/v1-beta.json`, without sign-in, because the schema holds no data of the install. No install fetches the schema from `tiehall.com` or from any other host: validating a packet needs nothing but this one file.
- From publication on, packets carry `schema_version` with the value `"1.0"`, as [Versioning](#versioning) describes.

## Fields

A packet is one JSON object, of one of two kinds. Its top level holds only what Tiehall itself states; everything that a person, an agent or another system wrote sits under `untrusted`.

| Field | Required | What it is |
| --- | --- | --- |
| `schema_version` | yes | The schema's version, `"1-beta"` until publication. |
| `kind` | yes | `request` for a request's packet, or `contract_change` for the packet of a request that a contract report opened. A revision keeps its request's kind. |
| `due_date` | no | The day the request is due, as `YYYY-MM-DD`, such as `2026-10-15`. |
| `untrusted` | yes | Every field below. |

Under `untrusted`:

| Field | Required | What it is |
| --- | --- | --- |
| `need` | yes | What the requester needs, in their own words: 1 to 20,000 characters. |
| `acceptance_criteria` | no | What must hold for the request to be done: at most 100 criteria, each 1 to 2,000 characters. |
| `code_refs` | no | Code the request is about: at most 100, each with its `repository`, such as `acme/web` (required, 1 to 200 characters), and a `path` in it (1 to 1,000) and a `ref`, a branch, tag or commit (1 to 255), if given. |
| `links` | no | Pages that give context: at most 100, each with its `url`, an `http` or `https` URL of at most 2,048 characters (required), and a `title` of 1 to 200 characters, if given. |
| `contract` | for `contract_change` | The contract section, below. A `request` packet may carry one too, such as a classified diff a developer attaches by hand. |
| `extensions` | no | Data of other tools, under namespaces of their own, as [`extensions`](#extensions) describes. |

The contract section, `contract`, holds an API change as the diff engine in the provider's CI, or on a developer's machine, classified it:

| Field | Required | What it is |
| --- | --- | --- |
| `api` | yes | The registered API that changes, such as `payments-api`: 1 to 200 characters. |
| `base` | yes | What the change is compared with: its `ref`, such as `main` (1 to 255 characters), and its commit `sha`, 40 or 64 lower-case hexadecimal digits. |
| `head` | yes | What makes the change: its `ref` and its commit `sha`, as for `base`. |
| `engine` | yes | The diff engine that classified the changes: its `name`, such as `oasdiff`, and its `version`, such as `1.32.0`, 1 to 100 characters each. |
| `changes` | yes | The classified changes, at most 1,000, each with the engine's `id` for the kind of change, such as `response-property-removed` (1 to 200 characters), its `level`, `ERR` for a breaking change, `WARN` for a potentially breaking one or `INFO` for information, and the `operation` it touches, such as `GET /payments/{id}` (1 to 1,000 characters). |
| `provider_pr` | for `contract_change` | The provider's pull request that makes the change: its `repository`, such as `acme/payments` (1 to 200 characters), its `number`, 1 or more, and its `url`, if given, an `http` or `https` URL of at most 2,048 characters. |
| `provider_status` | for `contract_change` | The provider pull request's state: `open`, `merged`, which ships the change, or `closed` without merging. |
| `migration_notes` | no | How a consumer moves to the new contract: 1 to 20,000 characters. |
| `deprecation_window` | no | When the old behavior stays available: the `start` day it is deprecated, if given, and the `end` day, the last it is served (required), each as `YYYY-MM-DD`. |

In a `request` packet, `provider_pr` and `provider_status` may be left out, as in a classified diff a developer attaches by hand between two refs that no pull request holds yet; a `contract_change` packet, which a contract report opens, always carries both.

Every text field is kept exactly as written, and none may be blank. Tiehall refuses a packet that lacks a required field, that names no kind or another one, or that has a field outside its bounds, with 400, and stores nothing.

The schema states each URL, a link's `url` and the pull request's `url`, with the `uri` format and a pattern that admits only `http` and `https`, in either case. A validator need not check formats, but it checks patterns, so a validator of this schema, the package's own included, refuses a URL of another scheme, such as a `javascript:` or `data:` URL, as Tiehall does, with 400.

A request's packet:

```json
{
  "schema_version": "1-beta",
  "kind": "request",
  "due_date": "2026-10-15",
  "untrusted": {
    "need": "The settings page needs a dark mode that follows the operating system's setting.",
    "acceptance_criteria": ["The settings page follows the operating system's light or dark setting."],
    "code_refs": [{ "repository": "acme/web", "path": "src/settings/theme.ts", "ref": "main" }],
    "links": [{ "url": "https://design.example.com/specs/dark-mode", "title": "Dark mode design" }],
    "extensions": { "com.acme.billing": { "cost_center": "CC-12" } }
  }
}
```

A contract-change request's packet:

```json
{
  "schema_version": "1-beta",
  "kind": "contract_change",
  "untrusted": {
    "need": "payments-api removes the field amount_cents from GET /payments/{id}; move to amount.",
    "contract": {
      "api": "payments-api",
      "base": { "ref": "main", "sha": "0123456789abcdef0123456789abcdef01234567" },
      "head": { "ref": "remove-amount-cents", "sha": "89abcdef0123456789abcdef0123456789abcdef" },
      "engine": { "name": "oasdiff", "version": "1.32.0" },
      "changes": [{ "id": "response-property-removed", "level": "ERR", "operation": "GET /payments/{id}" }],
      "provider_pr": { "repository": "acme/payments", "number": 418, "url": "https://github.com/acme/payments/pull/418" },
      "provider_status": "open",
      "deprecation_window": { "end": "2026-12-31" }
    }
  }
}
```

**Open objects, strict server.** No object in the schema forbids properties it does not define, so a packet with a key that a later version adds still validates. Tiehall's server still reads every packet strictly: it refuses a known field of the wrong type with 400, and drops the keys it does not know, which it neither stores nor returns, except inside `extensions`.

**Revisions.** A request's packet is kept as numbered revisions, from 1, the packet the request is opened with; a revision never changes once it exists. Adding one over the REST API needs `If-Match` with the current revision's `ETag`, and Tiehall answers what changed since any revision as an RFC 6902 JSON Patch with the list of the fields that changed. A due date set after the request was opened, and a change to its `need`, `acceptance_criteria` or `contract` while it is claimed, are commitments, which people confirm before they become a revision.

## The untrusted marking

Every field whose content a person, an agent or another system writes sits under the packet's `untrusted` object, and only `schema_version`, `kind` and `due_date` sit outside it. The schema marks the `untrusted` object with the annotation `x-tiehall-untrusted: true`, and marks each field under it that way too: `need`, `acceptance_criteria`, `code_refs`, `links`, `contract` and `extensions`. The contract section is marked as well, because a CI run or a developer, not Tiehall, wrote it.

The marking tells every reader, and agents first of all, to read that content as data, never as instructions. Tiehall itself never shows it to an agent as its own words: in markdown, each such text sits in a fence with a marker made for that answer and a line that says where it came from, and in JSON it stays under `untrusted`. `x-tiehall-untrusted` is an annotation, which changes nothing a validator accepts; a strict validator needs to be told the keyword, as this package's validator does.

## `extensions`

`untrusted.extensions` carries data of other tools, so they can add to a packet without waiting for the schema:

- Each key is a reverse-DNS namespace, such as `com.acme.billing`: lower-case letters, digits and hyphens, in two or more labels separated by dots, starting with a letter, at most 255 characters.
- What sits under a key is kept exactly as sent, keys Tiehall does not know included, and returned unchanged.
- The whole object takes at most 16 KB (16,384 bytes) as JSON; the schema states the cap in its description, and Tiehall's server enforces it.
- A key that is not a namespace, or an object over the cap, is refused with 400, and nothing is stored.
- Like everything under `untrusted`, its contents are marked untrusted, and agents read them as data.

## Versioning

**Before publication**, which is now, the schema can still change. A breaking change, one after which a packet that was valid no longer validates, is announced in the API changelog at least 14 days before any release contains it, and the pull request that makes it carries the `api-breaking` label and adds the changelog entry. Every conformance fixture that validated against an earlier beta version keeps validating against later ones unless such a change was announced, and CI fails a pull request that breaks one without the label.

**Publication** comes once no breaking packet change has been needed for four weeks and at least three companies, by their own reports, exchange packets, contract packets included; installs send no usage data, so only what companies report counts. The maintainers decide, and record the decision in the changelog. Publication is four things at once: this directory with a short spec and a changelog; fixed release URLs under `https://tiehall.com/schemas/`, `packet/v1.0.json` and those after it, each the `$id` of its release and never changed, with `packet/v1.json` a copy of the latest v1.x, which this directory keeps in `releases/` from v1.0 on; the `@tiehall/packet` package on npm, with the types, a validator and the fixtures; and the media type `application/vnd.tiehall.packet+json; version=1`, which this page then names in a section of its own. Packets then carry `"1.0"`, and the schema's `$id` is its v1.0 release URL: this directory's [`publication.json`](publication.json) is the switch, off until then, which a Tiehall release reads when it is built. Tiehall's API keeps serving packets as `application/json`.

**After publication**, v1 only gains optional fields: a packet built against a newer v1.x validates against every older v1.x. A v1.x release adds no required field, removes no field and changes no constraint of a field an earlier release defines, neither narrower, which would refuse an older packet, nor wider, such as another enum value or a longer maximum, which would let a newer packet fail an older release; it adds optional fields only where an earlier release leaves an object open. Every conformance fixture that ever validated against a release still validates, and CI checks every change against every published release.

## Conformance fixtures

[`fixtures/valid`](fixtures/valid) holds packets that every implementation must accept, such as a minimal request packet, a contract-change packet, a request packet whose contract section names no pull request, a packet with `extensions` and one with keys the schema does not define. [`fixtures/invalid`](fixtures/invalid) holds packets that every implementation must refuse, such as one without a `need`, a contract-change packet without its contract section or its provider pull request, a link or a pull request whose URL is a `javascript:` or `data:` URL, a `need` outside `untrusted`, an unknown `kind` or `schema_version`, a field over its bound, and an `extensions` key that is not a namespace. Every valid fixture validates against the schema and every invalid one fails, which this repository's CI checks with this package's validator, `packetValidator()` in [`src/validator.ts`](src/validator.ts).

## `@tiehall/packet`

The npm package `@tiehall/packet` is built from this directory, under Apache-2.0, and published from Tiehall's CI with npm provenance once the schema is published; it is not published before. Its version names the schema release it carries: version 1.<minor>.<patch> holds release v1.<minor>, whose `$id` is that release's URL. It holds the schema, the packet's TypeScript types (`Packet`, `RequestPacket` and `ContractChangePacket`, generated from the schema into [`src/types.ts`](src/types.ts)), the validator and the conformance fixtures with their runner, compiled to JavaScript; it leaves out the code with which Tiehall renders what agents read. Its one dependency is the validator's, Ajv.

```js
import { conformanceProblems, loadFixtures, packetValidator, runConformance } from "@tiehall/packet";

const validate = packetValidator();
validate({ schema_version: "1-beta", kind: "request", untrusted: { need: "Expose the invoice total in the orders API." } }); // true

// Your own validator against the conformance fixtures: no problem means it accepts every valid one and refuses every invalid one.
console.log(conformanceProblems(runConformance(yourValidator, loadFixtures())));
```
