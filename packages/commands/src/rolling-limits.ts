// How the sign-in service counts the calls its limits take from one client
// address (agent-access: Tiehall is the authorization server for agent
// clients; sign-in: GitHub is the only way to sign in; design.md, Technical
// decisions: T7). Each limit takes at most its number of calls in any window
// of its length, a minute for the authorization server's endpoints and 10
// seconds for GitHub's return to the sign-in callback, counted over the past
// window, and a refused call is not counted. The sign-in library's own count
// lets that number of calls in a row through, in a run that ends only once a
// whole window passes without one: an address whose clients refresh their
// tokens once every 50 seconds, fewer than 2 calls a minute, would be refused
// at its 21st token call, and on an install on one machine, or behind an
// office's NAT, every client there comes from one address. The counts are
// kept in this process's memory (one web process per install).

/** A limit: at most `max` calls under one key in any `window` seconds. */
export interface RollingLimit {
  window: number;
  max: number;
}

/** A limit's answer to a call: whether it is taken, and when it is not, in how many seconds one would be. */
export interface RollingAnswer {
  allowed: boolean;
  retryAfter: number | null;
}

/** How many keys the counts hold before they forget the keys with no call in their window. */
const KEYS_KEPT = 10_000;

/**
 * Counts the calls under each key over the past window: a call is taken while
 * fewer than the limit's `max` were taken under its key in the past `window`
 * seconds, and counted; a refused call is not, and its answer names when the
 * call that keeps the count at the limit leaves the window, in whole seconds,
 * at least 1.
 */
export function rollingCounts(now: () => Date): (key: string, limit: RollingLimit) => RollingAnswer {
  const byKey = new Map<string, { windowMs: number; times: number[] }>();
  return (key, limit) => {
    const at = now().getTime();
    const windowMs = limit.window * 1000;
    // Keys with no call in their window are forgotten, so the counts keep no more than a window's keys.
    if (byKey.size > KEYS_KEPT) for (const [each, entry] of byKey) if (entry.times.every((time) => at - time >= entry.windowMs)) byKey.delete(each);
    const times = (byKey.get(key)?.times ?? []).filter((time) => at - time < windowMs);
    byKey.set(key, { windowMs, times });
    if (times.length >= limit.max) {
      const leaving = times[times.length - limit.max] ?? at;
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((leaving + windowMs - at) / 1000)) };
    }
    times.push(at);
    return { allowed: true, retryAfter: null };
  };
}

/**
 * The sign-in service's rate-limit storage: each of its limits, on the key the
 * library gives a call, its client address and route, counted over the past
 * window instead of in the library's runs.
 */
export function rollingRateLimits(now: () => Date): { consume(key: string, rule: RollingLimit): Promise<RollingAnswer> } {
  const count = rollingCounts(now);
  return { consume: (key, rule) => Promise.resolve(count(key, rule)) };
}
