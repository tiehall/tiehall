// The event shape (requests: The event log; requests: Events carry ids, not
// bodies; activity-log: The activity log holds domain events and security
// events; design.md, Design rules: Requests and events, Technical decisions:
// T5 and Self-hosting decisions: S14). Every committed change appends an event
// in its own transaction. An event is in the domain class, a change to a
// request, or the security class, an action the activity log records for
// admins. It has a type, the fields its type declares, who caused it and when.
//
// Events carry ids, never bodies: a message event names the message, and a
// reader fetches its text through a read. They also never name a person or a
// record by an identifier from outside Tiehall, such as a GitHub login, an
// email address or an IP address; those live in Tiehall's own records, which
// the event names by id. So each event type declares its fields, and a field
// can only be the id of a Tiehall record, one of a fixed set of values Tiehall
// writes, a whole number or a boolean. checkEventType() refuses anything else,
// and eventData() refuses an event whose data is not what its type declares.

export const EVENT_CLASSES = ["domain", "security"] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

/**
 * The records Tiehall keeps that an event may name by id. Later tasks add the
 * kinds of the records they create. None of them is a record kept elsewhere,
 * such as a GitHub account: Tiehall names such an account through its own user
 * or invite record, or, for a GitHub account refused at sign-in, the record of
 * that refusal.
 */
export const RECORD_KINDS = [
  "request",
  "message",
  "revision",
  "proposal",
  "team",
  "user",
  "invite",
  "token",
  "client",
  "grant",
  "installation",
  "integration",
  "api",
  "change_set",
  "sign_in_refusal",
  "pull_request_link",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** The id of a Tiehall record, which is a UUID. */
export interface IdField {
  kind: "id";
  of: RecordKind;
  optional?: boolean;
}

/** One of a fixed set of lower-case values that Tiehall writes, such as a role or a state. */
export interface EnumField {
  kind: "enum";
  values: readonly [string, ...string[]];
  optional?: boolean;
}

/** A whole number, such as a new write budget. */
export interface IntegerField {
  kind: "integer";
  optional?: boolean;
}

export interface BooleanField {
  kind: "boolean";
  optional?: boolean;
}

export type EventField = IdField | EnumField | IntegerField | BooleanField;

export interface EventType {
  /** A dotted lower-case name, such as request.message_posted. */
  type: string;
  class: EventClass;
  fields: Readonly<Record<string, EventField>>;
}

/** An event type as it is written down, before the check has passed it. */
export interface DeclaredEventType {
  type: string;
  class: string;
  fields: Readonly<Record<string, { kind: string; of?: string; values?: readonly string[]; optional?: boolean }>>;
}

type FieldValue<F extends EventField> = F extends IdField
  ? string
  : F extends EnumField
    ? F["values"][number]
    : F extends IntegerField
      ? number
      : boolean;

type RequiredKeys<T extends EventType> = {
  [K in keyof T["fields"]]: T["fields"][K] extends { optional: true } ? never : K;
}[keyof T["fields"]];
type OptionalKeys<T extends EventType> = Exclude<keyof T["fields"], RequiredKeys<T>>;

/** The data an event of type T carries: exactly the fields T declares. */
export type EventData<T extends EventType> = { [K in RequiredKeys<T>]: FieldValue<T["fields"][K]> } & {
  [K in OptionalKeys<T>]?: FieldValue<T["fields"][K]>;
};

export type EventValue = string | number | boolean;

/** An event type or event data that breaks the event shape; its message says how. */
export class EventShapeError extends Error {
  override name = "EventShapeError";
}

const FIELD_KINDS: readonly string[] = ["id", "enum", "integer", "boolean"];
const TYPE_NAME = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const FIELD_NAME = /^[a-z][a-zA-Z0-9]*$/;
const ENUM_VALUE = /^[a-z][a-z0-9_]*$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The form of an event type's name, such as request.message_posted. */
export const EVENT_TYPE_NAME = TYPE_NAME;
/** The form of an event field's name, such as requestId. */
export const EVENT_FIELD_NAME = FIELD_NAME;
/** The form of an event's string values: the id of a Tiehall record, or one of a fixed set of lower-case values. */
export const EVENT_STRING_VALUE = new RegExp(`^(?:${UUID.source.slice(1, -1)}|${ENUM_VALUE.source.slice(1, -1)})$`);

/** Words in a field's name that say it holds content someone wrote. */
const BODY_WORDS = new Set([
  "body",
  "text",
  "content",
  "contents",
  "title",
  "summary",
  "description",
  "comment",
  "comments",
  "note",
  "notes",
  "name",
  "markdown",
  "html",
  "excerpt",
  "snippet",
]);

/** Words and phrases, in snake_case, that say a field holds an identifier from outside Tiehall. */
const EXTERNAL_PHRASES = [
  "github",
  "gh",
  "jira",
  "atlassian",
  "slack",
  "google",
  "login",
  "username",
  "email",
  "mail",
  "handle",
  "phone",
  "url",
  "uri",
  "ip",
  "user_agent",
];

/** Every way a declared event type breaks the event shape, as a sentence; none when it keeps it. */
export function checkEventType(declared: DeclaredEventType): string[] {
  const problems: string[] = [];
  const problem = (text: string) => problems.push(`${declared.type}: ${text}`);
  if (!TYPE_NAME.test(declared.type)) problem('the type is not a dotted lower-case name, such as "request.message_posted".');
  if (!(EVENT_CLASSES as readonly string[]).includes(declared.class)) {
    problem(`the class is ${declared.class}; an event is in the domain class or the security class.`);
  }
  const requestId = declared.fields["requestId"];
  if (declared.class === "domain" && (requestId?.kind !== "id" || requestId.of !== "request" || requestId.optional)) {
    problem('a domain event records a change to a request, so it declares "requestId", the id of a request.');
  }
  for (const [name, field] of Object.entries(declared.fields)) {
    if (!FIELD_NAME.test(name)) {
      problem(`field "${name}" is not a camelCase name.`);
      continue;
    }
    if (!FIELD_KINDS.includes(field.kind)) {
      problem(
        `field "${name}" is of kind ${field.kind}, which could carry a body. An event holds only Tiehall ids, ` +
          "fixed values, whole numbers and booleans; readers fetch content through reads.",
      );
    }
    const words = wordsOf(name);
    const isId = field.kind === "id";
    const endsInId = words.at(-1) === "id" || words.at(-1) === "ids";
    // An id field's own record kind is what it names, so those words are its point, not a problem.
    const exempt = new Set(isId && field.of !== undefined ? field.of.split("_") : []);
    const named = (endsInId ? words.slice(0, -1) : words).filter((word) => !exempt.has(word));
    if (named.some((word) => BODY_WORDS.has(word))) {
      problem(`field "${name}" names a body. An event carries the id of the record that holds the content, never the content.`);
    }
    const snake = `_${named.join("_")}_`;
    if (EXTERNAL_PHRASES.some((phrase) => snake.includes(`_${phrase}_`))) {
      problem(
        `field "${name}" names an identifier from outside Tiehall. An event names people and records only by their Tiehall ids.`,
      );
    }
    if (isId) {
      if (!(RECORD_KINDS as readonly string[]).includes(field.of ?? "")) {
        problem(`field "${name}" is the id of a ${field.of}, which is not a Tiehall record. An event names only records Tiehall keeps.`);
      } else if (words.at(-1) !== "id") {
        problem(`field "${name}" is the id of a ${field.of}, so its name ends in Id, such as "${camelCase(field.of ?? "")}Id".`);
      }
    } else if (endsInId && FIELD_KINDS.includes(field.kind)) {
      problem(
        `field "${name}" is named as an id but is of kind ${field.kind}. A field that ends in Id is the id of a ` +
          "Tiehall record, of kind id.",
      );
    }
    if (field.kind === "enum") {
      const values = field.values ?? [];
      if (values.length === 0) {
        problem(`field "${name}" lists no values; an enum field lists the fixed, lower-case values Tiehall writes.`);
      }
      for (const value of values.filter((each) => !ENUM_VALUE.test(each))) {
        problem(`field "${name}" lists the value "${value}"; an enum field lists the fixed, lower-case values Tiehall writes.`);
      }
    }
  }
  return problems;
}

/** checkEventType() for each type, and a problem for each name two types share. */
export function checkEventTypes(declared: readonly DeclaredEventType[]): string[] {
  const problems = declared.flatMap(checkEventType);
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { type } of declared) (seen.has(type) ? repeated : seen).add(type);
  for (const type of repeated) problems.push(`${type}: two event types have this name.`);
  return problems;
}

