import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  EventShapeError,
  checkEventType,
  checkEventTypes,
  checkProvenance,
  defineEventType,
  eventData,
  messagePosted,
  type DeclaredEventType,
} from "../src/index.ts";

// The event shape (requests: Events carry ids, not bodies; activity-log: The
// activity log holds domain events and security events). An event is in the
// domain class or the security class, has a type, the ids of what it concerns,
// who caused it and when. Each event type declares the fields it carries, and
// the check refuses a declaration that could carry a body, such as a message's
// text, or an identifier from outside Tiehall, such as a GitHub login: events
// name people and records only by their Tiehall ids, and readers fetch the
// content through reads.

const REQUEST_ID = "0b7c6a0e-4f7e-4f8e-9a53-5a8f6c0d1e21";
const MESSAGE_ID = "6f1d2c3b-8a9e-4b7c-9d0e-1f2a3b4c5d6e";
const USER_ID = "a3e4b5c6-d7e8-49f0-a1b2-c3d4e5f60718";

/** A message event type, as a later task would declare it, with extra fields. */
function messageEvent(fields: DeclaredEventType["fields"]): DeclaredEventType {
  return {
    type: "request.message_posted",
    class: "domain",
    fields: { requestId: { kind: "id", of: "request" }, messageId: { kind: "id", of: "message" }, ...fields },
  };
}

describe("the event type check", () => {
  it("passes every event type Tiehall defines", () => {
    expect(EVENT_TYPES.length).toBeGreaterThan(0);
    expect(checkEventTypes(EVENT_TYPES)).toEqual([]);
  });

  it("fails an event type that declares a body field", () => {
    expect(checkEventType(messageEvent({ text: { kind: "text" } }))).toEqual([
      'request.message_posted: field "text" is of kind text, which could carry a body. An event holds only ' +
        "Tiehall ids, fixed values, whole numbers and booleans; readers fetch content through reads.",
      'request.message_posted: field "text" names a body. An event carries the id of the record that holds ' +
        "the content, never the content.",
    ]);
    expect(checkEventType(messageEvent({ body: { kind: "integer" } }))).toEqual([
      'request.message_posted: field "body" names a body. An event carries the id of the record that holds ' +
        "the content, never the content.",
    ]);
    expect(checkEventType(messageEvent({ questionTitle: { kind: "enum", values: ["short"] } }))).toEqual([
      'request.message_posted: field "questionTitle" names a body. An event carries the id of the record that ' +
        "holds the content, never the content.",
    ]);
    expect(checkEventType(messageEvent({ packet: { kind: "json" } }))).toEqual([
      'request.message_posted: field "packet" is of kind json, which could carry a body. An event holds only ' +
        "Tiehall ids, fixed values, whole numbers and booleans; readers fetch content through reads.",
    ]);
  });

  it("fails an event type that declares an external identifier, such as a GitHub login", () => {
    const signIn = (fields: DeclaredEventType["fields"]): DeclaredEventType => ({
      type: "sign_in.refused",
      class: "security",
      fields,
    });
    expect(checkEventType(signIn({ githubLogin: { kind: "enum", values: ["octo_lee"] } }))).toEqual([
      'sign_in.refused: field "githubLogin" names an identifier from outside Tiehall. An event names people ' +
        "and records only by their Tiehall ids.",
    ]);
    expect(checkEventType(signIn({ githubAccountId: { kind: "integer" } }))).toEqual([
      'sign_in.refused: field "githubAccountId" names an identifier from outside Tiehall. An event names ' +
        "people and records only by their Tiehall ids.",
      'sign_in.refused: field "githubAccountId" is named as an id but is of kind integer. A field that ends ' +
        "in Id is the id of a Tiehall record, of kind id.",
    ]);
    expect(checkEventType(signIn({ email: { kind: "boolean" }, ipAddress: { kind: "integer" } }))).toEqual([
      'sign_in.refused: field "email" names an identifier from outside Tiehall. An event names people and ' +
        "records only by their Tiehall ids.",
      'sign_in.refused: field "ipAddress" names an identifier from outside Tiehall. An event names people and ' +
        "records only by their Tiehall ids.",
    ]);
    expect(checkEventType(signIn({ accountId: { kind: "id", of: "github_account" } }))).toEqual([
      'sign_in.refused: field "accountId" is the id of a github_account, which is not a Tiehall record. An ' +
        "event names only records Tiehall keeps.",
    ]);
    expect(checkEventType(signIn({ jiraUserId: { kind: "id", of: "user" } }))).toEqual([
      'sign_in.refused: field "jiraUserId" names an identifier from outside Tiehall. An event names people ' +
        "and records only by their Tiehall ids.",
    ]);
  });

  it("fails a domain event that names no request, and other malformed declarations", () => {
    expect(
      checkEventType({ type: "Request posted", class: "audit", fields: { requestId: { kind: "id", of: "request" } } }),
    ).toEqual([
      'Request posted: the type is not a dotted lower-case name, such as "request.message_posted".',
      "Request posted: the class is audit; an event is in the domain class or the security class.",
    ]);
    expect(checkEventType({ type: "request.claimed", class: "domain", fields: { userId: { kind: "id", of: "user" } } }))
      .toEqual([
        'request.claimed: a domain event records a change to a request, so it declares "requestId", the id of ' +
          "a request.",
      ]);
    expect(
      checkEventType({
        type: "member.role_changed",
        class: "security",
        fields: { member: { kind: "id", of: "user" }, role: { kind: "enum", values: [] }, "new-role": { kind: "boolean" } },
      }),
    ).toEqual([
      'member.role_changed: field "member" is the id of a user, so its name ends in Id, such as "userId".',
      'member.role_changed: field "role" lists no values; an enum field lists the fixed, lower-case values ' +
        "Tiehall writes.",
      'member.role_changed: field "new-role" is not a camelCase name.',
    ]);
    expect(
      checkEventType({
        type: "member.role_changed",
        class: "security",
        fields: { role: { kind: "enum", values: ["admin", "Whatever the caller typed"] } },
      }),
    ).toEqual([
      'member.role_changed: field "role" lists the value "Whatever the caller typed"; an enum field lists the ' +
        "fixed, lower-case values Tiehall writes.",
    ]);
  });

  it("fails two event types with the same name", () => {
    expect(checkEventTypes([messagePosted, messageEvent({})])).toEqual([
      "request.message_posted: two event types have this name.",
    ]);
  });

  it("refuses to define an event type that fails the check", () => {
    const declared = messageEvent({ text: { kind: "text" } });
    expect(() => defineEventType(declared as never)).toThrow(EventShapeError);
    expect(() => defineEventType(declared as never)).toThrow(/field "text" is of kind text/);
  });
});

