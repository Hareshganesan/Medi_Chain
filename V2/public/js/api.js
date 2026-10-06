// Thin client for the API gateway. The JWT lives in sessionStorage (cleared when the tab closes).
const KEY = 'medichain.session';

export const session = {
  get() {
    try {
      return JSON.parse(sessionStorage.getItem(KEY));
    } catch {
      return null;
    }
  },
  set(value) {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  },
  clear() {
    sessionStorage.removeItem(KEY);
  },
};

export const HOME = { admin: '/admin', doctor: '/doctor', patient: '/patient' };

/** Redirect to login unless signed in with one of `roles`. */
export function requireSession(...roles) {
  const s = session.get();
  if (!s?.token || (roles.length && !roles.includes(s.user.role))) {
    // Signed in with the wrong role → back to your own portal; otherwise → sign-in page.
    location.replace(s?.token ? (HOME[s.user.role] ?? '/') : '/');
    throw new Error('redirecting');
  }
  return s;
}

export function logout() {
  session.clear();
  location.replace('/');
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const s = session.get();
  const t0 = performance.now();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(s?.token ? { authorization: `Bearer ${s.token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && s?.token && !path.endsWith('/login')) logout();
  return { ok: res.ok, status: res.status, data, headers: res.headers, ms: Math.round(performance.now() - t0) };
}

/** Server-Sent Events over fetch (so the JWT goes in a header, not the URL). Auto-reconnects. */
export function stream(onEvent, onState = () => {}) {
  let stopped = false;
  let attempt = 0;
  const connect = async () => {
    while (!stopped) {
      try {
        const s = session.get();
        const res = await fetch('/api/notifications/stream', { headers: { authorization: `Bearer ${s.token}` } });
        if (!res.ok || !res.body) throw new Error('stream unavailable');
        onState(true);
        attempt = 0;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line && !chunk.startsWith('event: hello')) {
              try {
                onEvent(JSON.parse(line.slice(6)));
              } catch {
                /* ignore malformed */
              }
            }
          }
        }
      } catch {
        /* fall through to reconnect */
      }
      onState(false);
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt++)));
    }
  };
  connect();
  return () => (stopped = true);
}
