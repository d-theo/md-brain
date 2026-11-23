import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EmbeddingModelRef } from '../../domain/collection.js';
import { EmbeddingModelMismatchError } from '../../domain/errors.js';
import {
  RELATION_KINDS,
  RELATION_METHODS,
  RELATION_ORIGINS,
  RELATION_TARGETS,
  type RelationKind,
} from '../../domain/model.js';
import type {
  ChunkContext,
  LexicalHit,
  MetadataStore,
  SearchFilter,
  SimilarityCandidate,
} from '../../domain/ports.js';
import type { ProjectId } from '../../domain/project-id.js';
import type {
  ChunkInput,
  ChunkRecord,
  FileRecord,
  IndexRunRecord,
  IndexRunStatus,
  RelationInput,
  RelationRecord,
} from '../../domain/records.js';
import { ProjectMismatchError, SchemaVersionError, StorageError } from '../errors.js';
import {
  blob,
  decodeVector,
  encodeVector,
  int,
  intOrNull,
  oneOf,
  type Row,
  real,
  text,
  textOrNull,
} from './rows.js';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

const RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
const BUSY_TIMEOUT_MS = 5_000;
const IN_CLAUSE_BATCH = 500;

export interface OpenOptions {
  /** Read-only connections (MCP server) never migrate nor write. */
  readonly readOnly?: boolean;
  /** Clock used for timestamps (injectable for tests). */
  readonly now?: () => Date;
}

