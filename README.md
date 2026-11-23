# md-brain — local knowledge base over a folder of Markdown notes

Local knowledge base over a collection of Markdown files (any folder of `.md` / `.markdown`
notes, nothing editor-specific), exposed to agents (Claude Code) through MCP. Everything runs
locally: Ollama (embeddings), Qdrant (vectors), SQLite (metadata, links, full-text index). The
files on disk stay the source of truth: every result points to `note.md:Lstart-Lend` and excerpts
are re-read from disk (flagged `stale` if the note changed since indexing).

Derived from claude-brain (knowledge base over code projects), with the whole code part removed:
no git, no TypeScript parsing, no code graph, no services/repositories.

## Architecture

```
src/domain/      pure model: ids, hashing, RRF fusion, records, folders, ports (no I/O)
src/config/      config.yaml validation (zod), one isolated config per project
src/ingestion/   discovery (folder walk + globs), secret guard, incremental sync,
                 Markdown chunker (heading sections, links)
src/embeddings/  Ollama provider (Qwen3 query instruction), per-model embedding cache
src/storage/     SQLite (node:sqlite, FTS5) and Qdrant adapters
src/knowledge/   duplicates and similarity links
src/retrieval/   hybrid search, notes service (links, backlinks), source reader, eval
src/mcp/         MCP server and tools (transport independent)
cli/             `mdb` command (composition root)
```

Data flow: discovery → sync (stat, then sha256: unchanged notes are never re-read nor
re-embedded) → chunking (one chunk per H1-H3 section, ~800 tokens max) → embeddings (cache by
content hash) → Qdrant point + SQLite rows (chunk, FTS5, links) → post-pass: similarity links →
alias switch. Search: Qdrant dense + FTS5 bm25, fused with weighted RRF, at most 2 chunks per
note, excerpts re-read from disk.

- **Isolation**: one project = one folder. One SQLite file per project (`data/<project>/md.sqlite`),
  one Qdrant collection per project *and* embedding model (`md_<project>__<model>_<dim>`) behind
  an alias `md_<project>`. The MCP server is started for one project and has no project parameter.
- **Links**: Markdown links (`[x](../a.md)`, root-relative `[x](/a.md)`, reference definitions
  `[x]: a.md`, extension-less `[x](a)`) are stored by target path and resolved at query time:
  outgoing links, backlinks, broken links.
- **Suggested links**: `duplicate_of` (≥ 0.95 cosine) and `similar_to` (≥ 0.85) between sections of
  different notes, `origin: suggested` with a score.
- **Folders**: every search can be restricted to folders (subfolders included).

## Prerequisites

- Node 24 (`nvm use`), pnpm 10 (`node:sqlite` is used).
- Docker: `docker compose up -d` starts Qdrant (`localhost:6333`) and Ollama (`localhost:11434`),
  and the one-shot `ollama-pull` service downloads `qwen3-embedding:0.6b` into the `ollama_models`
  volume (first start only; follow it with `docker compose logs -f ollama-pull`, wait for it to
  exit before the first `mdb index`).
- The ports must be free: stop an Ollama installed on the host (`pkill ollama`, or
  `systemctl stop ollama`) and claude-brain's Qdrant container if it runs (or keep it and start only
  `docker compose up -d ollama ollama-pull`: collections are prefixed `md_`, no clash).
- Ollama runs on the CPU in the container. To use an NVIDIA GPU, install the NVIDIA Container
  Toolkit and add to the `ollama` service:
  `deploy: { resources: { reservations: { devices: [{ driver: nvidia, count: all, capabilities: [gpu] }] } } }`.
- Without Docker: install Ollama and `ollama pull qwen3-embedding:0.6b`, and run Qdrant yourself.

## Usage

Edit `config.yaml` (one block per folder of notes), then:

```bash
pnpm install && pnpm build
node dist/cli/mdb.js index notes --dry-run   # what would be indexed (no write)
node dist/cli/mdb.js index notes             # incremental index (--rebuild: from scratch)
node dist/cli/mdb.js status notes
node dist/cli/mdb.js search notes "comment configurer le proxy docker" [--folder work] [--limit 10]
node dist/cli/mdb.js duplicates notes [--kind similar_to] [--limit 20]
node dist/cli/mdb.js eval notes              # reference queries in eval/notes.yaml (see eval/example.yaml)
```

Re-run `mdb index` after editing notes: the index reflects the files on disk. Include/exclude
globs are case-sensitive (`**/*.md` does not match `NOTES.MD`); only Markdown files are ever
indexed, whatever the globs. `.git`, `node_modules`, `.obsidian` and `.trash` folders are never
walked, symbolic links never followed.

On a laptop CPU (e.g. 4 cores, no GPU) the first index runs at roughly 100-150 tokens/s
(~40 min for 300k tokens of notes); later runs only embed changed sections.

## MCP (Claude Code)

```bash
claude mcp add md-notes -s user -e MD_BRAIN_CONFIG=/home/dtheo/Git/md-brain/config.yaml \
  -- /home/dtheo/.nvm/versions/node/v24.21.0/bin/node /home/dtheo/Git/md-brain/dist/cli/mdb.js \
  mcp --project notes
claude mcp remove md-notes -s user   # to unregister
```

Tools (read-only): `get_overview` (notes per folder, most linked notes, broken links, index
state), `search_notes` (hybrid search, optional `folders`), `get_note` (sections, outgoing links,
backlinks, similar sections, lines read from disk).

## Security

- Path exclusions first, then a content secret guard (tokens, keys, credentials in URLs except
  localhost, literal passwords): matching notes are never indexed (only their path is reported).
- Excerpts and folder filters are confined to the project root.

## Development

`pnpm lint`, `pnpm build`, `pnpm test:unit`, `pnpm test:integration` (needs Qdrant),
`pnpm test:coverage` (unit + integration, 95% thresholds).

## Limitations

- No Obsidian syntax: `[[wikilinks]]`, `#tags` and front matter are indexed as plain text.
- The RRF weight of the dense retriever (2) was calibrated on code documentation: recalibrate with
  `mdb eval` on real questions about your notes.
- MCP over stdio only.
