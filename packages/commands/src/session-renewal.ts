// The cookie that renews a web session (sign-in: Signing out and ending
// sessions; github-layer-hardening: design.md, Technical decisions: T4). A
// read of the session that may renew it, a route handler's or a server
// action's, collects in a Headers the Set-Cookie values the sign-in service
// gives: the one that renews the browser's cookie when the read extended the
// session, or the one that expires it when the session is gone. A route
// handler carries them on its answer, whatever the answer is, a refusal's
// included; a server action sets them through Next.js's cookies(), which takes
// each cookie by its parts. A server component reads the session without
// renewing it, because it cannot set a cookie.

/** Answers with a route whose session read may renew the session, and carries the cookies it collected on the answer. */
export async function renewingSession(answer: (renewal: Headers) => Promise<Response>): Promise<Response> {
  const renewal = new Headers();
  return withSessionCookies(await answer(renewal), renewal);
}

/** The answer, with the Set-Cookie values a read of the session collected added to its own. */
export function withSessionCookies(answer: Response, renewal: Headers): Response {
  const cookies = renewal.getSetCookie();
  if (cookies.length === 0) return answer;
  const headers = new Headers(answer.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
}

/** A cookie as Next.js's cookies().set() takes it, by its parts. */
export interface SessionCookie {
  name: string;
  /** Its value, decoded: Next.js encodes it again. */
  value: string;
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "strict" | "lax" | "none";
}

/** The cookies a read of the session collected, by their parts, for a server action to set. */
export function sessionCookiesOf(renewal: Headers): SessionCookie[] {
  return renewal.getSetCookie().map(parseSetCookie);
}

function parseSetCookie(line: string): SessionCookie {
  const [pair = "", ...attributes] = line.split(";");
  const at = pair.indexOf("=");
  const name = (at < 0 ? pair : pair.slice(0, at)).trim();
  const raw = at < 0 ? "" : pair.slice(at + 1).trim();
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = raw;
  }
  const cookie: SessionCookie = { name, value };
  for (const attribute of attributes) {
    const equals = attribute.indexOf("=");
    const key = (equals < 0 ? attribute : attribute.slice(0, equals)).trim().toLowerCase();
    const setting = equals < 0 ? "" : attribute.slice(equals + 1).trim();
    if (key === "max-age" && /^-?\d+$/.test(setting)) cookie.maxAge = Number(setting);
    else if (key === "expires" && !Number.isNaN(Date.parse(setting))) cookie.expires = new Date(setting);
    else if (key === "path") cookie.path = setting;
    else if (key === "domain") cookie.domain = setting;
    else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "samesite") {
      const sameSite = setting.toLowerCase();
      if (sameSite === "strict" || sameSite === "lax" || sameSite === "none") cookie.sameSite = sameSite;
    }
  }
  return cookie;
}
