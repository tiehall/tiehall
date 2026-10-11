import { createRequest, PACKET_SCHEMA_VERSION, readDirectory, webShell, whoami, type IntakeField } from "@tiehall/catalog";
import { Refusal, type RefusalIssue } from "@tiehall/core";
import { requiredFieldsText } from "@tiehall/packet/tool-text";
import { escapeHtml, htmlPage, PAGE_HEADERS } from "./html.ts";
import type { PageShell, ShellMember } from "./shell.ts";
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
// its URL. A form its input refuses comes back with what was typed, the
// refusal in an alert at its top and each refused field's error beside it
// (web-ui: Pages are accessible); any other refusal is a page that leads back
// to the form (see web-pages.ts). A member of no team is told they cannot open
// a request, and their form's POST gets 403. The form is laid out as the
// design draws it: From and To joined by a line, each field's label saying
// whether it is required, and by which team, or optional, and its hint tied to
// its control (web-ui: Pages work at phone width; design.md, Design: The page
// families; D57 (7), (8)).

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
      schema_version: PACKET_SCHEMA_VERSION,
      kind: "request",
      ...(dueDate === "" ? {} : { due_date: dueDate }),
      untrusted,
    },
  };
}

/** What a refused form gave and what was refused: the fields' values, the refusal's detail, and its issues by the form's field. */
interface Refused {
  values: URLSearchParams;
  detail: string;
  /** The messages of the issues the form places beside a field, by the field's id. */
  byField: ReadonlyMap<string, string[]>;
  /** The messages of the issues of no field of the form. */
  others: string[];
}

/** The form's field an issue of requests.create names, by its path; undefined for a path of no field of the form. */
function fieldOfIssue(path: readonly (string | number)[]): string | undefined {
  const [first, second, third] = path;
  if (first === "title" || first === "targetTeam" || first === "requestingTeam" || first === "codeRefs") return first;
  if (first !== "packet") return undefined;
  if (second === "due_date") return "dueDate";
  if (second !== "untrusted") return undefined;
  const fields: Readonly<Record<string, string>> = { need: "need", acceptance_criteria: "acceptanceCriteria", code_refs: "codeRefs", links: "links" };
  return typeof third === "string" ? fields[third] : undefined;
}

/**
 * What a field needs, in Tiehall's words, said beside it when the operation's
 * schema refused the form: the schema's own issues are its library's words,
 * such as "Too small: expected string to have >=1 characters", which read like
 * code (web-ui: Pages are accessible).
 */
const FIELD_NEEDS: Readonly<Record<string, string>> = {
  title: "Write a title: one line of 1 to 200 characters, not blank.",
  need: "Say what you need, in 1 to 20,000 characters, not blank.",
  acceptanceCriteria: "Write each acceptance criterion on a line of its own, in at most 2,000 characters, not blank.",
  codeRefs: "A code ref is a repository, then a path and a ref if you like, separated by spaces.",
  links: "A link is an http or https address, then what it is if you like, separated by a space.",
  dueDate: "A due date is a day, such as 2026-11-02.",
  targetTeam: "Choose the team the request is for.",
  requestingTeam: "Choose one of your teams.",
};

/** Whether a refusal is the operation's schema's, whose issues are its library's words, not Tiehall's. */
function refusedBySchema(refusal: Refusal): boolean {
  return refusal.message.endsWith("does not match its schema.");
}

/** A form's refusal, with its issues placed beside the fields they name, each in Tiehall's words. */
function refusedFrom(refusal: Refusal, values: URLSearchParams): Refused {
  const bySchema = refusedBySchema(refusal);
  const byField = new Map<string, string[]>();
  const others = new Set<string>();
  for (const { path, message } of refusal.issues) {
    const field = fieldOfIssue(path);
    if (field === undefined) others.add(bySchema ? "A value the form sent does not fit its field: check the fields, then send it again." : path.length === 0 ? message : `${path.join(".")}: ${message}`);
    else {
      const said = bySchema ? (FIELD_NEEDS[field] ?? message) : message;
      const known = byField.get(field) ?? [];
      if (!known.includes(said)) byField.set(field, [...known, said]);
    }
  }
  const detail = bySchema ? "Some of its fields need a change: each says what, beside it." : refusal.message;
  return { values, detail, byField, others: [...others] };
}

/** A select of teams, by key and name, with the one chosen, if any, selected. */
function teamSelect(id: string, teams: readonly { key: string; name?: string | undefined }[], chosen: string | undefined, describedBy: string | undefined): string {
  const options = teams
    .map(({ key, name }) => `<option value="${escapeHtml(key)}"${key === chosen ? " selected" : ""}>${escapeHtml(name === undefined || name === key ? key : `${key} · ${name}`)}</option>`)
    .join("");
  return `<select id="${id}" name="${id}"${describedBy === undefined ? "" : ` aria-describedby="${describedBy}" aria-invalid="true"`}>${options}</select>`;
}

