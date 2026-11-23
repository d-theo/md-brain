/**
 * Ordered, append-only migrations. Never edit a released migration: add a new one.
 * The schema version is tracked with `PRAGMA user_version`.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE index_run (
    id          INTEGER PRIMARY KEY,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL,
    stats_json  TEXT NOT NULL DEFAULT '{}'
  ) STRICT;

  CREATE TABLE file (
    id               TEXT PRIMARY KEY,
    path             TEXT NOT NULL UNIQUE,
    size             INTEGER NOT NULL,
    mtime_ms         INTEGER NOT NULL,
    content_hash     TEXT NOT NULL,
    last_run_id      INTEGER,
    pipeline_version TEXT NOT NULL
  ) STRICT;

  CREATE TABLE chunk (
    rowid          INTEGER PRIMARY KEY,
    id             TEXT NOT NULL UNIQUE,
    file_id        TEXT NOT NULL REFERENCES file(id) ON DELETE CASCADE,
    ordinal        INTEGER NOT NULL,
    anchor         TEXT NOT NULL,
    heading_path   TEXT,
    start_line     INTEGER NOT NULL,
    end_line       INTEGER NOT NULL,
    content_hash   TEXT NOT NULL,
    token_count    INTEGER NOT NULL,
    embedded_model TEXT
  ) STRICT;
  CREATE INDEX chunk_file_id ON chunk(file_id);
  CREATE INDEX chunk_content_hash ON chunk(content_hash);

  -- Contentless: the chunk text is not duplicated, results are re-read from the source file.
  CREATE VIRTUAL TABLE chunk_fts USING fts5(
    text, title, path,
    content = '',
    contentless_delete = 1,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER chunk_fts_delete AFTER DELETE ON chunk BEGIN
    DELETE FROM chunk_fts WHERE rowid = old.rowid;
  END;

  CREATE TABLE embedding_cache (
    model        TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    vector       BLOB NOT NULL,
    PRIMARY KEY (model, content_hash)
  ) STRICT, WITHOUT ROWID;

  -- md_link: dst_ref is the root-relative target path (resolved at query time);
  -- duplicate_of / similar_to: dst_id = dst_ref = target chunk id.
  CREATE TABLE relation (
    id       INTEGER PRIMARY KEY,
    file_id  TEXT NOT NULL REFERENCES file(id) ON DELETE CASCADE,
    src_id   TEXT NOT NULL,
    kind     TEXT NOT NULL,
    dst_type TEXT NOT NULL,
    dst_id   TEXT,
    dst_ref  TEXT NOT NULL,
    origin   TEXT NOT NULL,
    method   TEXT NOT NULL,
    score    REAL,
    line     INTEGER
  ) STRICT;
  CREATE INDEX relation_src ON relation(src_id, kind);
  CREATE INDEX relation_dst_ref ON relation(dst_ref, kind);
  CREATE INDEX relation_dst_id ON relation(dst_id, kind);
  CREATE INDEX relation_file_id ON relation(file_id);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
