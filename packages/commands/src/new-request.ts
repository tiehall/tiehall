import { createRequest, readDirectory, whoami, type IntakeField } from "@tiehall/catalog";
import { Refusal, type RefusalIssue } from "@tiehall/core";
import { requiredFieldsText } from "@tiehall/packet/tool-text";
import { escapeHtml, htmlPage } from "./html.ts";
import { createPageRoute, htmlAnswer, seeOther, type PageRoute, type PageRouteOptions } from "./web-pages.ts";

// The web form that opens a request, at /requests/new (requests: A request is
// addressed to a team of the install; requests: The requester picks the
// requesting team; agent-surfaces: Admins set a team's intake notes and
// required fields; public-api: One definition per operation, the same on
// every surface; design.md, Technical decisions: T3). A member picks the team
// the request is addressed to, among every team of the install, and the team
// of theirs it comes from, and writes the request's title and its packet: the
// need, which every packet has, and, if they give them, the acceptance
// criteria, one per line; code refs, one per line, a repository and then a
// path and a ref if they like; links, one per line, a URL and then a title if
// they like; and a due date. The page reads the teams through directory and
// the member's own through whoami, as agents do. Given a team, as
// /requests/new?team=FE, the form is for that team: it shows the notes in
// which the team says how it wants requests filed, as text an admin wrote,
// and marks the fields the team requires as required; otherwise it names
// each team's required fields. The form's POST opens the request through
// execute(), as the member's web session, and leads to the request's page, at
// its URL; a refusal is a page that lists what failed, where the input fails
// its schema, and leads back to the form (see web-pages.ts). A member of no
// team is told they cannot open a request, and their form's POST gets 403.

/** Where the web form that opens a request lives. */
export const NEW_REQUEST_PATH = "/requests/new";

/** A team as the directory lists it. */
interface DirectoryTeam {
  key: string;
  requiredFields: IntakeField[];
  untrusted: { name: string; intakeNotes: string };
}

/** Each packet field a team may require, as the form names it, with its control's id and how many it takes. */
const FIELDS: Readonly<Record<IntakeField, { id: string; label: string; plural: boolean }>> = {
  acceptance_criteria: { id: "acceptanceCriteria", label: "Acceptance criteria", plural: true },
  code_refs: { id: "codeRefs", label: "Code refs", plural: true },
  links: { id: "links", label: "Links", plural: true },
  due_date: { id: "dueDate", label: "Due date", plural: false },
};

/** The non-blank lines of a text area, trimmed. */
function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** A packet's text fields as a form of the web UI writes them: the need, and the acceptance criteria, code refs and links, one per line. */
export interface PacketText {
  need: string;
  acceptance_criteria?: string[];
  code_refs?: { repository: string; path?: string; ref?: string }[];
  links?: { url: string; title?: string }[];
}

/**
 * The packet's text fields a form's fields make, as the web form that opens a
 * request and the packet change on a request's page write them: the need,
 * and, when the form gives them, the acceptance criteria, one per line; code
 * refs, one per line, a repository and then a path and a ref if the person
 * likes; and links, one per line, a URL and then a title. A code ref of more
 * than three parts is refused with 400.
 */
export function packetTextOf(form: URLSearchParams): PacketText {
  const text = (name: string) => form.get(name) ?? "";
  const issues: RefusalIssue[] = [];
  const codeRefs = lines(text("codeRefs")).map((line, index) => {
    const [repository = "", path, ref, ...rest] = line.split(/\s+/);
    if (rest.length > 0) issues.push({ path: ["codeRefs", index], message: "A code ref is a repository, then a path and a ref if you like, separated by spaces." });
    return { repository, ...(path === undefined ? {} : { path }), ...(ref === undefined ? {} : { ref }) };
  });
  if (issues.length > 0) throw new Refusal("invalid-input", "The form's code refs do not match their form.", { issues });
  const links = lines(text("links")).map((line) => {
    const [url = "", ...title] = line.split(/\s+/);
    return { url, ...(title.length === 0 ? {} : { title: title.join(" ") }) };
  });
  const criteria = lines(text("acceptanceCriteria"));
  return {
    need: text("need"),
    ...(criteria.length === 0 ? {} : { acceptance_criteria: criteria }),
    ...(codeRefs.length === 0 ? {} : { code_refs: codeRefs }),
    ...(links.length === 0 ? {} : { links }),
  };
}

/** A packet's code refs and links as the lines of the web UI's forms: each on its own line, its parts separated by a space. */
export function packetLinesOf(untrusted: {
  acceptance_criteria?: readonly string[] | undefined;
  code_refs?: readonly { repository: string; path?: string | undefined; ref?: string | undefined }[] | undefined;
  links?: readonly { url: string; title?: string | undefined }[] | undefined;
}): { acceptanceCriteria: string; codeRefs: string; links: string } {
  return {
    acceptanceCriteria: (untrusted.acceptance_criteria ?? []).join("\n"),
    codeRefs: (untrusted.code_refs ?? []).map(({ repository, path, ref }) => [repository, path, ref].filter((part) => part !== undefined).join(" ")).join("\n"),
    links: (untrusted.links ?? []).map(({ url, title }) => (title === undefined ? url : `${url} ${title}`)).join("\n"),
  };
}

