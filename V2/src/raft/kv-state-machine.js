/**
 * The replicated state machine: a versioned key-value store.
 *
 * apply() must be DETERMINISTIC — every replica applies the same log in the same
 * order and must end in the same state. So timestamps come from the command
 * (stamped once by the leader), never from Date.now() here.
 *
 * Commands carrying a requestId are applied at most once: a client that retries
 * after a leader crash gets the original result back instead of a duplicate write.
 */
export class KVStateMachine {
  constructor({ dedupWindow = 10000 } = {}) {
    this.data = new Map();
    this.applied = new Map(); // requestId → result
    this.dedupWindow = dedupWindow;
    this.appliedCount = 0;
  }

  apply(cmd, index) {
    if (cmd.requestId && this.applied.has(cmd.requestId)) {
      return { ...this.applied.get(cmd.requestId), duplicate: true };
    }
    const result = this.execute(cmd, index);
    this.appliedCount++;
    if (cmd.requestId) {
      this.applied.set(cmd.requestId, result);
      if (this.applied.size > this.dedupWindow) this.applied.delete(this.applied.keys().next().value);
    }
    return result;
  }

  execute(cmd, index) {
    const prev = this.data.get(cmd.key);
    const write = (value) => {
      const entry = { value, version: (prev?.version ?? 0) + 1, updatedAt: cmd.ts ?? null, index };
      this.data.set(cmd.key, entry);
      return { ok: true, key: cmd.key, version: entry.version };
    };

    switch (cmd.type) {
      case 'noop':
        return { ok: true };
      case 'put':
        // Optimistic concurrency: reject if the caller's view is stale.
        if (cmd.expectedVersion !== undefined && (prev?.version ?? 0) !== cmd.expectedVersion) {
          return { ok: false, error: 'VERSION_CONFLICT', key: cmd.key, currentVersion: prev?.version ?? 0 };
        }
        return write(cmd.value);
      case 'append': {
        const list = Array.isArray(prev?.value) ? prev.value : [];
        return { ...write([...list, cmd.value]), itemId: cmd.value?.id ?? null, length: list.length + 1 };
      }
      case 'mapSet': {
        const obj = prev?.value && typeof prev.value === 'object' ? prev.value : {};
        return write({ ...obj, [cmd.field]: cmd.value });
      }
      case 'mapDelete': {
        const obj = { ...(prev?.value ?? {}) };
        delete obj[cmd.field];
        return write(obj);
      }
      case 'delete':
        this.data.delete(cmd.key);
        return { ok: true, key: cmd.key, deleted: Boolean(prev) };
      default:
        throw new Error(`Unknown command type: ${cmd.type}`);
    }
  }

  get(key) {
    const e = this.data.get(key);
    return e ? { key, ...e } : null;
  }

  scan(prefix = '') {
    const out = [];
    for (const [key, e] of this.data) if (key.startsWith(prefix)) out.push({ key, ...e });
    return out;
  }

  size() {
    return this.data.size;
  }
}
