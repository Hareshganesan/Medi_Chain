export const STATE = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

export class CircuitOpenError extends Error {
  constructor(name) {
    super(`Circuit "${name}" is OPEN — failing fast`);
    this.code = 'CIRCUIT_OPEN';
  }
}

/**
 * Circuit breaker (Nygard, "Release It!").
 *  CLOSED    → calls pass; consecutive failures are counted.
 *  OPEN      → calls fail immediately until `resetTimeout` elapses.
 *  HALF_OPEN → one trial call; success closes, failure re-opens.
 * The clock is injectable so state transitions are unit-testable without sleeping.
 */
export class CircuitBreaker {
  constructor({ name = 'breaker', failureThreshold = 3, resetTimeout = 5000, now = Date.now } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.now = now;
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.openedAt = 0;
    this.trialInFlight = false;
    this.stats = { success: 0, failure: 0, rejected: 0 };
  }

  canRequest() {
    if (this.state === STATE.OPEN && this.now() - this.openedAt >= this.resetTimeout) {
      this.state = STATE.HALF_OPEN;
      this.trialInFlight = false;
      this.failures = 0; // a single failed trial must re-open, independent of the threshold
    }
    if (this.state === STATE.OPEN) return false;
    if (this.state === STATE.HALF_OPEN) return !this.trialInFlight;
    return true;
  }

  async exec(fn) {
    if (!this.canRequest()) {
      this.stats.rejected++;
      throw new CircuitOpenError(this.name);
    }
    if (this.state === STATE.HALF_OPEN) this.trialInFlight = true;
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this.stats.success++;
    this.failures = 0;
    this.trialInFlight = false;
    this.state = STATE.CLOSED;
  }

  onFailure() {
    this.stats.failure++;
    this.failures++;
    this.trialInFlight = false;
    if (this.state === STATE.HALF_OPEN || this.failures >= this.failureThreshold) {
      this.state = STATE.OPEN;
      this.openedAt = this.now();
    }
  }

  snapshot() {
    this.canRequest(); // refresh OPEN → HALF_OPEN if the timeout has passed
    return { name: this.name, state: this.state, failures: this.failures, ...this.stats };
  }
}