/** The input of requests.create that the form's fields make. */
function inputOf(form: URLSearchParams): Record<string, unknown> {
  const text = (name: string) => form.get(name) ?? "";
  const untrusted = packetTextOf(form);
  const dueDate = text("dueDate").trim();
  const requestingTeam = text("requestingTeam");
  return {
    targetTeam: text("targetTeam"),
    ...(requestingTeam === "" ? {} : { requestingTeam }),
    title: text("title"),
    packet: {
      schema_version: "1-beta",
      kind: "request",
      ...(dueDate === "" ? {} : { due_date: dueDate }),
      untrusted,
    },
  };
}

/** A select of team keys, with the one chosen, if any, selected. */
function teamSelect(id: string, keys: readonly string[], chosen: string | undefined): string {
  const options = keys.map((key) => `<option value="${escapeHtml(key)}"${key === chosen ? " selected" : ""}>${escapeHtml(key)}</option>`).join("");
  return `<select id="${id}" name="${id}">${options}</select>`;
}

/** One of the packet's optional fields, marked required when the chosen team requires it. */
function packetField(field: IntakeField, team: DirectoryTeam | undefined): string {
  const { id, label, plural } = FIELDS[field];
  const required = team?.requiredFields.includes(field) === true;
  const marked = required ? ` (${team?.key ?? ""} requires ${plural ? "them" : "it"})` : "";
  const hint: Readonly<Record<IntakeField, string>> = {
    acceptance_criteria: "One criterion per line.",
    code_refs: "One per line: a repository, then a path and a ref if you like, such as acme/web src/settings main.",
    links: "One per line: a URL, then a title if you like.",
    due_date: "",
  };
  const control =
    field === "due_date"
      ? `<input type="date" id="${id}" name="${id}"${required ? " required" : ""}>`
      : `<textarea id="${id}" name="${id}"${required ? " required" : ""}></textarea>`;
  return [
    `        <p><label for="${id}">${escapeHtml(`${label}${marked}`)}</label></p>`,
    ...(hint[field] === "" ? [] : [`        <p>${escapeHtml(hint[field])}</p>`]),
    `        <p>${control}</p>`,
  ].join("\n");
}

function newRequestPage(teams: readonly DirectoryTeam[], mine: readonly string[], chosen: string | undefined, csrf: string): string {
  if (mine.length === 0) {
    return htmlPage(
      "Open a request",
      [
        "      <h1>Open a request</h1>",
        "      <p>You belong to no team, so you cannot open a request: a request comes from one of your teams. An admin adds you to a team on the teams page.</p>",
      ].join("\n"),
    );
  }
  const team = teams.find(({ key }) => key === chosen);
  const intake =
    team === undefined
      ? teams
          .filter(({ requiredFields }) => requiredFields.length > 0)
          .map(({ key, requiredFields }) => `      <p>${escapeHtml(`${key} requires ${requiredFieldsText(requiredFields)}.`)}</p>`)
      : [
          ...(team.untrusted.intakeNotes === ""
            ? []
            : [`      <h2>${escapeHtml(`How ${team.key} wants requests filed`)}</h2>`, `      <pre>${escapeHtml(team.untrusted.intakeNotes)}</pre>`]),
        ];
  return htmlPage(
    "Open a request",
    [
      "      <h1>Open a request</h1>",
      "      <p>A request is addressed to a team, and comes from one of yours. Its title and packet are what the other team and their agents read.</p>",
      ...intake,
      `      <form method="post" action="${NEW_REQUEST_PATH}">`,
      `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
      `        <p><label for="targetTeam">To team</label> ${teamSelect("targetTeam", teams.map(({ key }) => key), chosen)}</p>`,
      `        <p><label for="requestingTeam">From team</label> ${teamSelect("requestingTeam", mine, undefined)}</p>`,
      '        <p><label for="title">Title</label> <input type="text" id="title" name="title" maxlength="200" required></p>',
      '        <p><label for="need">What you need</label></p>',
      '        <p><textarea id="need" name="need" required></textarea></p>',
      packetField("acceptance_criteria", team),
      packetField("code_refs", team),
      packetField("links", team),
      packetField("due_date", team),
      '        <button type="submit">Open the request</button>',
      "      </form>",
    ].join("\n"),
  );
}

export function createNewRequestRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: NEW_REQUEST_PATH,
    name: "new request",
    async get(query, { read, csrf }) {
      const { teams } = await read<{ teams: DirectoryTeam[] }>(readDirectory.id, {});
      const { teams: mine } = await read<{ teams: { key: string }[] }>(whoami.id, {});
      const chosen = query.get("team") ?? undefined;
      return htmlAnswer(newRequestPage(teams, mine.map(({ key }) => key), chosen, csrf));
    },
    async post(form, { write }) {
      const opened = (await write(createRequest.id, inputOf(form))) as { key: string };
      return seeOther(`/${opened.key}`);
    },
  });
}
