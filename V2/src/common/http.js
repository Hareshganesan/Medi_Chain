/** Small fetch wrapper: JSON in/out, hard timeout, never throws on HTTP status. */
export async function httpJson(url, { method = 'GET', body, headers = {}, timeoutMs = 3000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Exponential backoff with "full jitter" (AWS Architecture Blog):
 *   delay = random(0, min(maxDelay, base * factor^attempt))
 * Jitter stops many clients retrying in lock-step after an outage.
 */
export function backoffDelay(attempt, { baseDelayMs = 100, maxDelayMs = 2000, factor = 2, jitter = true, random = Math.random } = {}) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * factor ** attempt);
  return jitter ? Math.floor(random() * ceiling) : ceiling;
}

/** Retry `fn` up to `retries` extra times while `shouldRetry(err)` says so. */
export async function retry(fn, { retries = 3, shouldRetry = () => true, onRetry, sleepFn = sleep, ...backoff } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      const delay = backoffDelay(attempt, backoff);
      onRetry?.(err, attempt + 1, delay);
      await sleepFn(delay);
    }
  }
}