/** Notes metadata, links and lexical index of ONE project, in its own SQLite file. */
export class SqliteMetadataStore implements MetadataStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  static open(path: string, project: ProjectId, options: OpenOptions = {}): SqliteMetadataStore {
    const readOnly = options.readOnly ?? false;
    if (!readOnly) {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path, {
      readOnly,
      enableForeignKeyConstraints: true,
      timeout: BUSY_TIMEOUT_MS,
    });
    try {
      if (readOnly) {
        SqliteMetadataStore.assertSchemaVersion(db, path);
      } else {
        db.exec('PRAGMA journal_mode = WAL;');
        SqliteMetadataStore.migrate(db);
      }
      SqliteMetadataStore.bindProject(db, path, project, readOnly);
    } catch (error) {
      db.close();
      throw error;
    }
    return new SqliteMetadataStore(db, options.now ?? (() => new Date()));
  }

  private static userVersion(db: DatabaseSync): number {
    const row = db.prepare('PRAGMA user_version').get();
    return row === undefined ? 0 : int(row, 'user_version');
  }

  private static assertSchemaVersion(db: DatabaseSync, path: string): void {
    const version = SqliteMetadataStore.userVersion(db);
    if (version !== SCHEMA_VERSION) {
      throw new SchemaVersionError(path, version, SCHEMA_VERSION);
    }
  }

  private static migrate(db: DatabaseSync): void {
    const current = SqliteMetadataStore.userVersion(db);
    if (current > SCHEMA_VERSION) {
      throw new StorageError(
        `Database schema version ${current} is newer than this build (${SCHEMA_VERSION}).`,
      );
    }
    MIGRATIONS.slice(current).forEach((sql, offset) => {
      transaction(db, () => {
        db.exec(sql);
        db.exec(`PRAGMA user_version = ${current + offset + 1}`);
      });
    });
  }

  private static bindProject(
    db: DatabaseSync,
    path: string,
    project: ProjectId,
    readOnly: boolean,
  ): void {
    const stored = readMeta(db, 'project_id');
    if (stored === undefined) {
      if (readOnly) {
        throw new StorageError(`Database "${path}" has no project id.`);
      }
      writeMeta(db, 'project_id', project);
    } else if (stored !== project) {
      throw new ProjectMismatchError(path, project, stored);
    }
  }

  bindEmbeddingModel(model: EmbeddingModelRef): void {
    const expected = `${model.model}@${model.dimensions}`;
    const stored = readMeta(this.db, 'embedding_model');
    if (stored === undefined) {
      writeMeta(this.db, 'embedding_model', expected);
    } else if (stored !== expected) {
      throw new EmbeddingModelMismatchError(stored, expected);
    }
  }

  /**
   * Merges the FTS5 indexes (deleted rows otherwise keep weighing on bm25 statistics) and lets
   * SQLite refresh its query planner statistics. Run after an index run.
   */
  optimize(): void {
    this.db.exec(`
      INSERT INTO chunk_fts(chunk_fts) VALUES ('optimize');
      PRAGMA optimize;
    `);
  }

  getMeta(key: string): string | undefined {
    return readMeta(this.db, key);
  }

  setMeta(key: string, value: string): void {
    writeMeta(this.db, key, value);
  }

  listFileIds(): string[] {
    return this.db
      .prepare('SELECT id FROM file ORDER BY id')
      .all()
      .map((row) => text(row, 'id'));
  }

  getFile(path: string): FileRecord | undefined {
    const row = this.db.prepare('SELECT * FROM file WHERE path = ?').get(path);
    return row === undefined ? undefined : toFile(row);
  }

  listFiles(): FileRecord[] {
    return this.db.prepare('SELECT * FROM file ORDER BY path').all().map(toFile);
  }

  /** Files whose path is `path` or ends with `/path`. */
  findFilesByPath(path: string): FileRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM file WHERE path = ?1 OR path LIKE '%/' || ?2 ESCAPE '\\'
         ORDER BY path LIMIT 50`,
      )
      .all(path, escapeLike(path))
      .map(toFile);
  }

  replaceFile(
    file: FileRecord,
    chunks: readonly ChunkInput[],
    relations: readonly RelationInput[] = [],
  ): void {
    const ids = new Set(chunks.map((chunk) => chunk.id));
    if (ids.size !== chunks.length) {
      throw new StorageError(`Duplicate chunk ids for file "${file.path}".`);
    }
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM file WHERE id = ? OR path = ?').run(file.id, file.path);
      this.db
        .prepare(
          `INSERT INTO file (id, path, size, mtime_ms, content_hash, last_run_id, pipeline_version)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          file.id,
          file.path,
          file.size,
          file.mtimeMs,
          file.contentHash,
          file.lastRunId,
          file.pipelineVersion,
        );
      const insertChunk = this.db.prepare(
        `INSERT INTO chunk (id, file_id, ordinal, anchor, heading_path, start_line, end_line,
                            content_hash, token_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.db.prepare(
        'INSERT INTO chunk_fts (rowid, text, title, path) VALUES (?, ?, ?, ?)',
      );
      for (const chunk of chunks) {
        const { lastInsertRowid } = insertChunk.run(
          chunk.id,
          file.id,
          chunk.ordinal,
          chunk.anchor,
          chunk.headingPath,
          chunk.startLine,
          chunk.endLine,
          chunk.contentHash,
          chunk.tokenCount,
        );
        insertFts.run(lastInsertRowid, chunk.text, chunk.title, file.path);
      }
      this.writeRelations(file.id, relations);
    });
  }

  private writeRelations(fileId: string, relations: readonly RelationInput[]): void {
    const insertRelation = this.db.prepare(
      `INSERT INTO relation (file_id, src_id, kind, dst_type, dst_id, dst_ref, origin, method,
                             score, line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const relation of relations) {
      insertRelation.run(
        fileId,
        relation.srcId,
        relation.kind,
        relation.dstType,
        relation.dstId,
        relation.dstRef,
        relation.origin,
        relation.method,
        relation.score,
        relation.line,
      );
    }
  }

  insertRelations(fileId: string, relations: readonly RelationInput[]): void {
    transaction(this.db, () => this.writeRelations(fileId, relations));
  }

  deleteRelationsAround(chunkIds: readonly string[], kinds: readonly RelationKind[]): void {
    transaction(this.db, () => {
      for (const batch of batches([...new Set(chunkIds)])) {
        const ids = placeholders(batch.length);
        this.db
          .prepare(
            `DELETE FROM relation WHERE (src_id IN (${ids}) OR dst_id IN (${ids}))
             AND kind IN (${placeholders(kinds.length)})`,
          )
          .run(...batch, ...batch, ...kinds);
      }
    });
  }

  /** Chunks of the given files with what similarity detection needs to select them. */
  listSimilarityCandidates(fileIds: readonly string[]): SimilarityCandidate[] {
    const candidates: SimilarityCandidate[] = [];
    for (const batch of batches([...new Set(fileIds)])) {
      const rows = this.db
        .prepare(
          `SELECT id, file_id, token_count FROM chunk
           WHERE file_id IN (${placeholders(batch.length)}) ORDER BY file_id, ordinal`,
        )
        .all(...batch);
      for (const row of rows) {
        candidates.push({
          chunkId: text(row, 'id'),
          fileId: text(row, 'file_id'),
          tokenCount: int(row, 'token_count'),
        });
      }
    }
    return candidates;
  }

  duplicateGroups(limit: number, minTokens: number): string[][] {
    return this.db
      .prepare(
        `SELECT json_group_array(id) AS ids FROM (
           SELECT id, content_hash FROM chunk WHERE token_count >= ? ORDER BY id)
         GROUP BY content_hash
         HAVING count(*) > 1
         ORDER BY count(*) DESC, min(id)
         LIMIT ?`,
      )
      .all(minTokens, limit)
      .map((row) => parseStringArray(text(row, 'ids')));
  }

  relationsAround(ids: readonly string[], kinds: readonly RelationKind[]): RelationRecord[] {
    const records = new Map<string, RelationRecord>();
    for (const relation of [
      ...this.relationsFrom(ids, kinds),
      ...this.queryRelations('dst_id', ids, kinds),
    ]) {
      records.set(
        `${relation.srcId}|${relation.kind}|${relation.dstId ?? relation.dstRef}`,
        relation,
      );
    }
    return [...records.values()];
  }

  /** Highest-scored suggested relations of the given kinds whose two ends still exist. */
  topSuggestedRelations(kinds: readonly RelationKind[], limit: number): RelationRecord[] {
    return this.db
      .prepare(
        `SELECT r.* FROM relation r
         JOIN chunk src ON src.id = r.src_id
         JOIN chunk dst ON dst.id = r.dst_id
         WHERE r.origin = 'suggested' AND r.kind IN (${placeholders(kinds.length)})
         ORDER BY r.score DESC, r.id LIMIT ?`,
      )
      .all(...kinds, limit)
      .map(toRelation);
  }

  relationsOfKind(kinds: readonly RelationKind[]): RelationRecord[] {
    return this.db
      .prepare(`SELECT * FROM relation WHERE kind IN (${placeholders(kinds.length)}) ORDER BY id`)
      .all(...kinds)
      .map(toRelation);
  }

  latestRun(): IndexRunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM index_run WHERE status = 'succeeded' ORDER BY id DESC LIMIT 1")
      .get();
    return row === undefined ? undefined : toRun(row);
  }

  relationsFrom(srcIds: readonly string[], kinds: readonly RelationKind[] = []): RelationRecord[] {
    return this.queryRelations('src_id', srcIds, kinds);
  }

  relationsTo(dstRefs: readonly string[], kinds: readonly RelationKind[] = []): RelationRecord[] {
    return this.queryRelations('dst_ref', dstRefs, kinds);
  }

  private queryRelations(
    column: 'src_id' | 'dst_ref' | 'dst_id',
    values: readonly string[],
    kinds: readonly RelationKind[],
  ): RelationRecord[] {
    const records: RelationRecord[] = [];
    const kindClause = kinds.length === 0 ? '' : ` AND kind IN (${placeholders(kinds.length)})`;
    for (const batch of batches([...new Set(values)])) {
      records.push(
        ...this.db
          .prepare(
            `SELECT * FROM relation WHERE ${column} IN (${placeholders(batch.length)})${kindClause}
             ORDER BY id`,
          )
          .all(...batch, ...kinds)
          .map(toRelation),
      );
    }
    return records;
  }

  getFileById(fileId: string): FileRecord | undefined {
    const row = this.db.prepare('SELECT * FROM file WHERE id = ?').get(fileId);
    return row === undefined ? undefined : toFile(row);
  }

  touchFile(file: FileRecord): void {
    const { changes } = this.db
      .prepare(
        `UPDATE file SET size = ?, mtime_ms = ?, last_run_id = ?, pipeline_version = ?
         WHERE id = ? AND content_hash = ?`,
      )
      .run(
        file.size,
        file.mtimeMs,
        file.lastRunId,
        file.pipelineVersion,
        file.id,
        file.contentHash,
      );
    if (Number(changes) !== 1) {
      throw new StorageError(`Cannot touch "${file.path}": unknown file or content.`);
    }
  }

  deleteFile(fileId: string): void {
    this.db.prepare('DELETE FROM file WHERE id = ?').run(fileId);
  }

  listChunks(fileId: string): ChunkRecord[] {
    return this.db
      .prepare('SELECT * FROM chunk WHERE file_id = ? ORDER BY ordinal')
      .all(fileId)
      .map(toChunk);
  }

  markChunksEmbedded(chunkIds: readonly string[], model: string): void {
    transaction(this.db, () => {
      for (const batch of batches(chunkIds)) {
        this.db
          .prepare(
            `UPDATE chunk SET embedded_model = ? WHERE id IN (${placeholders(batch.length)})`,
          )
          .run(model, ...batch);
      }
    });
  }

  getCachedEmbeddings(model: string, contentHashes: readonly string[]): Map<string, number[]> {
    const vectors = new Map<string, number[]>();
    for (const batch of batches([...new Set(contentHashes)])) {
      const rows = this.db
        .prepare(
          `SELECT content_hash, vector FROM embedding_cache
           WHERE model = ? AND content_hash IN (${placeholders(batch.length)})`,
        )
        .all(model, ...batch);
      for (const row of rows) {
        vectors.set(text(row, 'content_hash'), decodeVector(blob(row, 'vector')));
      }
    }
    return vectors;
  }

  putCachedEmbeddings(model: string, vectors: ReadonlyMap<string, readonly number[]>): void {
    const insert = this.db.prepare(
      `INSERT INTO embedding_cache (model, content_hash, vector) VALUES (?, ?, ?)
       ON CONFLICT (model, content_hash) DO UPDATE SET vector = excluded.vector`,
    );
    transaction(this.db, () => {
      for (const [hash, vector] of vectors) {
        insert.run(model, hash, encodeVector(vector));
      }
    });
  }

  startRun(): number {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO index_run (started_at, status) VALUES (?, 'running')")
      .run(this.now().toISOString());
    return Number(lastInsertRowid);
  }

  finishRun(runId: number, status: IndexRunStatus, stats: Readonly<Record<string, number>>): void {
    const { changes } = this.db
      .prepare('UPDATE index_run SET finished_at = ?, status = ?, stats_json = ? WHERE id = ?')
      .run(this.now().toISOString(), status, JSON.stringify(stats), runId);
    if (Number(changes) !== 1) {
      throw new StorageError(`Unknown index run ${runId}.`);
    }
  }

  getRun(runId: number): IndexRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM index_run WHERE id = ?').get(runId);
    return row === undefined ? undefined : toRun(row);
  }

  searchLexical(matchExpression: string, filter: SearchFilter, limit: number): LexicalHit[] {
    const { clause, params } = filterClause(filter);
    return this.db
      .prepare(
        `SELECT c.id AS chunk_id, -bm25(chunk_fts, 1.0, 2.0, 0.5) AS score
         FROM chunk_fts
         JOIN chunk c ON c.rowid = chunk_fts.rowid
         JOIN file f ON f.id = c.file_id
         WHERE chunk_fts MATCH ?${clause}
         ORDER BY score DESC, c.id
         LIMIT ?`,
      )
      .all(matchExpression, ...params, limit)
      .map((row) => ({ chunkId: text(row, 'chunk_id'), score: real(row, 'score') }));
  }

  getChunkContexts(chunkIds: readonly string[]): Map<string, ChunkContext> {
    const contexts = new Map<string, ChunkContext>();
    for (const batch of batches([...new Set(chunkIds)])) {
      const rows = this.db
        .prepare(
          `SELECT c.*, ${prefixed('f', FILE_COLUMNS)}
           FROM chunk c JOIN file f ON f.id = c.file_id
           WHERE c.id IN (${placeholders(batch.length)})`,
        )
        .all(...batch);
      for (const row of rows) {
        contexts.set(text(row, 'id'), {
          chunk: toChunk(row),
          file: toFile(unprefixed(row, 'f', FILE_COLUMNS)),
        });
      }
    }
    return contexts;
  }

  /** Lexical match count, for diagnostics and tests. */
  countLexicalMatches(query: string): number {
    const row = this.db
      .prepare('SELECT count(*) AS n FROM chunk_fts WHERE chunk_fts MATCH ?')
      .get(query);
    return row === undefined ? 0 : int(row, 'n');
  }

  close(): void {
    if (this.db.isOpen) {
      this.db.close();
    }
  }
}

