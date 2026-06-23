'use strict';

/**
 * Debug log ring buffer with file dump.
 *
 * In-memory: holds up to RING_SIZE (default 250) entries.
 * When the ring fills, entries are flushed to a file.
 * File: keeps up to FILE_MAX_ENTRIES (default 500) entries total.
 * When the file reaches FILE_MAX_ENTRIES, it is replaced (oldest trimmed)
 * so we never run out of memory or disk.
 *
 * Each entry: { timestamp, provider, key_label, model, status, latency_ms, error, request_summary, response_summary }
 *
 * Request/response are summarized (truncated) to keep memory bounded.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_RING_SIZE = 250;
const DEFAULT_FILE_MAX_ENTRIES = 500;
const DEFAULT_SUMMARY_MAX_LENGTH = 500;
const DEFAULT_RESPONSE_SUMMARY_MAX_LENGTH = 1000;

function truncate(value, maxLen) {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `…(${str.length} chars)`;
}

function summarizeRequest(body) {
  if (!body) return null;

  const model = body.model || null;
  const messages = Array.isArray(body.messages) ? body.messages.length : 0;
  const stream = Boolean(body.stream);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // Include a short preview of the last user message
  let lastUserPreview = null;
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      if (body.messages[i] && body.messages[i].role === 'user') {
        lastUserPreview = truncate(body.messages[i].content, 200);
        break;
      }
    }
  }

  return {
    model,
    messages_count: messages,
    stream,
    has_tools: hasTools,
    temperature: body.temperature ?? undefined,
    max_tokens: body.max_tokens ?? undefined,
    last_user_preview: lastUserPreview,
  };
}

function summarizeResponse(data, status) {
  if (!data) return { status, preview: null };

  // For error responses
  if (status >= 400) {
    return {
      status,
      error: data?.error?.message || data?.message || truncate(data, DEFAULT_RESPONSE_SUMMARY_MAX_LENGTH),
    };
  }

  // For chat completions
  const choice = data?.choices?.[0];
  if (choice) {
    return {
      status,
      finish_reason: choice.finish_reason || null,
      content_preview: truncate(choice.message?.content, 300),
      tool_calls: Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls.length : 0,
      usage: data.usage || null,
    };
  }

  // Fallback
  return {
    status,
    preview: truncate(data, 300),
  };
}

class DebugLogger {
  /**
   * @param {object} opts
   * @param {string} [opts.filePath] - Path to dump file. If null, no file dumping.
   * @param {number} [opts.ringSize] - Max entries in memory (default 250)
   * @param {number} [opts.fileMaxEntries] - Max entries in dump file (default 500)
   * @param {boolean} [opts.enabled] - Master switch (default true)
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.ringSize = Number(opts.ringSize) || DEFAULT_RING_SIZE;
    this.fileMaxEntries = Number(opts.fileMaxEntries) || DEFAULT_FILE_MAX_ENTRIES;
    this.filePath = opts.filePath || null;
    this.ring = [];
    this.totalLogged = 0;
  }

  /**
   * Log a request/response cycle.
   * @param {object} entry
   * @param {string} entry.provider - 'nim', 'openrouter', etc.
   * @param {string} entry.keyLabel - Masked key label from KeyPool
   * @param {object} entry.request - The upstream request body
   * @param {object} entry.response - The upstream response data
   * @param {number} entry.status - HTTP status code
   * @param {number} entry.latencyMs - Latency in milliseconds
   * @param {string} [entry.error] - Error message if any
   * @param {string} [entry.model] - Public model ID
   */
  log(entry) {
    if (!this.enabled) return;

    const record = {
      timestamp: new Date().toISOString(),
      provider: entry.provider || 'unknown',
      key_label: entry.keyLabel || 'unknown',
      model: entry.model || null,
      status: entry.status || 0,
      latency_ms: entry.latencyMs || 0,
      error: entry.error || null,
      request: summarizeRequest(entry.request),
      response: summarizeResponse(entry.response, entry.status || 0),
    };

    this.ring.push(record);
    this.totalLogged++;

    // When ring is full, dump to file
    if (this.ring.length >= this.ringSize) {
      this._dumpToFile();
    }
  }

  /**
   * Dump the current ring to the file, then clear the ring.
   * The file keeps at most fileMaxEntries — oldest are trimmed.
   */
  _dumpToFile() {
    if (!this.filePath || this.ring.length === 0) {
      this.ring = [];
      return;
    }

    try {
      let existing = [];
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          existing = parsed;
        } else if (parsed && Array.isArray(parsed.entries)) {
          existing = parsed.entries;
        }
      }

      // Combine, trim to fileMaxEntries (keep newest)
      const combined = [...existing, ...this.ring];
      const trimmed = combined.slice(-this.fileMaxEntries);

      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({
        updated_at: new Date().toISOString(),
        total_logged: this.totalLogged,
        count: trimmed.length,
        entries: trimmed,
      }, null, 2) + '\n');
    } catch (err) {
      // File dump failure should never crash the proxy
      console.error('[debug-log] Failed to dump to file:', err.message);
    }

    this.ring = [];
  }

  /**
   * Get the last N entries from memory + file (file first, then memory on top).
   * @param {number} [count] - Number of entries to return (default 50)
   * @returns {object[]}
   */
  getRecent(count = 50) {
    let fileEntries = [];

    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        fileEntries = Array.isArray(parsed) ? parsed : (parsed?.entries || []);
      } catch {
        fileEntries = [];
      }
    }

    // Combine: file entries (older) + ring entries (newer)
    const combined = [...fileEntries, ...this.ring];
    return combined.slice(-count).reverse(); // newest first
  }

  /**
   * Get a status snapshot.
   * @returns {object}
   */
  getStatus() {
    return {
      enabled: this.enabled,
      ring_size: this.ring.length,
      ring_capacity: this.ringSize,
      total_logged: this.totalLogged,
      file_path: this.filePath,
      file_max_entries: this.fileMaxEntries,
    };
  }

  /**
   * Force a dump (e.g. on shutdown).
   */
  flush() {
    if (this.ring.length > 0) {
      this._dumpToFile();
    }
  }
}

module.exports = { DebugLogger };