/** The errors of a refused field, beside it, which its control names in aria-describedby; none when it was not refused. */
function fieldErrors(id: string, refused: Refused | undefined): { html: string[]; describedBy: string | undefined } {
  const messages = refused?.byField.get(id) ?? [];
  if (messages.length === 0) return { html: [], describedBy: undefined };
  return { html: [`          <p class="field-error" id="${id}-error">${escapeHtml(messages.join(" "))}</p>`], describedBy: `${id}-error` };
}

/**
 * A field of the form: its label, which says whether it is required, and by
 * which team, or optional; its control; its hint and, on a refused form, its
 * errors, both tied to the control with aria-describedby (web-ui: Pages are
 * accessible).
 */
function field(options: { id: string; label: string; need: string; control: (attributes: string) => string; hint?: string | undefined; refused: Refused | undefined }): string {
  const { id, label, need, control, hint, refused } = options;
  const errors = fieldErrors(id, refused);
  const described = [...(hint === undefined ? [] : [`${id}-hint`]), ...(errors.describedBy === undefined ? [] : [errors.describedBy])];
  const attributes = `${described.length === 0 ? "" : ` aria-describedby="${described.join(" ")}"`}${errors.describedBy === undefined ? "" : ' aria-invalid="true"'}`;
  return [
    '        <div class="field">',
    `          <label for="${id}">${escapeHtml(label)} <span class="need">${escapeHtml(`· ${need}`)}</span></label>`,
    `          ${control(attributes)}`,
    ...(hint === undefined ? [] : [`          <p class="hint" id="${id}-hint">${escapeHtml(hint)}</p>`]),
    ...errors.html,
    "        </div>",
  ].join("\n");
}

/** One of the packet's optional fields, marked required by the chosen team when it requires it, and optional otherwise. */
function packetField(intake: IntakeField, team: DirectoryTeam | undefined, refused: Refused | undefined): string {
  const { id, label } = FIELDS[intake];
  const required = team?.requiredFields.includes(intake) === true;
  const hint: Readonly<Record<IntakeField, string | undefined>> = {
    acceptance_criteria: "One criterion per line.",
    code_refs: "One per line: a repository, then a path and a ref if you like, such as acme/web src/settings main.",
    links: "One per line: a URL, then a title if you like.",
    due_date: undefined,
  };
  const value = refused?.values.get(id) ?? "";
  return field({
    id,
    label,
    need: required ? `required by ${team?.key ?? ""}` : "optional",
    hint: hint[intake],
    refused,
    control: (attributes) =>
      intake === "due_date"
        ? `<input type="date" id="${id}" name="${id}"${required ? " required" : ""}${attributes}${value === "" ? "" : ` value="${escapeHtml(value)}"`}>`
        : `<textarea id="${id}" name="${id}"${required ? " required" : ""}${attributes} rows="3">${escapeHtml(value)}</textarea>`,
  });
}

/** The line drawn between From and To, from the requesting team to the target team, which flows three times. */
const FROM_TO_LINE =
  '<svg class="team-line from-to-line" viewBox="0 0 90 44" width="90" height="44" aria-hidden="true" focusable="false"><path class="line-flow" d="M4 30 C 30 6, 60 6, 86 30"/></svg>';

/** What the chosen team asks of the requests opened to it: its intake notes, as text an admin wrote, and its required fields; or each team's required fields. */
function intakeNotice(teams: readonly DirectoryTeam[], team: DirectoryTeam | undefined): string[] {
  if (team === undefined) {
    const requiring = teams.filter(({ requiredFields }) => requiredFields.length > 0);
    if (requiring.length === 0) return [];
    return [
      '      <div class="intake-notice" id="intake">',
      ...requiring.map(({ key, requiredFields }) => `        <p>${escapeHtml(`${key} requires ${requiredFieldsText(requiredFields)}.`)}</p>`),
      "      </div>",
    ];
  }
  if (team.untrusted.intakeNotes === "" && team.requiredFields.length === 0) return [];
  return [
    '      <div class="intake-notice" id="intake">',
    ...(team.untrusted.intakeNotes === ""
      ? []
      : [`        <h2>${escapeHtml(`How ${team.key} wants requests filed`)}</h2>`, `        <p class="notes">${escapeHtml(team.untrusted.intakeNotes)}</p>`]),
    ...(team.requiredFields.length === 0 ? [] : [`        <p>${escapeHtml(`${team.key} requires ${requiredFieldsText(team.requiredFields)}.`)}</p>`]),
    "      </div>",
  ];
}

