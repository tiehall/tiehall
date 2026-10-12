import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { noticeEventType, noticeKey, noticeTeam, noticeUrl, type Notice } from "@tiehall/packet/notices";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DIGEST_HEADING, DIGEST_MORE, DIGEST_UPGRADE, reminderOf, REMINDER_HEADING, sessionDigestOf } from "../src/hooks.ts";
import { watchLine } from "../src/watch.ts";

// The texts the CLI prints about updates come from templates
// (self-host-install: No model calls; requester-loop: Claude Code
// SessionStart digest; requester-loop: Claude Code Stop-hook waiter;
// requester-loop: The plugin monitor fallback): the SessionStart digest, the
// waiter's reminder and the lines of `tiehall watch`, each Tiehall's words
// and a notice line per update, and the digest's line that asks to upgrade an
// old CLI, Tiehall's words alone. Each is rendered twice from the updates of one
// request that does not change, FE-142, with the clock a day and a half later,
// another time zone and another Math.random for the second rendering, and
// both renderings are identical. The rest of what Tiehall writes is in
// packages/commands/test/templates-twice.test.ts. A check fails when the
// hooks or `tiehall watch` print anything but these builders' text, or a
// problem's.

const INSTALL = "https://tiehall.example.com";

/** The updates of FE-142 the hooks announce. */
function updates(): { notice: Notice }[] {
  const key = noticeKey("FE-142");
  const url = noticeUrl(INSTALL, key);
  return ["request.claimed", "request.message_posted", "request.state_changed"].map((type) => ({ notice: { key, eventType: noticeEventType(type), team: noticeTeam("FE"), url } }));
}

const TEXTS: Record<string, (() => string)[]> = {
  sessionDigestOf: [() => sessionDigestOf({ notices: updates(), more: false }), () => sessionDigestOf({ notices: updates(), more: true })],
  reminderOf: [() => reminderOf(updates())],
  watchLine: updates().map(({ notice }) => () => watchLine(notice)),
  DIGEST_HEADING: [() => DIGEST_HEADING],
  DIGEST_MORE: [() => DIGEST_MORE],
  REMINDER_HEADING: [() => REMINDER_HEADING],
  DIGEST_UPGRADE: [() => DIGEST_UPGRADE],
};

/** Moves the clock, the time zone and Math.random, so that a rendering that reads any of them differs. */
function elsewhere(at: string, zone: string, random: number): void {
  vi.setSystemTime(new Date(at));
  process.env["TZ"] = zone;
  vi.spyOn(Math, "random").mockReturnValue(random);
}

const zone = process.env["TZ"];

describe("the CLI's texts about updates, rendered twice from FE-142 unchanged", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });

  it.each(Object.entries(TEXTS))("%s writes the same text both times", (_, renders) => {
    elsewhere("2026-10-20T08:00:00Z", "UTC", 0.123);
    const first = renders.map((render) => render());
    vi.restoreAllMocks();
    elsewhere("2026-10-21T20:30:00Z", "Pacific/Kiritimati", 0.987);
    const second = renders.map((render) => render());
    vi.restoreAllMocks();
    for (const text of first) expect(text.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it("finds the hooks and tiehall watch printing only these texts, and a problem's", () => {
    const printed: string[] = [];
    for (const file of ["hooks.ts", "watch.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");
      for (const match of source.matchAll(/environment\.std(?:out|err)\((.*)\);$/gm)) printed.push(`${file}: ${match[1]}`);
    }
    expect(printed).toEqual([
      "hooks.ts: reminderOf(notices)",
      "hooks.ts: `${DIGEST_UPGRADE}\\n`",
      "hooks.ts: sessionDigestOf(news)",
      "watch.ts: watchLine(notice)",
      "watch.ts: problemText(waited.problem)",
      "watch.ts: `${waited.error.message}\\n`",
      "watch.ts: `The install refused tiehall watch, and gave no problem the CLI can show.\\n`",
    ]);
  });
});
