const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function safePragma(db, sql) {
  try {
    db.exec(sql);
  } catch {
    // Ignore pragma failures on non-WAL filesystems
  }
}

class NoteStore {
  constructor(databaseFile) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    this.db = new DatabaseSync(databaseFile);
    safePragma(this.db, 'PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_notes (
        path TEXT PRIMARY KEY,
        user_id INTEGER,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        source_role TEXT NOT NULL DEFAULT 'pc',
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vault_notes_hash ON vault_notes(content_hash);
      CREATE INDEX IF NOT EXISTS idx_vault_notes_mtime ON vault_notes(mtime);
      CREATE INDEX IF NOT EXISTS idx_vault_notes_deleted ON vault_notes(is_deleted);
      CREATE INDEX IF NOT EXISTS idx_vault_notes_user_id ON vault_notes(user_id);
    `);
  }

  static hashContent(content) {
    const normalized = (content || '').replace(/\r\n/g, '\n');
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  }

  _queryServerNotes(userId = null) {
    if (userId === null || userId === undefined) {
      return this.db.prepare(`
        SELECT path, content_hash, size, mtime, source_role, is_deleted, updated_at
        FROM vault_notes
        WHERE user_id IS NULL
      `).all();
    }
    return this.db.prepare(`
      SELECT path, content_hash, size, mtime, source_role, is_deleted, updated_at
      FROM vault_notes
      WHERE user_id = ?
    `).all(userId);
  }

  computeDelta({ deviceRole = 'pc', files = [], userId = null } = {}) {
    const serverRows = this._queryServerNotes(userId);
    const serverMap = new Map();
    for (const row of serverRows) {
      serverMap.set(row.path, row);
    }

    const clientMap = new Map();
    for (const f of files) {
      if (f && typeof f.path === 'string') {
        clientMap.set(f.path, f);
      }
    }

    const toUpload = [];
    const toDownload = [];
    const toDelete = [];
    const conflicts = [];

    const isPc = deviceRole === 'pc';

    if (isPc) {
      // --- PC is Master Truth ---
      // 1. Check all client files against server
      for (const [p, clientFile] of clientMap.entries()) {
        const s = serverMap.get(p);
        if (!s) {
          // File is new on PC -> upload to server
          toUpload.push(p);
        } else if (s.content_hash !== clientFile.hash || s.is_deleted === 1) {
          // PC file has changed or was restored -> update server
          toUpload.push(p);
        }
      }

      // 2. Check server files against PC
      const pathsToTombstone = [];
      for (const [p, s] of serverMap.entries()) {
        if (!clientMap.has(p) && s.is_deleted === 0) {
          if (s.source_role === 'mobile') {
            // New note captured on mobile that PC doesn't have yet -> PC downloads it!
            toDownload.push(p);
          } else {
            // Existed on PC before, but now gone from PC -> PC deleted it.
            pathsToTombstone.push(p);
          }
        }
      }

      if (pathsToTombstone.length > 0) {
        this.markDeleted(pathsToTombstone, userId);
      }
    } else {
      // --- Mobile is Consumer & Fast Capture ---
      // 1. Check mobile files against server
      for (const [p, clientFile] of clientMap.entries()) {
        const s = serverMap.get(p);
        if (!s) {
          // Brand new note created on mobile -> push to server
          toUpload.push(p);
        } else if (s.is_deleted === 1) {
          // PC deleted this note -> mobile should delete it too
          toDelete.push(p);
        } else if (s.content_hash !== clientFile.hash) {
          // Divergence: Server/PC has different content
          toDownload.push(p);
          // Mark conflict so mobile forks a backup copy before overwriting
          conflicts.push(p);
        }
      }

      // 2. Check server files missing from mobile
      for (const [p, s] of serverMap.entries()) {
        if (!clientMap.has(p) && s.is_deleted === 0) {
          toDownload.push(p);
        }
      }
    }

    return {
      serverTime: new Date().toISOString(),
      deviceRole,
      toUpload,
      toDownload,
      toDelete,
      conflicts,
    };
  }

  upsertNotes({ notes = [], deviceRole = 'pc', userId = null } = {}) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO vault_notes (
        path, user_id, content, content_hash, size, mtime, source_role, is_deleted, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        content = excluded.content,
        content_hash = excluded.content_hash,
        size = excluded.size,
        mtime = excluded.mtime,
        source_role = excluded.source_role,
        is_deleted = 0,
        updated_at = excluded.updated_at
    `);