function newRequestPage(teams: readonly DirectoryTeam[], mine: readonly string[], chosen: string | undefined, csrf: string, shell: PageShell, refused?: Refused): string {
  if (mine.length === 0) {
    return htmlPage(
      "Open a request",
      [
        '      <div class="narrow">',
        "        <h1>Open a request</h1>",
        "        <p>You belong to no team, so you cannot open a request: a request comes from one of your teams. An admin adds you to a team on the teams page.</p>",
        "      </div>",
      ].join("\n"),
      shell,
    );
  }
  const team = teams.find(({ key }) => key === chosen);
  const value = (name: string) => escapeHtml(refused?.values.get(name) ?? "");
  const from = fieldErrors("requestingTeam", refused);
  const to = fieldErrors("targetTeam", refused);
  return htmlPage(
    "Open a request",
    [
      '      <div class="narrow">',
      '      <div class="page-intro">',
      "        <h1>Open a request</h1>",
      "        <p class=\"lead\">A request is addressed to a team, and comes from one of yours. Its title and packet are what the other team and their agents read; most people let their own agent write it with <code>tiehall open</code>.</p>",
      "      </div>",
      ...(refused === undefined
        ? []
        : [
            '      <div role="alert">',
            `        <p><strong>The request was not opened.</strong> ${escapeHtml(refused.detail)}</p>`,
            ...(refused.others.length === 0 ? [] : ["        <ul>", ...refused.others.map((message) => `          <li>${escapeHtml(message)}</li>`), "        </ul>"]),
            "      </div>",
          ]),
      ...intakeNotice(teams, team),
      `      <form class="panel form-panel" method="post" action="${NEW_REQUEST_PATH}">`,
      `        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
      '        <div class="from-to">',
      '          <div class="field">',
      '            <label for="requestingTeam">From team</label>',
      `            ${teamSelect("requestingTeam", mine.map((key) => ({ key, name: teams.find((each) => each.key === key)?.untrusted.name })), refused?.values.get("requestingTeam") ?? undefined, from.describedBy)}`,
      ...from.html,
      "          </div>",
      `          ${FROM_TO_LINE}`,
      '          <div class="field">',
      '            <label for="targetTeam">To team</label>',
      `            ${teamSelect("targetTeam", teams.map(({ key, untrusted }) => ({ key, name: untrusted.name })), chosen, to.describedBy)}`,
      ...to.html,
      "          </div>",
      "        </div>",
      field({
        id: "title",
        label: "Title",
        need: "required",
        hint: "One line the other team sees in their list.",
        refused,
        control: (attributes) => `<input type="text" id="title" name="title" maxlength="200" required${attributes} value="${value("title")}">`,
      }),
      field({
        id: "need",
        label: "What you need",
        need: "required",
        refused,
        control: (attributes) => `<textarea id="need" name="need" required${attributes} rows="5">${value("need")}</textarea>`,
      }),
      packetField("acceptance_criteria", team, refused),
      '        <div class="field-pair">',
      packetField("code_refs", team, refused),
      packetField("links", team, refused),
      "        </div>",
      packetField("due_date", team, refused),
      '        <div class="form-end">',
      '          <button type="submit">Open the request</button>',
      `          <a class="link-action" href="/requests">Cancel</a>`,
      "        </div>",
      "      </form>",
      "      </div>",
    ].join("\n"),
    shell,
  );
}

export function createNewRequestRoute(options: PageRouteOptions): PageRoute {
  return createPageRoute(options, {
    path: NEW_REQUEST_PATH,
    name: "new request",
    async get(query, { read, csrf, shell }) {
      const { teams } = await read<{ teams: DirectoryTeam[] }>(readDirectory.id, {});
      const { teams: mine } = await read<{ teams: { key: string }[] }>(whoami.id, {});
      const chosen = query.get("team") ?? undefined;
      return htmlAnswer(newRequestPage(teams, mine.map(({ key }) => key), chosen, csrf, shell));
    },
    async post(form, { read, write, csrf }) {
      try {
        const opened = (await write(createRequest.id, inputOf(form))) as { key: string };
        return seeOther(`/${opened.key}`);
      } catch (error) {
        // A form the operation refuses for its input comes back with what was typed, the refusal at its top and each
        // refused field named beside it (web-ui: Pages are accessible); any other refusal is the refusal's page.
        if (!(error instanceof Refusal) || error.reason !== "invalid-input") throw error;
        const { teams } = await read<{ teams: DirectoryTeam[] }>(readDirectory.id, {});
        const { teams: mine } = await read<{ teams: { key: string }[] }>(whoami.id, {});
        const member = await read<ShellMember>(webShell.id, {});
        const shell: PageShell = { form: "app", member, path: NEW_REQUEST_PATH, csrf };
        const chosen = form.get("targetTeam") ?? undefined;
        const page = newRequestPage(teams, mine.map(({ key }) => key), chosen, csrf, shell, refusedFrom(error, form));
        return new Response(page, { status: error.status, headers: PAGE_HEADERS });
      }
    },
  });
}
