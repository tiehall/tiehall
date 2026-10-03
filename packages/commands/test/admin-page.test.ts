import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_PATH, createAdminRoute, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, URL_OF_INSTALL, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";
import { sessionOf, tokenOf } from "./support/requests.ts";

// The admin page at /admin (self-host-install: The admin page warns about
// missing backups; design.md, Self-hosting decisions: S11). It shows when the
// last backup finished, as backup.sh recorded it, and warns when no backup
// has finished yet, or none in the last 7 days. The clock is the test's own.

let install: TestInstall;
let now = new Date("2026-10-01T09:00:00Z");
let ada: WebSessionCaller;

beforeAll(async () => {
  install = await startTestInstall({ now: () => now });
  ada = sessionOf(await addUser(install.owner, { role: "admin", login: "ada" }));
});

afterAll(async () => {
  await install.close();
});

beforeEach(async () => {
  now = new Date("2026-10-01T09:00:00Z");
  await install.owner.query("DELETE FROM backups");
});

const page = (session: WebSessionCaller | undefined) =>
  createAdminRoute({ execute: install.execute, session: async () => session, url: URL_OF_INSTALL, secret: () => install.authSecret, logger: install.logger });

async function adminPage(session: WebSessionCaller | undefined = ada): Promise<{ status: number; html: string }> {
  const answer = await page(session)(new Request(`${URL_OF_INSTALL}${ADMIN_PATH}`, { headers: { accept: "text/html" } }));
  return { status: answer.status, html: (await answer.text()).replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code))) };
}

/** Records a backup that finished at this time, as backup.sh records one. */
async function backupFinished(at: Date, file = `tiehall-${at.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.dump`): Promise<void> {
  await install.owner.query("INSERT INTO backups (org_id, finished_at, file, size_bytes) SELECT id, $1, $2, 4096 FROM orgs", [at, file]);
}

const days = (count: number) => count * 24 * 60 * 60 * 1000;

describe("the admin page's backups", () => {
  it("warns that no backup has run on an install where backup.sh has never finished", async () => {
    const { status, html } = await adminPage();
    expect(status).toBe(200);
    expect(html).toContain("No backup has finished yet.");
    expect(html).toContain("Run backup.sh on the host every day and before every upgrade");
  });

  it("shows the time of the last backup, 8 days old, and warns that no backup has finished in the last 7 days", async () => {
    await backupFinished(new Date(now.getTime() - days(8)));
    const { html } = await adminPage();
    expect(html).toContain("The last backup finished at 2026-09-23 09:00 UTC, 8 days ago");
    expect(html).toContain("No backup has finished in the last 7 days.");
    expect(html).not.toContain("No backup has finished yet.");
  });

  it("shows the time of a recent backup, 2 days old, and no backup warning", async () => {
    await backupFinished(new Date(now.getTime() - days(8)));
    await backupFinished(new Date(now.getTime() - days(2)), "tiehall-20260929T090000Z.dump");
    const { html } = await adminPage();
    expect(html).toContain("The last backup finished at 2026-09-29 09:00 UTC, 2 days ago: tiehall-20260929T090000Z.dump.");
    expect(html).not.toContain("No backup has finished");
  });

  it("warns once the last backup is more than 7 days old, as the clock moves on", async () => {
    await backupFinished(new Date(now.getTime() - days(2)));
    now = new Date(now.getTime() + days(5) - 60_000);
    expect((await adminPage()).html).not.toContain("No backup has finished in the last 7 days.");
    now = new Date(now.getTime() + 2 * 60_000);
    expect((await adminPage()).html).toContain("No backup has finished in the last 7 days.");
  });

  it("sends a browser without a session to sign in first", async () => {
    const answer = await page(undefined)(new Request(`${URL_OF_INSTALL}${ADMIN_PATH}`));
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`/sign-in?return=${encodeURIComponent(ADMIN_PATH)}`);
  });

  it("reads the install's state through an operation no agent surface offers", async () => {
    await expect(install.execute("install.get_status", tokenOf(ada.userId), {})).rejects.toMatchObject({ reason: "route-not-found" });
  });
});

// agent-safety: Agent writes are limited per token and budgeted per install. The admin page shows the install's daily
// budget of agent writes, with a form that leads to the review page of the budget it names, where the change takes
// the confirmation step; a member's form changes nothing.
describe("the admin page's budget of agent writes", () => {
  const SET_BUDGET = "settings.set_write_budget";

  function budgetForm(session: WebSessionCaller, dailyWriteBudget: string): Promise<Response> {
    return page(session)(
      new Request(`${URL_OF_INSTALL}${ADMIN_PATH}`, {
        method: "POST",
        headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded", origin: URL_OF_INSTALL, "sec-fetch-site": "same-origin" },
        body: new URLSearchParams({ dailyWriteBudget, csrf: install.fromThePage(session).csrfToken ?? "" }).toString(),
      }),
    );
  }

  it("shows the install's daily budget, 5,000 on a new install, with a form for another", async () => {
    const { html } = await adminPage();
    expect(html).toContain("The install's agents may make 5,000 writes per UTC day, together.");
    expect(html).toContain(`<form method="post" action="${ADMIN_PATH}">`);
    expect(html).toContain('name="dailyWriteBudget"');
  });

  it("leads an admin's form to the review page of the budget it names, and shows the budget once it is confirmed", async () => {
    const answer = await budgetForm(ada, "8000");
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`/confirm/${SET_BUDGET}?input=${encodeURIComponent(JSON.stringify({ dailyWriteBudget: 8_000 }))}`);
    expect((await install.confirm(ada, SET_BUDGET, { dailyWriteBudget: 8_000 })).status).toBe(200);
    expect((await adminPage()).html).toContain("The install's agents may make 8,000 writes per UTC day, together.");
    expect((await install.confirm(ada, SET_BUDGET, { dailyWriteBudget: 5_000 })).status).toBe(200);
  });

  it("gets 403 for a member's form, which changes nothing", async () => {
    const lee = sessionOf(await addUser(install.owner, { login: "lee-budget" }));
    expect((await budgetForm(lee, "1")).status).toBe(403);
    expect((await adminPage()).html).toContain("5,000 writes per UTC day");
  });

  it("reads the budget through an operation no agent surface offers", async () => {
    await expect(install.execute("settings.get_write_budget", tokenOf(ada.userId), {})).rejects.toMatchObject({ reason: "route-not-found" });
  });
});
