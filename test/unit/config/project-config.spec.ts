import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  defaultPathContext,
  KnowledgeBaseConfig,
  UnknownProjectError,
} from '../../../src/config/project-config.js';

const paths = { baseDir: '/opt/kb', homeDir: '/home/dev' };

const VALID = `
dataDir: ./data
defaults:
  embeddings:
    provider: ollama
    host: http://localhost:11434
    model: qwen3-embedding:0.6b
    dimensions: 1024
    queryInstruction: Retrieve notes
  qdrant:
    url: http://localhost:6333
  knowledge:
    duplicateThreshold: 0.95
    similarThreshold: 0.85
projects:
  notes:
    name: Notes
    root: ~/notes
  other:
    name: Other
    root: /srv/other
    include: ["**/*.md"]
    exclude: ["**/dist/**"]
    embeddings:
      model: qwen3-embedding:4b
      dimensions: 2560
    knowledge:
      duplicateThreshold: 0.9
      similarThreshold: 0.8
`;

function parse(yaml: string = VALID): KnowledgeBaseConfig {
  return KnowledgeBaseConfig.parse(yaml, paths);
}

describe('KnowledgeBaseConfig', () => {
  describe('parse', () => {
    it('lists configured projects', () => {
      expect(parse().projectIds()).toEqual(['notes', 'other']);
    });

    it('rejects invalid YAML', () => {
      expect(() => parse('projects: [')).toThrow(ConfigError);
      expect(() => parse('projects: [')).toThrow('Configuration is not valid YAML');
    });

    it.each([
      ['an empty document', ''],
      ['no project', VALID.replace(/projects:[\s\S]*/, 'projects: {}')],
      ['an invalid project id', VALID.replace('  other:', '  Other_Project:')],
      ['an unknown key', `${VALID}\nunexpected: true\n`],
      ['a non-http embeddings host', VALID.replace('http://localhost:11434', 'ftp://x')],
      [
        'thresholds in the wrong order',
        VALID.replace('similarThreshold: 0.85', 'similarThreshold: 0.99'),
      ],
      ['empty include globs', VALID.replace('include: ["**/*.md"]', 'include: []')],
      [
        'a code-project option',
        VALID.replace(
          '    include: ["**/*.md"]',
          '    include: ["**/*.md"]\n    openapi: ["**/*.yaml"]',
        ),
      ],
      ['a model override without dimensions', VALID.replace('      dimensions: 2560\n', '')],
      ['an invalid embeddings override', VALID.replace('dimensions: 2560', 'dimensions: 0')],
    ])('rejects %s', (_label, yaml) => {
      expect(() => parse(yaml)).toThrow(/Invalid configuration/);
    });
  });

  describe('project', () => {
    it('resolves a project with defaults', () => {
      const project = parse().project('notes');

      expect(project).toEqual({
        id: 'notes',
        name: 'Notes',
        root: '/home/dev/notes',
        dataDir: '/opt/kb/data/notes',
        sqlitePath: '/opt/kb/data/notes/md.sqlite',
        include: ['**/*.md', '**/*.markdown'],
        exclude: [],
        maxFileBytes: 524288,
        embeddings: {
          provider: 'ollama',
          host: 'http://localhost:11434',
          model: 'qwen3-embedding:0.6b',
          dimensions: 1024,
          queryInstruction: 'Retrieve notes',
          batchSize: 32,
        },
        qdrant: { url: 'http://localhost:6333' },
        knowledge: { duplicateThreshold: 0.95, similarThreshold: 0.85 },
        collection: {
          collection: 'md_notes__qwen3-embedding-0_6b_1024',
          alias: 'md_notes',
        },
      });
    });

    it('applies per-project overrides and keeps projects isolated', () => {
      const config = parse();
      const other = config.project('other');
      const main = config.project('notes');

      expect(other.root).toBe('/srv/other');
      expect(other.embeddings.model).toBe('qwen3-embedding:4b');
      expect(other.embeddings.dimensions).toBe(2560);
      expect(other.knowledge).toEqual({ duplicateThreshold: 0.9, similarThreshold: 0.8 });
      expect(other.collection.alias).not.toBe(main.collection.alias);
      expect(other.sqlitePath).not.toBe(main.sqlitePath);
    });

    it.each(['unknown', 'toString', '__proto__'])('rejects the unknown project %s', (id) => {
      const config = parse();

      expect(() => config.project(id)).toThrow(UnknownProjectError);
      expect(() => config.project(id)).toThrow('Configured projects: notes, other.');
    });

    it.each([
      ['"~"', '/home/dev'],
      ['/abs/../root', '/root'],
      ['relative/dir', '/opt/kb/relative/dir'],
    ])('resolves the root %s to %s', (root, expected) => {
      const config = parse(VALID.replace('root: ~/notes', `root: ${root}`));

      expect(config.project('notes').root).toBe(expected);
    });
  });

  describe('defaultPathContext', () => {
    it('uses the configuration directory as base', () => {
      expect(defaultPathContext('/etc/kb/config.yaml').baseDir).toBe('/etc/kb');
    });
  });
});