function transaction(db: DatabaseSync, work: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row === undefined ? undefined : text(row, 'value');
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

const FILE_COLUMNS = [
  'id',
  'path',
  'size',
  'mtime_ms',
  'content_hash',
  'last_run_id',
  'pipeline_version',
] as const;

function prefixed(alias: string, columns: readonly string[]): string {
  return columns.map((column) => `${alias}.${column} AS ${alias}__${column}`).join(', ');
}

function unprefixed(row: Row, alias: string, columns: readonly string[]): Row {
  const result: Row = {};
  for (const column of columns) {
    const value = row[`${alias}__${column}`];
    if (value !== undefined) {
      result[column] = value;
    }
  }
  return result;
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** SQL conditions for a search filter; an empty list matches nothing rather than everything. */
function filterClause(filter: SearchFilter): { clause: string; params: string[] } {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filter.folders !== undefined) {
    conditions.push(
      filter.folders.length === 0
        ? '0'
        : `(${filter.folders.map(() => "f.path LIKE ? || '/%' ESCAPE '\\'").join(' OR ')})`,
    );
    params.push(...filter.folders.map(escapeLike));
  }
  if (filter.fileIds !== undefined) {
    conditions.push(
      filter.fileIds.length === 0 ? '0' : `f.id IN (${placeholders(filter.fileIds.length)})`,
    );
    params.push(...filter.fileIds);
  }
  const excluded = filter.excludeFileIds ?? [];
  if (excluded.length > 0) {
    conditions.push(`f.id NOT IN (${placeholders(excluded.length)})`);
    params.push(...excluded);
  }
  return { clause: conditions.map((condition) => ` AND ${condition}`).join(''), params };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += IN_CLAUSE_BATCH) {
    result.push(values.slice(index, index + IN_CLAUSE_BATCH));
  }
  return result;
}

