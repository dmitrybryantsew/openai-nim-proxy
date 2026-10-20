const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function safePragma(db, sql) {
  try {
    db.exec(sql);
  } catch {
    // Ignore pragma failures on non-WAL filesystems
  }
}

class CardStore {
  constructor(databaseFile) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    this.db = new DatabaseSync(databaseFile);
    safePragma(this.db, 'PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS study_decks (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        name TEXT NOT NULL,
        description TEXT,
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_rule_json TEXT NOT NULL DEFAULT '{}',
        tags_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS study_cards (
        id TEXT PRIMARY KEY,
        deck_id TEXT REFERENCES study_decks(id) ON DELETE CASCADE,
        question_name TEXT,
        question_text TEXT NOT NULL,
        question_type TEXT NOT NULL DEFAULT 'self_check',
        answer_text TEXT,
        choices_json TEXT,
        answer_check_mode TEXT NOT NULL DEFAULT 'self',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        archived_at TEXT,
        next_repeat_at TEXT NOT NULL,
        last_reviewed_at TEXT,
        algorithm TEXT NOT NULL DEFAULT 'mnemosyne_like_v1',
        interval_days REAL NOT NULL DEFAULT 0,
        ease REAL NOT NULL DEFAULT 2.5,
        repetition_count INTEGER NOT NULL DEFAULT 0,
        lapse_count INTEGER NOT NULL DEFAULT 0,
        last_grade INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_study_cards_deck_id ON study_cards(deck_id);
      CREATE INDEX IF NOT EXISTS idx_study_cards_due ON study_cards(next_repeat_at, enabled);

      CREATE TABLE IF NOT EXISTS card_reviews (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES study_cards(id) ON DELETE CASCADE,
        user_id INTEGER,
        grade INTEGER NOT NULL,
        user_answer TEXT,
        checker_result_json TEXT,
        reviewed_at TEXT NOT NULL,
        elapsed_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_card_reviews_card_id ON card_reviews(card_id);
      CREATE INDEX IF NOT EXISTS idx_card_reviews_reviewed_at ON card_reviews(reviewed_at);
    `);
  }

  sync({ since = null, decks = [], cards = [], reviews = [], userId = null } = {}) {
    const now = new Date().toISOString();

    // 1. Upsert incoming decks
    const insertDeckStmt = this.db.prepare(`
      INSERT INTO study_decks (
        id, user_id, name, description, source_type, source_rule_json, tags_json, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        source_type = excluded.source_type,
        source_rule_json = excluded.source_rule_json,
        tags_json = excluded.tags_json,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= study_decks.updated_at
    `);

    for (const d of decks) {
      if (!d.id || !d.name) continue;
      insertDeckStmt.run(
        String(d.id),
        userId,
        String(d.name),
        d.description ?? null,
        d.sourceType ?? 'manual',
        typeof d.sourceRule === 'string' ? d.sourceRule : JSON.stringify(d.sourceRule ?? {}),
        typeof d.tags === 'string' ? d.tags : JSON.stringify(d.tags ?? []),
        d.enabled === false ? 0 : 1,
        d.createdAt ?? now,
        d.updatedAt ?? now
      );
    }

    // 2. Upsert incoming cards
    const insertCardStmt = this.db.prepare(`
      INSERT INTO study_cards (
        id, deck_id, question_name, question_text, question_type, answer_text,
        choices_json, answer_check_mode, metadata_json, enabled, archived_at,
        next_repeat_at, last_reviewed_at, algorithm, interval_days, ease,
        repetition_count, lapse_count, last_grade, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        deck_id = excluded.deck_id,
        question_name = excluded.question_name,
        question_text = excluded.question_text,
        question_type = excluded.question_type,
        answer_text = excluded.answer_text,
        choices_json = excluded.choices_json,
        answer_check_mode = excluded.answer_check_mode,
        metadata_json = excluded.metadata_json,
        enabled = excluded.enabled,
        archived_at = excluded.archived_at,
        next_repeat_at = excluded.next_repeat_at,
        last_reviewed_at = excluded.last_reviewed_at,
        algorithm = excluded.algorithm,
        interval_days = excluded.interval_days,
        ease = excluded.ease,
        repetition_count = excluded.repetition_count,
        lapse_count = excluded.lapse_count,
        last_grade = excluded.last_grade,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= study_cards.updated_at
    `);

    for (const c of cards) {
      if (!c.id || !c.questionText) continue;
      insertCardStmt.run(
        String(c.id),
        c.deckId ?? c.studySetId ?? null,
        c.questionName ?? null,
        String(c.questionText),
        c.questionType ?? 'self_check',
        c.answerText ?? null,
        typeof c.choices === 'string' ? c.choices : (c.choices ? JSON.stringify(c.choices) : null),
        c.answerCheckMode ?? 'self',
        typeof c.metadata === 'string' ? c.metadata : JSON.stringify(c.metadata ?? {}),
        c.enabled === false ? 0 : 1,
        c.archivedAt ?? null,
        c.nextRepeatAt ?? now,
        c.lastReviewedAt ?? null,
        c.algorithm ?? 'mnemosyne_like_v1',
        Number(c.intervalDays ?? c.schedule?.intervalDays ?? 0),
        Number(c.ease ?? c.schedule?.ease ?? 2.5),
        Number(c.repetitionCount ?? c.schedule?.repetitionCount ?? 0),
        Number(c.lapseCount ?? c.schedule?.lapseCount ?? 0),
        c.lastGrade ?? c.schedule?.lastGrade ?? null,
        c.createdAt ?? now,
        c.updatedAt ?? now
      );
    }

    // 3. Insert incoming reviews
    const insertReviewStmt = this.db.prepare(`
      INSERT OR IGNORE INTO card_reviews (
        id, card_id, user_id, grade, user_answer, checker_result_json, reviewed_at, elapsed_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const r of reviews) {
      if (!r.id || !r.cardId || r.grade === undefined) continue;
      insertReviewStmt.run(
        String(r.id),
        String(r.cardId),
        userId,
        Number(r.grade),
        r.userAnswer ?? null,
        typeof r.checkerResult === 'string' ? r.checkerResult : (r.checkerResult ? JSON.stringify(r.checkerResult) : null),
        r.reviewedAt ?? now,
        r.elapsedMs ?? null
      );
    }

    // 4. Gather server changes since timestamp
    let outgoingDecks = [];
    let outgoingCards = [];
    let outgoingReviews = [];

    if (since) {
      outgoingDecks = this.db.prepare('SELECT * FROM study_decks WHERE updated_at > ?').all(since);
      outgoingCards = this.db.prepare('SELECT * FROM study_cards WHERE updated_at > ?').all(since);
      outgoingReviews = this.db.prepare('SELECT * FROM card_reviews WHERE reviewed_at > ?').all(since);
    } else {
      outgoingDecks = this.db.prepare('SELECT * FROM study_decks').all();
      outgoingCards = this.db.prepare('SELECT * FROM study_cards').all();
      outgoingReviews = this.db.prepare('SELECT * FROM card_reviews ORDER BY reviewed_at DESC LIMIT 1000').all();
    }

    return {
      serverTime: now,
      decks: outgoingDecks.map(normalizeDeckRecord),
      cards: outgoingCards.map(normalizeCardRecord),
      reviews: outgoingReviews.map(normalizeReviewRecord),
    };
  }

  listDecks() {
    const now = new Date().toISOString();
    return this.db.prepare(`
      SELECT
        d.*,
        COUNT(c.id) AS total_cards,
        SUM(CASE WHEN c.enabled = 1 AND c.archived_at IS NULL AND c.next_repeat_at <= ? THEN 1 ELSE 0 END) AS due_cards
      FROM study_decks d
      LEFT JOIN study_cards c ON c.deck_id = d.id
      GROUP BY d.id
      ORDER BY d.name ASC
    `).all(now).map((row) => ({
      ...normalizeDeckRecord(row),
      totalCards: Number(row.total_cards || 0),
      dueCards: Number(row.due_cards || 0),
    }));
  }

  getDueCards({ deckId = null, limit = 50 } = {}) {
    const now = new Date().toISOString();
    let query = `
      SELECT c.*, d.name AS deck_name
      FROM study_cards c
      LEFT JOIN study_decks d ON d.id = c.deck_id
      WHERE c.enabled = 1 AND c.archived_at IS NULL AND c.next_repeat_at <= ?
    `;
    const params = [now];

    if (deckId) {
      query += ' AND c.deck_id = ?';
      params.push(deckId);
    }

    query += ' ORDER BY c.next_repeat_at ASC LIMIT ?';
    params.push(limit);

    return this.db.prepare(query).all(...params).map(normalizeCardRecord);
  }

  recordReview({ cardId, grade, userAnswer = null, elapsedMs = null, userId = null }) {
    const card = this.db.prepare('SELECT * FROM study_cards WHERE id = ?').get(cardId);
    if (!card) {
      throw new Error(`Card not found: ${cardId}`);
    }

    const now = new Date();
    const g = Number(grade);

    // Calculate next schedule
    let intervalDays = Number(card.interval_days || 0);
    let ease = Number(card.ease || 2.5);
    let repetitionCount = Number(card.repetition_count || 0);
    let lapseCount = Number(card.lapse_count || 0);
    let nextRepeatAt = now;

    if (g === 0) {
      lapseCount += 1;
      nextRepeatAt = now; // Due immediately / today
    } else {
      if (repetitionCount === 0 || intervalDays <= 0) {
        if (g === 1 || g === 2) intervalDays = 1;
        else if (g === 3) intervalDays = 3;
        else intervalDays = 5;
      } else {
        if (g === 1) intervalDays = 1;
        else if (g === 2) intervalDays = Math.max(1, intervalDays * 1.2);
        else if (g === 3) intervalDays = Math.max(2, intervalDays * ease);
        else intervalDays = Math.max(3, intervalDays * (ease + 0.35));
      }

      if (g === 1) ease = Math.max(1.3, ease - 0.2);
      else if (g === 2) ease = Math.max(1.3, ease - 0.05);
      else if (g === 4) ease = Math.min(3.0, ease + 0.1);

      repetitionCount += 1;
      nextRepeatAt = new Date(now.getTime() + Math.floor(intervalDays) * 86400000);
    }

    const nowIso = now.toISOString();
    const nextRepeatIso = nextRepeatAt.toISOString();

    // Update card
    this.db.prepare(`
      UPDATE study_cards SET
        next_repeat_at = ?,
        last_reviewed_at = ?,
        interval_days = ?,
        ease = ?,
        repetition_count = ?,
        lapse_count = ?,
        last_grade = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      nextRepeatIso,
      nowIso,
      intervalDays,
      ease,
      repetitionCount,
      lapseCount,
      g,
      nowIso,
      cardId
    );

    // Insert review log
    const reviewId = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`
      INSERT INTO card_reviews (
        id, card_id, user_id, grade, user_answer, checker_result_json, reviewed_at, elapsed_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reviewId,
      cardId,
      userId,
      g,
      userAnswer,
      null,
      nowIso,
      elapsedMs
    );

    return {
      cardId,
      grade: g,
      nextRepeatAt: nextRepeatIso,
      intervalDays,
      ease,
      repetitionCount,
      lapseCount,
      reviewedAt: nowIso,
    };
  }

  deleteDeck(deckId) {
    this.db.prepare('DELETE FROM study_decks WHERE id = ?').run(deckId);
  }
}

function normalizeDeckRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceType: row.source_type,
    sourceRule: safeJsonParse(row.source_rule_json, {}),
    tags: safeJsonParse(row.tags_json, []),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeCardRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    deckId: row.deck_id,
    deckName: row.deck_name,
    questionName: row.question_name,
    questionText: row.question_text,
    questionType: row.question_type,
    answerText: row.answer_text,
    choices: safeJsonParse(row.choices_json, null),
    answerCheckMode: row.answer_check_mode,
    metadata: safeJsonParse(row.metadata_json, {}),
    enabled: Boolean(row.enabled),
    archivedAt: row.archived_at,
    nextRepeatAt: row.next_repeat_at,
    lastReviewedAt: row.last_reviewed_at,
    algorithm: row.algorithm,
    intervalDays: row.interval_days,
    ease: row.ease,
    repetitionCount: row.repetition_count,
    lapseCount: row.lapse_count,
    lastGrade: row.last_grade,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeReviewRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    cardId: row.card_id,
    grade: row.grade,
    userAnswer: row.user_answer,
    checkerResult: safeJsonParse(row.checker_result_json, null),
    reviewedAt: row.reviewed_at,
    elapsedMs: row.elapsed_ms,
  };
}

function safeJsonParse(val, fallback) {
  if (typeof val !== 'string') return fallback;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

module.exports = {
  CardStore,
};
