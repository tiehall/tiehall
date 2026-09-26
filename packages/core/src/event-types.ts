import { defineEventType, type EventType } from "./events.ts";

// The event types Tiehall writes (requests: The event log; activity-log: Which
// actions are security events). Each task that adds a change adds the type of
// its event here, and a test runs checkEventTypes() over the list.

/** A message posted in a request's thread. It names the message; readers fetch its text through a read. */
export const messagePosted = defineEventType({
  type: "request.message_posted",
  class: "domain",
  fields: {
    requestId: { kind: "id", of: "request" },
    messageId: { kind: "id", of: "message" },
  },
});

export const EVENT_TYPES: readonly EventType[] = [messagePosted];
