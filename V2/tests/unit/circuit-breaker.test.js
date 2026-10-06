import { describe, it, expect } from 'vitest';
import { CircuitBreaker, STATE } from '../../src/common/circuit-breaker.js';

/** State-transition testing: CLOSED → OPEN → HALF_OPEN → CLOSED | OPEN. Clock is injected. */
const setup = (opts = {}) => {
  const clock = { t: 0 };
  const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 1000, now: () => clock.t, ...opts });
  return { cb, clock };
};
const ok = () => Promise.resolve('ok');
const boom = () => Promise.reject(new Error('boom'));

describe('Circuit breaker — state transitions', () => {
  it('TC-CB-01: starts CLOSED and passes calls through', async () => {
    const { cb } = setup();
    await expect(cb.exec(ok)).resolves.toBe('ok');
    expect(cb.state).toBe(STATE.CLOSED);
  });

  it('TC-CB-02 (BVA): stays CLOSED at threshold-1 failures, opens at exactly the threshold', async () => {
    const { cb } = setup();
    await cb.exec(boom).catch(() => {});
    await cb.exec(boom).catch(() => {});
    expect(cb.state).toBe(STATE.CLOSED); // 2 = threshold - 1
    await cb.exec(boom).catch(() => {});
    expect(cb.state).toBe(STATE.OPEN); // 3 = threshold
  });

  it('TC-CB-03: a success resets the consecutive-failure counter', async () => {
    const { cb } = setup();
    await cb.exec(boom).catch(() => {});
    await cb.exec(boom).catch(() => {});
    await cb.exec(ok);
    await cb.exec(boom).catch(() => {});
    expect(cb.state).toBe(STATE.CLOSED);
    expect(cb.failures).toBe(1);
  });

  it('TC-CB-04: OPEN fails fast without invoking the function', async () => {
    const { cb } = setup({ failureThreshold: 1 });
    await cb.exec(boom).catch(() => {});
    let called = false;
    await expect(cb.exec(async () => (called = true))).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    expect(called).toBe(false);
    expect(cb.stats.rejected).toBe(1);
  });

  it('TC-CB-05 (BVA): becomes HALF_OPEN exactly when resetTimeout has elapsed', async () => {
    const { cb, clock } = setup({ failureThreshold: 1 });
    await cb.exec(boom).catch(() => {});
    clock.t = 999;
    expect(cb.canRequest()).toBe(false);
    clock.t = 1000;
    expect(cb.canRequest()).toBe(true);
    expect(cb.state).toBe(STATE.HALF_OPEN);
  });

  it('TC-CB-06: HALF_OPEN → CLOSED on a successful trial call', async () => {
    const { cb, clock } = setup({ failureThreshold: 1 });
    await cb.exec(boom).catch(() => {});
    clock.t = 1000;
    await cb.exec(ok);
    expect(cb.state).toBe(STATE.CLOSED);
  });

  it('TC-CB-07: HALF_OPEN → OPEN again on a failed trial call', async () => {
    const { cb, clock } = setup({ failureThreshold: 5 });
    for (let i = 0; i < 5; i++) await cb.exec(boom).catch(() => {});
    clock.t = 1000;
    await cb.exec(boom).catch(() => {});
    expect(cb.state).toBe(STATE.OPEN);
    expect(cb.openedAt).toBe(1000);
  });

  it('TC-CB-08: HALF_OPEN admits only ONE concurrent trial call', async () => {
    const { cb, clock } = setup({ failureThreshold: 1 });
    await cb.exec(boom).catch(() => {});
    clock.t = 1000;
    let release;
    const trial = cb.exec(() => new Promise((r) => (release = r)));
    await expect(cb.exec(ok)).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
    release('done');
    await trial;
    expect(cb.state).toBe(STATE.CLOSED);
  });

  it('TC-CB-09: snapshot reports state and counters', async () => {
    const { cb } = setup();
    await cb.exec(ok);
    await cb.exec(boom).catch(() => {});
    expect(cb.snapshot()).toMatchObject({ state: 'CLOSED', success: 1, failure: 1, rejected: 0 });
  });
});
