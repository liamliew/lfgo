// PinGuard: one Durable Object per PIN lock (named by the lock's salt). It
// counts wrong guesses with strong consistency, which KV cannot do, so a
// 6-digit PIN cannot simply be brute-forced over the web.
//
// Policy (see the README):
//   - one IP address: 5 wrong guesses, then blocked until 15 minutes after its first miss
//   - everyone together: 30 wrong guesses, then the link is locked for all until
//     60 minutes after the first miss in that window
//
// Written as a plain class (constructor + fetch) so it needs no runtime imports
// and can be unit-tested in Node.

export const PER_IP_MAX = 5;
export const PER_IP_WINDOW_MS = 15 * 60 * 1000;
export const GLOBAL_MAX = 30;
export const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
export const MAX_TRACKED_IPS = 500;

interface Counter {
  n: number;
  start: number;
}
interface State {
  ips: Record<string, Counter>;
  g: Counter;
}

export interface GuardStatus {
  allowed: boolean;
  /** Guesses left before this visitor is blocked (0 when blocked). */
  remaining: number;
  /** Seconds until a blocked visitor may try again. */
  retryAfter: number;
}

function prune(st: State, now: number): State {
  for (const [ip, c] of Object.entries(st.ips)) {
    if (now - c.start >= PER_IP_WINDOW_MS) delete st.ips[ip];
  }
  const ips = Object.entries(st.ips);
  if (ips.length > MAX_TRACKED_IPS) {
    ips.sort((a, b) => a[1].start - b[1].start);
    for (const [ip] of ips.slice(0, ips.length - MAX_TRACKED_IPS)) delete st.ips[ip];
  }
  if (now - st.g.start >= GLOBAL_WINDOW_MS) st.g = { n: 0, start: now };
  return st;
}

export function statusFor(st: State, ip: string, now: number): GuardStatus {
  const c = st.ips[ip];
  const ipBlocked = !!c && c.n >= PER_IP_MAX;
  const globalBlocked = st.g.n >= GLOBAL_MAX;
  const waits: number[] = [];
  if (ipBlocked) waits.push(c.start + PER_IP_WINDOW_MS - now);
  if (globalBlocked) waits.push(st.g.start + GLOBAL_WINDOW_MS - now);
  const blocked = ipBlocked || globalBlocked;
  return {
    allowed: !blocked,
    remaining: blocked ? 0 : Math.max(0, Math.min(PER_IP_MAX - (c?.n ?? 0), GLOBAL_MAX - st.g.n)),
    retryAfter: blocked ? Math.max(1, Math.ceil(Math.max(...waits) / 1000)) : 0,
  };
}

export class PinGuard {
  constructor(private readonly state: DurableObjectState, _env?: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ip = (url.searchParams.get("ip") || "unknown").slice(0, 64);
    const now = Date.now();
    const st = prune((await this.state.storage.get<State>("s")) ?? { ips: {}, g: { n: 0, start: now } }, now);

    if (url.pathname === "/fail" && request.method === "POST") {
      const c = st.ips[ip] ?? { n: 0, start: now };
      c.n += 1;
      st.ips[ip] = c;
      if (st.g.n === 0) st.g.start = now;
      st.g.n += 1;
      await this.state.storage.put("s", st);
    } else if (url.pathname === "/ok" && request.method === "POST") {
      delete st.ips[ip];
      await this.state.storage.put("s", st);
    } else if (url.pathname !== "/check") {
      return new Response("Not found", { status: 404 });
    }
    return Response.json(statusFor(st, ip, now));
  }
}
