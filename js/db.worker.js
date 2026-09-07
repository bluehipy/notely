// SQLite WASM Web Worker
// Handles all database operations in a dedicated thread with OPFS persistence

importScripts('./sqlite3.js');

let db = null;

// Initialize SQLite WASM with OPFS, with one self-healing retry on corruption
sqlite3InitModule({
  locateFile: (filename) => `./${filename}`
}).then(async (sqlite3) => {
  async function tryInit(wipeFirst) {
    const pool = await sqlite3.installOpfsSAHPoolVfs({});
    if (wipeFirst) {
      await pool.wipeFiles();
    }
    db = new sqlite3.oo1.OpfsDb('/notely.db');
    console.log('SQLite WASM initialized with OPFS');
    createSchema(db);
    self.postMessage({ type: 'ready' });
  }

  try {
    await tryInit(false);
  } catch (firstError) {
    console.warn('DB init failed, wiping OPFS and retrying:', firstError.message);
    try {
      if (db) { try { db.close(); } catch {} db = null; }
      await tryInit(true);
    } catch (secondError) {
      console.error('Failed to initialize SQLite WASM after wipe:', secondError);
      self.postMessage({ type: 'error', error: secondError.message });
    }
  }
});

// Create database schema
function createSchema(db) {
  // Notebooks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Notes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notebook_id INTEGER REFERENCES notebooks(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Tags table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )
  `);

  // Note-Tag junction table
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_tags (
      note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
      tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (note_id, tag_id)
    )
  `);

  // Full-text search virtual table (FTS5)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title,
      body,
      content='notes',
      content_rowid='id'
    )
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
      INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END
  `);

  // Indexes
  // Attachments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT,
      data TEXT,
      size INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at ASC)`);

  // Events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add time column if upgrading from older schema
  try { db.exec(`ALTER TABLE events ADD COLUMN time TEXT`); } catch {}

  // Migration: add priority column to tasks if upgrading
  try { db.exec(`ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`); } catch {}

  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_date ON events(date ASC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_notebook ON notes(notebook_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id)`);

  console.log('Database schema created successfully');
}

// Handle messages from main thread
self.onmessage = ({ data }) => {
  const { id, sql, params } = data;

  if (!db) {
    self.postMessage({ id, error: 'Database not initialized' });
    return;
  }

  try {
    // Check if this is a SELECT query or a write query
    const isSelect = sql.trim().toUpperCase().startsWith('SELECT');

    if (isSelect) {
      // Use selectObjects for SELECT queries
      const result = db.selectObjects(sql, params || []);
      self.postMessage({ id, result });
    } else {
      // Use exec for write queries
      db.exec({
        sql,
        bind: params || []
      });

      // Get last insert ID and changes count
      const lastInsertId = db.selectValue('SELECT last_insert_rowid()');
      const changes = db.changes();

      self.postMessage({ id, result: { lastInsertId, changes } });
    }
  } catch (error) {
    // If the DB is corrupt, signal the main thread so it can reload cleanly
    if (error.message && (error.message.includes('SQLITE_CORRUPT') || error.message.includes('SQLITE_IOERR'))) {
      self.postMessage({ type: 'corrupt' });
    }
    self.postMessage({ id, error: error.message });
  }
};