describe("the data of an event", () => {
  it("holds the ids of the message event and nothing else", () => {
    expect(eventData(messagePosted, { requestId: REQUEST_ID, messageId: MESSAGE_ID })).toEqual({
      requestId: REQUEST_ID,
      messageId: MESSAGE_ID,
    });
  });

  it("refuses a field the event type does not declare, such as the message's text", () => {
    const withText = { requestId: REQUEST_ID, messageId: MESSAGE_ID, text: "Which endpoint?" };
    expect(() => eventData(messagePosted, withText as never)).toThrow(
      new EventShapeError('request.message_posted has no field "text"; an event carries only the fields its type declares.'),
    );
  });

  it("refuses a value that is not what its field declares", () => {
    expect(() => eventData(messagePosted, { requestId: REQUEST_ID, messageId: "octo-lee" })).toThrow(
      new EventShapeError('request.message_posted: "messageId" must be the id of a message, a UUID.'),
    );
    expect(() => eventData(messagePosted, { requestId: REQUEST_ID } as never)).toThrow(
      new EventShapeError('request.message_posted: "messageId" is missing.'),
    );
    const roleChanged = defineEventType({
      type: "member.role_changed",
      class: "security",
      fields: {
        userId: { kind: "id", of: "user" },
        role: { kind: "enum", values: ["admin", "member"] },
        budget: { kind: "integer", optional: true },
        removed: { kind: "boolean", optional: true },
      },
    });
    expect(eventData(roleChanged, { userId: USER_ID, role: "admin" })).toEqual({ userId: USER_ID, role: "admin" });
    expect(() => eventData(roleChanged, { userId: USER_ID, role: "owner" as never })).toThrow(
      new EventShapeError('member.role_changed: "role" must be one of admin, member.'),
    );
    expect(() => eventData(roleChanged, { userId: USER_ID, role: "admin", budget: 1.5 })).toThrow(
      new EventShapeError('member.role_changed: "budget" must be a whole number.'),
    );
    expect(() => eventData(roleChanged, { userId: USER_ID, role: "admin", removed: "yes" as never })).toThrow(
      new EventShapeError('member.role_changed: "removed" must be true or false.'),
    );
  });
});

describe("who caused an event", () => {
  it("accepts a user acting through an agent or a web session, the system, and an operator command", () => {
    expect(checkProvenance({ actorKind: "agent", userId: USER_ID, surface: "mcp", client: "https://client.example/meta" }))
      .toEqual([]);
    expect(checkProvenance({ actorKind: "web_session", userId: USER_ID, surface: "web" })).toEqual([]);
    expect(checkProvenance({ actorKind: "system", surface: "github" })).toEqual([]);
    expect(checkProvenance({ actorKind: "operator", command: "admin grant" })).toEqual([]);
  });

  it("refuses the actor kind human, which v1 never records, and a user named by anything but a Tiehall id", () => {
    expect(checkProvenance({ actorKind: "human", userId: USER_ID, surface: "web" } as never)).toEqual([
      "The actor kind human is reserved for a later confirmation that proves a person acted; v1 never records it.",
    ]);
    expect(checkProvenance({ actorKind: "agent", userId: "octo-lee", surface: "cli" })).toEqual([
      "The user who caused an event is named by their Tiehall id, a UUID.",
    ]);
    expect(checkProvenance({ actorKind: "agent", userId: USER_ID, surface: "slack" as never })).toEqual([
      "The surface slack is not one of web, mcp, cli, api, github, jira.",
    ]);
    expect(checkProvenance({ actorKind: "operator", command: "rm -rf" as never })).toEqual([
      "The operator command rm -rf is not one of admin grant, setup reopen.",
    ]);
  });
});
