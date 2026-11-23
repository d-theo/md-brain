import type { ProjectConfig } from '../../src/config/project-config.js';
import { collectionNames } from '../../src/domain/collection.js';
import type { ProjectId } from '../../src/domain/project-id.js';

export function aProjectConfig(
  id: ProjectId,
  root: string,
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
  const embeddings = {
    provider: 'ollama' as const,
    host: 'http://localhost:11434',
    model: 'fake',
    dimensions: 8,
    queryInstruction: 'q',
    batchSize: 4,
  };
  return {
    id,
    name: id,
    root,
    dataDir: `${root}/.md-data`,
    sqlitePath: `${root}/.md-data/md.sqlite`,
    include: ['**/*.md', '**/*.markdown', '**/*.txt'],
    exclude: ['**/archive/**', '.md-data/**'],
    maxFileBytes: 1024,
    embeddings,
    qdrant: { url: 'http://localhost:6333' },
    knowledge: { duplicateThreshold: 0.95, similarThreshold: 0.85 },
    collection: collectionNames(id, embeddings),
    ...overrides,
  };
}