/** An event type, once the check has passed it; it throws EventShapeError, naming every problem, otherwise. */
export function defineEventType<const T extends EventType>(definition: T): T {
  const problems = checkEventType(definition);
  if (problems.length > 0) throw new EventShapeError(problems.join("\n"));
  return definition;
}

/**
 * The data of one event, checked against its type: every declared field that
 * is not optional is present, each holds what it declares, and nothing else is
 * there. It throws EventShapeError otherwise, naming the field, never its value.
 */
export function eventData<T extends EventType>(type: T, data: EventData<T>): Record<string, EventValue> {
  const given = data as Readonly<Record<string, unknown>>;
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(type.fields, name)) {
      throw new EventShapeError(`${type.type} has no field "${name}"; an event carries only the fields its type declares.`);
    }
  }
  const checked: Record<string, EventValue> = {};
  for (const [name, field] of Object.entries(type.fields)) {
    const value = given[name];
    if (value === undefined) {
      if (field.optional) continue;
      throw new EventShapeError(`${type.type}: "${name}" is missing.`);
    }
    const refuse = (what: string) => new EventShapeError(`${type.type}: "${name}" must be ${what}.`);
    switch (field.kind) {
      case "id":
        if (typeof value !== "string" || !UUID.test(value)) throw refuse(`the id of a ${field.of.replaceAll("_", " ")}, a UUID`);
        break;
      case "enum":
        if (typeof value !== "string" || !field.values.includes(value)) throw refuse(`one of ${field.values.join(", ")}`);
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isSafeInteger(value)) throw refuse("a whole number");
        break;
      case "boolean":
        if (typeof value !== "boolean") throw refuse("true or false");
        break;
    }
    checked[name] = value as EventValue;
  }
  return checked;
}

/** The lower-case words of a camelCase name. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(" ");
}

function camelCase(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
