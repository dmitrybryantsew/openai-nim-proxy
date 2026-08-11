const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class ChatStore {
  constructor(databaseFile) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    this.db = new DatabaseSync(databaseFile);
    safePragma(this.db, 'PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        provider_model_id TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_id_id ON messages(chat_id, id);
      CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at);

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_id TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL
      );
    `);
    ensureColumn(this.db, 'messages', 'provider', 'TEXT');
    ensureColumn(this.db, 'messages', 'provider_model_id', 'TEXT');
  }

  getUserByGoogleId(googleId) {
    return this.db
      .prepare('SELECT id, google_id, email, role, created_at FROM users WHERE google_id = ?')
      .get(googleId);
  }

  createUser({ googleId, email, role = 'user' }) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('INSERT INTO users (google_id, email, role, created_at) VALUES (?, ?, ?, ?)')
      .run(googleId, email, role, now);

    return {
      id: Number(result.lastInsertRowid),
      google_id: googleId,
      email,
      role,
      created_at: now
    };
  }

  listChats({ limit = 100 } = {}) {
    return this.db
      .prepare(`
        SELECT
          chats.id,
          chats.title,
          chats.model,
          chats.created_at,
          chats.updated_at,
          (
            SELECT COUNT(*)
            FROM messages
            WHERE messages.chat_id = chats.id
          ) AS message_count,
          (
            SELECT content
            FROM messages
            WHERE messages.chat_id = chats.id
            ORDER BY id DESC
            LIMIT 1
          ) AS last_message
        FROM chats
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `)
      .all(limit)
      .map(normalizeChat);
  }

  createChat({ title, model }) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('INSERT INTO chats (title, model, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(title || 'New chat', model || null, now, now);

    return this.getChat(Number(result.lastInsertRowid));
  }

  getChat(chatId) {
    const chat = this.db
      .prepare('SELECT id, title, model, created_at, updated_at FROM chats WHERE id = ?')
      .get(chatId);

    if (!chat) {
      return null;
    }

    return {
      ...normalizeChat(chat),
      messages: this.listMessages(chatId),
    };
  }

  updateChat(chatId, updates = {}) {
    const current = this.getChat(chatId);
    if (!current) {
      return null;
    }

    const title = updates.title !== undefined ? updates.title : current.title;
    const model = updates.model !== undefined ? updates.model : current.model;
    const now = new Date().toISOString();

    this.db
      .prepare('UPDATE chats SET title = ?, model = ?, updated_at = ? WHERE id = ?')
      .run(title || 'New chat', model || null, now, chatId);

    return this.getChat(chatId);
  }

  deleteChat(chatId) {
    const result = this.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
    return result.changes > 0;
  }

  listMessages(chatId) {
    return this.db
      .prepare('SELECT id, chat_id, role, content, model, provider, provider_model_id, created_at FROM messages WHERE chat_id = ? ORDER BY id ASC')
      .all(chatId)
      .map(normalizeMessage);
  }

  addMessage({ chatId, role, content, model, provider, providerModelId, raw }) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('INSERT INTO messages (chat_id, role, content, model, provider, provider_model_id, raw_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(chatId, role, content, model || null, provider || null, providerModelId || null, raw ? JSON.stringify(raw) : null, now);

    this.db
      .prepare('UPDATE chats SET updated_at = ?, model = COALESCE(?, model) WHERE id = ?')
      .run(now, model || null, chatId);

    return this.db
      .prepare('SELECT id, chat_id, role, content, model, provider, provider_model_id, created_at FROM messages WHERE id = ?')
      .get(Number(result.lastInsertRowid));
  }
}

function safePragma(db, statement) {
  try {
    db.exec(statement);
  } catch (error) {
    console.warn(`SQLite pragma skipped: ${statement} (${error.message})`);
  }
}

function ensureColumn(db, tableName, columnName, columnType) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
}

function normalizeChat(chat) {
  return {
    ...chat,
    id: Number(chat.id),
    message_count: chat.message_count === undefined ? undefined : Number(chat.message_count),
  };
}

function normalizeMessage(message) {
  return {
    ...message,
    id: Number(message.id),
    chat_id: Number(message.chat_id),
  };
}

module.exports = {
  ChatStore,
};