function toFile(row: Row): FileRecord {
  return {
    id: text(row, 'id'),
    path: text(row, 'path'),
    size: int(row, 'size'),
    mtimeMs: int(row, 'mtime_ms'),
    contentHash: text(row, 'content_hash'),
    lastRunId: intOrNull(row, 'last_run_id'),
    pipelineVersion: text(row, 'pipeline_version'),
  };
}

function toChunk(row: Row): ChunkRecord {
  return {
    id: text(row, 'id'),
    fileId: text(row, 'file_id'),
    ordinal: int(row, 'ordinal'),
    anchor: text(row, 'anchor'),
    headingPath: textOrNull(row, 'heading_path'),
    startLine: int(row, 'start_line'),
    endLine: int(row, 'end_line'),
    contentHash: text(row, 'content_hash'),
    tokenCount: int(row, 'token_count'),
    embeddedModel: textOrNull(row, 'embedded_model'),
  };
}

function parseStringArray(json: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new StorageError('Invalid string array.');
  }
  return value;
}

function realOrNull(row: Row, column: string): number | null {
  return row[column] === null ? null : real(row, column);
}

function toRelation(row: Row): RelationRecord {
  return {
    fileId: text(row, 'file_id'),
    srcId: text(row, 'src_id'),
    kind: oneOf(row, 'kind', RELATION_KINDS),
    dstType: oneOf(row, 'dst_type', RELATION_TARGETS),
    dstId: textOrNull(row, 'dst_id'),
    dstRef: text(row, 'dst_ref'),
    origin: oneOf(row, 'origin', RELATION_ORIGINS),
    method: oneOf(row, 'method', RELATION_METHODS),
    score: realOrNull(row, 'score'),
    line: intOrNull(row, 'line'),
  };
}

function toRun(row: Row): IndexRunRecord {
  const stats: unknown = JSON.parse(text(row, 'stats_json'));
  return {
    id: int(row, 'id'),
    startedAt: text(row, 'started_at'),
    finishedAt: textOrNull(row, 'finished_at'),
    status: oneOf(row, 'status', RUN_STATUSES),
    stats: parseStats(stats),
  };
}

function parseStats(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StorageError('Invalid index run stats.');
  }
  const stats: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number') {
      throw new StorageError(`Invalid index run stat "${key}".`);
    }
    stats[key] = entry;
  }
  return stats;
}
