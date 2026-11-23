import type { NotesFixture } from './notes-fixture.js';

/** Long enough (>= 40 tokens) to be compared by similarity detection. */
export const SHARED_CHECKLIST = [
  '## Checklist',
  'Before shipping, run the linter, the unit tests and the integration tests, then read the diff',
  'one last time and write down what changed in the journal so that future me remembers why.',
  '',
].join('\n');

/** A small but realistic notes folder: links (relative, root, reference, extension-less), folders,
 * a duplicated section, a broken link and a note with a secret. */
export function writeMiniNotes(fixture: NotesFixture): void {
  fixture.write(
    'README.md',
    [
      '# Notes',
      '',
      'Start with [the knowledge base](work/kb/architecture.md) and the [journal](journal/2026-11-23.md).',
      '',
    ].join('\n'),
  );
  fixture.write(
    'work/kb/architecture.md',
    [
      '# Architecture',
      '',
      'The indexer splits Markdown notes into sections, embeds them with Ollama and stores the',
      'vectors in Qdrant. See [embeddings](./embeddings.md) and [home](/README.md).',
      '',
      '## Storage',
      '',
      'SQLite keeps the metadata and a full-text index (FTS5) of every section.',
      'Details are in [the storage guide][storage].',
      '',
      '[storage]: ../storage.md',
      '',
      SHARED_CHECKLIST,
    ].join('\n'),
  );
  fixture.write(
    'work/kb/embeddings.md',
    [
      '# Embeddings',
      '',
      'Qwen3-Embedding 0.6B turns each section into a vector of 1024 numbers. Queries get an',
      'instruction prefix, documents do not. Back to the [architecture](architecture).',
      '',
    ].join('\n'),
  );
  fixture.write(
    'journal/2026-11-23.md',
    [
      '# 2026-11-23',
      '',
      'Worked on the [knowledge base](/work/kb/architecture) and a [missing note](ideas.md).',
      '',
      SHARED_CHECKLIST,
    ].join('\n'),
  );
  fixture.write(
    'personal/recipes/pasta.md',
    '# Pasta\n\nBoil salted water, cook the spaghetti for nine minutes, add garlic and olive oil.\n',
  );
  fixture.write('personal/leak.md', '# Wifi\n\nadmin password: "S3cr3tValue!"\n');
  fixture.write('work/archive/old.md', '# Old\n\nExcluded by the archive glob.\n');
  fixture.write('work/todo.txt', 'not markdown');
}
