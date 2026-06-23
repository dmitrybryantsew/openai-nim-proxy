'use strict';

/**
 * Key pool with round-robin selection and exponential cooldown.
 *
 * Each key tracks:
 *  - consecutiveFailures: how many times in a row it returned 429/403
 *  - cooldownUntil: epoch ms when the key becomes eligible again
 *  - lastUsed: epoch ms of last successful (or attempted) use
 *
 * Cooldown grows exponentially: base * 2^(failures-1), capped at MAX_COOLDOWN_MS.
 * If the upstream returns Retry-After, that value is used instead (clamped to MAX).
 * After MAX_COOLDOWN_MS (default 24h) the key is automatically retested.
 */

const DEFAULT_BASE_COOLDOWN_MS = 10_000; // 10 seconds
const DEFAULT_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

function maskKey(key) {
  if (!key || typeof key !== 'string') return '(none)';
  if (key.length <= 12) return key.slice(0, 3) + '***';
  return key.slice(0, 6) + '***' + key.slice(-4);
}

class KeyEntry {
  constructor(key, label) {
    this.key = key;
    this.label = label || maskKey(key);
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
    this.lastUsed = 0;
    this.lastError = null;
    this.totalRequests = 0;
    this.totalFailures = 0;
  }

  get isCooling() {
    return Date.now() < this.cooldownUntil;
  }

  get cooldownRemainingMs() {
    return Math.max(0, this.cooldownUntil - Date.now());
  }
}

class KeyPool {
  /**
   * @param {object} opts
   * @param {string[]} opts.keys - Array of API keys (non-empty)
   * @param {string} opts.provider - Provider name for logging ('nim', 'openrouter', etc.)
   * @param {number} [opts.baseCooldownMs] - Initial cooldown after first failure
   * @param {number} [opts.maxCooldownMs] - Hard cap on cooldown duration
   */
  constructor(opts) {
    if (!opts || !Array.isArray(opts.keys) || opts.keys.length === 0) {
      throw new Error(`KeyPool: at least one key is required (provider=${opts?.provider || '?'})`);
    }

    this.provider = opts.provider || 'unknown';
    this.baseCooldownMs = Number(opts.baseCooldownMs) || DEFAULT_BASE_COOLDOWN_MS;
    this.maxCooldownMs = Number(opts.maxCooldownMs) || DEFAULT_MAX_COOLDOWN_MS;
    this.entries = opts.keys.map((k, i) => new KeyEntry(k, `${this.provider}-key${opts.keys.length > 1 ? '-' + (i + 1) : ''}`));
    this.rrIndex = 0;
  }

  /**
   * Pick the next available key using round-robin, skipping cooled-down keys.
   * If all keys are cooling, returns null.
   * @returns {KeyEntry|null}
   */
  pick() {
    const now = Date.now();
    const n = this.entries.length;

    // Try round-robin starting from the current index
    for (let i = 0; i < n; i++) {
      const idx = (this.rrIndex + i) % n;
      const entry = this.entries[idx];

      // Auto-retest: if cooldown has expired, allow the key
      if (entry.isCooling) {
        continue;
      }

      this.rrIndex = (idx + 1) % n;
      entry.lastUsed = now;
      entry.totalRequests++;
      return entry;
    }

    // All keys cooling — check if any cooldown has expired via MAX_COOLDOWN_MS retest
    // (isCooling already returns false when cooldownUntil <= now, so if we're here,
    // all keys are genuinely cooling)
    return null;
  }

  /**
   * Mark a key as failed (429/403/etc). Applies exponential cooldown.
   * @param {KeyEntry} entry
   * @param {number} [retryAfterSeconds] - Value from Retry-After header, if present
   * @param {string} [errorMessage]
   */
  markFailed(entry, retryAfterSeconds, errorMessage) {
    entry.consecutiveFailures++;
    entry.totalFailures++;

    let cooldownMs;
    if (retryAfterSeconds && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      // Respect upstream Retry-After, but still cap it
      cooldownMs = Math.min(retryAfterSeconds * 1000, this.maxCooldownMs);
    } else {
      // Exponential backoff: base * 2^(failures-1), capped
      cooldownMs = Math.min(this.baseCooldownMs * Math.pow(2, entry.consecutiveFailures - 1), this.maxCooldownMs);
    }

    entry.cooldownUntil = Date.now() + cooldownMs;
    entry.lastError = errorMessage || null;
  }

  /**
   * Mark a key as successful — reset failure counter.
   * @param {KeyEntry} entry
   */
  markSuccess(entry) {
    entry.consecutiveFailures = 0;
    entry.cooldownUntil = 0;
    entry.lastError = null;
  }

  /**
   * Get the next key that is currently cooling but will be available soonest,
   * even if it's still in cooldown. Used when all keys are exhausted and we
   * want to report which one to wait for.
   * @returns {KeyEntry|null}
   */
  pickSoonestAvailable() {
    let soonest = null;
    for (const entry of this.entries) {
      if (!entry.isCooling) {
        return entry;
      }
      if (!soonest || entry.cooldownUntil < soonest.cooldownUntil) {
        soonest = entry;
      }
    }
    return soonest;
  }

  /**
   * Check if all keys are currently in cooldown.
   * @returns {boolean}
   */
  get allExhausted() {
    return this.entries.every((e) => e.isCooling);
  }

  /**
   * Get a status snapshot for the debug page.
   * @returns {object}
   */
  getStatus() {
    return {
      provider: this.provider,
      total_keys: this.entries.length,
      available: this.entries.filter((e) => !e.isCooling).length,
      cooling: this.entries.filter((e) => e.isCooling).length,
      keys: this.entries.map((e) => ({
        label: e.label,
        masked: maskKey(e.key),
        available: !e.isCooling,
        cooldown_remaining_ms: e.cooldownRemainingMs,
        consecutive_failures: e.consecutiveFailures,
        total_requests: e.totalRequests,
        total_failures: e.totalFailures,
        last_used: e.lastUsed ? new Date(e.lastUsed).toISOString() : null,
        last_error: e.lastError,
      })),
    };
  }
}

/**
 * Parse comma-separated keys from an env value, filtering empties.
 * @param {string} envValue
 * @returns {string[]}
 */
function parseKeys(envValue) {
  if (!envValue || typeof envValue !== 'string') return [];
  return envValue
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

module.exports = { KeyPool, parseKeys, maskKey };
