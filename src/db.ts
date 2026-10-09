import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  required_pieces TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  approved_at TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Toda versão fica, nunca é apagada nem sobrescrita. A atual é a de maior número.
CREATE TABLE IF NOT EXISTS piece_versions (
  delivery_id TEXT NOT NULL,
  piece TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  duration_seconds REAL,
  status TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY (delivery_id, piece, number)
);

-- O comentário pertence a UMA versão (delivery, piece, version_number) e não migra para a seguinte.
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  piece TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  at_second REAL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_version ON comments (delivery_id, piece, version_number);

-- Cada mudança de status da entrega, com a causa. É o rastro de "por que deixou de estar aprovada".
CREATE TABLE IF NOT EXISTS delivery_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  at TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  cause TEXT NOT NULL
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
