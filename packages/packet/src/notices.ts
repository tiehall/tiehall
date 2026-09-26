// Notices that can reach a model (agent-safety: Notices that can reach a model
// carry only server text; design.md, Design rules: Agent safety; design.md,
// Self-hosting decisions: S10; design.md, Technical decisions: T14). Push text
// reaches an agent's context without the agent asking for it: the lines the
// Claude Code hooks print, the subjects of notification emails, and the
// message of an MCP URL-mode elicitation. So these templates take no text that
// anyone wrote: a hook line and an email subject carry only the request key,
// the event type, the team, which is the request's target team, and the
// request URL; an elicitation message carries only the request key and the
// kind of commitment. The agent pulls what people wrote separately, fenced.
//
// Each input has a type of its own that only the functions below make, each
// from a value it checks against the value's form, none of which holds a space:
// a title, a message or a packet can never be passed where a notice expects a
// key, a team or a URL. They live next to the renderer, in this Apache-2.0
// directory, because the CLI prints the hook lines.

declare const checked: unique symbol;

/** A value one of the functions below has checked, of the kind it names. */
type Checked<Kind extends string> = string & { readonly [checked]: Kind };

/** A request key, such as FE-142. */
export type NoticeKey = Checked<"request key">;
/** An event type, such as request.message_posted. */
export type NoticeEventType = Checked<"event type">;
/** A team key, such as FE. */
export type NoticeTeam = Checked<"team key">;
/** A request URL on the install, such as https://tiehall.example.com/FE-142. */
export type NoticeUrl = Checked<"request URL">;

/** The kinds of commitment an elicitation asks a person to confirm (requests: Commitments become proposals). */
export const COMMITMENT_KINDS = ["due_date", "scope", "decline", "reassign", "withdraw", "done"] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

/** What a hook line or an email subject says: a request, what happened to it, its target team and its URL. */
export interface Notice {
  readonly key: NoticeKey;
  readonly eventType: NoticeEventType;
  readonly team: NoticeTeam;
  readonly url: NoticeUrl;
}

/** A value that does not have the form its notice input needs; its message never quotes the value. */
export class NoticeInputError extends TypeError {
  override name = "NoticeInputError";
}

const TEAM = "[A-Z][A-Z0-9]{1,9}";
const REQUEST_KEY = new RegExp(`^${TEAM}-[1-9][0-9]{0,9}$`);
const TEAM_KEY = new RegExp(`^${TEAM}$`);
const EVENT_TYPE = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

function check<Kind extends string>(value: string, form: RegExp, kind: Kind, example: string): Checked<Kind> {
  if (!form.test(value)) throw new NoticeInputError(`A notice's ${kind} has the form ${example}.`);
  return value as Checked<Kind>;
}

/** A request key, checked. */
export function noticeKey(value: string): NoticeKey {
  return check(value, REQUEST_KEY, "request key", "FE-142");
}

/** A team key, checked. */
export function noticeTeam(value: string): NoticeTeam {
  return check(value, TEAM_KEY, "team key", "FE");
}

/** An event type, checked. */
export function noticeEventType(value: string): NoticeEventType {
  return check(value, EVENT_TYPE, "event type", "request.message_posted");
}

/** The URL of a request on the install: the install's origin, such as TIEHALL_URL gives it, and the key. */
export function noticeUrl(installUrl: string, key: NoticeKey): NoticeUrl {
  let origin: string;
  try {
    const url = new URL(installUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError();
    origin = url.origin;
  } catch {
    throw new NoticeInputError("A notice's request URL starts with the install's http or https URL.");
  }
  return `${origin}/${noticeKey(key)}` as NoticeUrl;
}

/** One line of the Claude Code hooks' output about an update, such as "FE-142 request.message_posted (team FE) https://…/FE-142". */
export function hookLine({ key, eventType, team, url }: Notice): string {
  return `${key} ${eventType} (team ${team}) ${url}`;
}

/** The subject of a notification email about an update. */
export function emailSubject({ key, eventType, team }: Notice): string {
  return `Tiehall: ${key} ${eventType} (team ${team})`;
}

/** What each kind of commitment proposes to do to a request, in Tiehall's words. */
const PROPOSALS: Readonly<Record<CommitmentKind, (key: NoticeKey) => string>> = {
  due_date: (key) => `change the due date of ${key}`,
  scope: (key) => `change the scope of ${key}`,
  decline: (key) => `decline ${key}`,
  reassign: (key) => `reassign ${key} to another team`,
  withdraw: (key) => `withdraw ${key}`,
  done: (key) => `mark ${key} done`,
};

/** The message of a URL-mode elicitation for a proposal's confirm page. */
export function elicitationMessage({ key, commitment }: { key: NoticeKey; commitment: CommitmentKind }): string {
  const proposal = Object.hasOwn(PROPOSALS, commitment) ? PROPOSALS[commitment] : undefined;
  if (proposal === undefined) throw new NoticeInputError("A notice's commitment is one of the kinds of commitment.");
  return `Open Tiehall to confirm or reject the proposal to ${proposal(noticeKey(key))}.`;
}