    let saved = 0;
    for (const note of notes) {
      if (!note || !note.path || typeof note.content !== 'string') continue;
      const content = note.content;
      const hash = note.hash || NoteStore.hashContent(content);
      const size = Number(note.size ?? Buffer.byteLength(content, 'utf8'));
      const mtime = Number(note.mtime ?? Date.now());

      stmt.run(
        String(note.path),
        userId,
        content,
        hash,
        size,
        mtime,
        deviceRole,
        now,
        now
      );
      saved++;
    }

    return { saved, updatedAt: now };
  }

  getNotesByPaths({ paths = [], userId = null } = {}) {
    if (!paths || paths.length === 0) return [];

    const results = [];
    const stmt = userId === null || userId === undefined
      ? this.db.prepare('SELECT path, content, content_hash, size, mtime, source_role, is_deleted, updated_at FROM vault_notes WHERE path = ? AND user_id IS NULL')
      : this.db.prepare('SELECT path, content, content_hash, size, mtime, source_role, is_deleted, updated_at FROM vault_notes WHERE path = ? AND user_id = ?');

    for (const p of paths) {
      const row = userId === null || userId === undefined ? stmt.get(p) : stmt.get(p, userId);
      if (row && row.is_deleted === 0) {
        results.push({
          path: row.path,
          content: row.content,
          hash: row.content_hash,
          size: row.size,
          mtime: row.mtime,
          sourceRole: row.source_role,
          updatedAt: row.updated_at,
        });
      }
    }

    return results;
  }

  markDeleted(paths = [], userId = null) {
    if (!paths || paths.length === 0) return 0;
    const now = new Date().toISOString();
    const stmt = userId === null || userId === undefined
      ? this.db.prepare('UPDATE vault_notes SET is_deleted = 1, updated_at = ? WHERE path = ? AND user_id IS NULL')
      : this.db.prepare('UPDATE vault_notes SET is_deleted = 1, updated_at = ? WHERE path = ? AND user_id = ?');

    let deletedCount = 0;
    for (const p of paths) {
      const info = userId === null || userId === undefined ? stmt.run(now, p) : stmt.run(now, p, userId);
      if (info.changes > 0) deletedCount += info.changes;
    }
    return deletedCount;
  }

  listNotes({ limit = 100, offset = 0, userId = null } = {}) {
    const stmt = userId === null || userId === undefined
      ? this.db.prepare(`
          SELECT path, content_hash, size, mtime, source_role, updated_at
          FROM vault_notes
          WHERE user_id IS NULL AND is_deleted = 0
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?
        `)
      : this.db.prepare(`
          SELECT path, content_hash, size, mtime, source_role, updated_at
          FROM vault_notes
          WHERE user_id = ? AND is_deleted = 0
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?
        `);

    return stmt.all(limit, offset);
  }

  getStats(userId = null) {
    const stmt = userId === null || userId === undefined
      ? this.db.prepare(`
          SELECT
            COUNT(CASE WHEN is_deleted = 0 THEN 1 END) as activeNotes,
            COUNT(CASE WHEN is_deleted = 1 THEN 1 END) as deletedNotes,
            COALESCE(SUM(CASE WHEN is_deleted = 0 THEN size ELSE 0 END), 0) as totalSizeBytes,
            MAX(updated_at) as lastUpdatedAt
          FROM vault_notes
          WHERE user_id IS NULL
        `)
      : this.db.prepare(`
          SELECT
            COUNT(CASE WHEN is_deleted = 0 THEN 1 END) as activeNotes,
            COUNT(CASE WHEN is_deleted = 1 THEN 1 END) as deletedNotes,
            COALESCE(SUM(CASE WHEN is_deleted = 0 THEN size ELSE 0 END), 0) as totalSizeBytes,
            MAX(updated_at) as lastUpdatedAt
          FROM vault_notes
          WHERE user_id = ?
        `);

    return stmt.get();
  }
}

module.exports = { NoteStore };
