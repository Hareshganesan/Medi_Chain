import { randomUUID } from 'node:crypto';
import { httpJson, sleep, backoffDelay } from './http.js';

/**
 * Producer with an in-memory outbox: publish() never blocks or fails the caller.
 * If the broker is down, events queue up and are flushed with backoff once it
 * returns — the request path is decoupled from the audit/notification path.
 */
export class EventPublisher {
  constructor({ busUrl, token, logger, maxQueue = 10000 }) {
    Object.assign(this, { busUrl, token, logger, maxQueue });
    this.queue = [];
    this.flushing = false;
    this.attempt = 0;
    this.stats = { published: 0, failedAttempts: 0, dropped: 0 };
  }

  publish(topic, value, key = null) {
    const event = { id: randomUUID(), ts: new Date().toISOString(), ...value };
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.stats.dropped++;
    }
    this.queue.push({ topic, key, value: event });
    this.flush();
    return event;
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0];
        try {
          const r = await httpJson(`${this.busUrl}/topics/${item.topic}/messages`, {
            method: 'POST',
            body: { key: item.key, value: item.value },
            headers: { 'x-service-token': this.token },
            timeoutMs: 2000,
          });
          if (r.status !== 201) throw new Error(`bus returned ${r.status}`);
          this.queue.shift();
          this.stats.published++;
          this.attempt = 0;
        } catch (err) {
          this.stats.failedAttempts++;
          if (this.attempt === 0) this.logger?.warn(`event bus unreachable, buffering ${this.queue.length} event(s)`);
          await sleep(backoffDelay(this.attempt++, { baseDelayMs: 200, maxDelayMs: 5000 }));
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Resolves once the outbox is empty (used by tests and graceful shutdown). */
  async drain(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length || this.flushing) && Date.now() < deadline) await sleep(20);
  }
}

/**
 * Consumer-group poll loop. Offsets are committed only AFTER the handler succeeds,
 * so a crash mid-batch replays messages (at-least-once) — handlers must be idempotent.
 */
export function startConsumer({ busUrl, token, topic, group, handler, logger, waitMs = 10000, batch = 100 }) {
  let running = true;
  let attempt = 0;
  let controller;
  const loop = async () => {
    while (running) {
      try {
        controller = new AbortController();
        const url = `${busUrl}/topics/${topic}/messages?group=${encodeURIComponent(group)}&max=${batch}&waitMs=${waitMs}`;
        const res = await fetch(url, { headers: { 'x-service-token': token }, signal: controller.signal });
        if (!res.ok) throw new Error(`poll failed ${res.status}`);
        const { messages, nextOffset } = await res.json();
        for (const m of messages) await handler(m.value, m);
        if (messages.length) {
          await httpJson(`${busUrl}/topics/${topic}/offsets`, {
            method: 'POST',
            body: { group, offset: nextOffset },
            headers: { 'x-service-token': token },
          });
        }
        attempt = 0;
      } catch (err) {
        if (!running) break;
        if (attempt === 0) logger?.warn(`consumer ${group}@${topic}: ${err.message} — retrying`);
        await sleep(backoffDelay(attempt++, { baseDelayMs: 250, maxDelayMs: 5000 }));
      }
    }
  };
  const done = loop();
  return {
    async stop() {
      running = false;
      controller?.abort();
      await done.catch(() => {});
    },
  };
}
