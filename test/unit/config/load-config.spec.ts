import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_ENV_VAR, loadConfig, resolveConfigPath } from '../../../src/config/load-config.js';
import { ConfigError } from '../../../src/config/project-config.js';

const REPO_CONFIG = resolve(import.meta.dirname, '../../../config.yaml');

describe('load-config', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'md-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('resolveConfigPath', () => {
    it('prefers the explicit path, then the environment, then ./config.yaml', () => {
      expect(resolveConfigPath('/a.yaml', { [CONFIG_ENV_VAR]: '/b.yaml' })).toBe('/a.yaml');
      expect(resolveConfigPath(undefined, { [CONFIG_ENV_VAR]: '/b.yaml' })).toBe('/b.yaml');
      expect(resolveConfigPath(undefined, {})).toBe(resolve('config.yaml'));
    });
  });

  describe('loadConfig', () => {
    it('fails clearly when the file cannot be read', () => {
      const missing = join(dir, 'missing.yaml');

      expect(() => loadConfig(missing)).toThrow(ConfigError);
      expect(() => loadConfig(missing)).toThrow(`Cannot read configuration "${missing}"`);
    });

    it('resolves relative paths against the configuration directory', () => {
      const file = join(dir, 'config.yaml');
      writeFileSync(
        file,
        [
          'dataDir: ./data',
          'defaults:',
          '  embeddings: { provider: ollama, host: "http://h:1", model: m, dimensions: 8, queryInstruction: q }',
          '  qdrant: { url: "http://q:1" }',
          '  knowledge: { duplicateThreshold: 0.9, similarThreshold: 0.5 }',
          'projects:',
          '  demo: { name: Demo, root: ./src, include: ["**/*.md"] }',
        ].join('\n'),
      );

      const project = loadConfig(file).project('demo');

      expect(project.root).toBe(join(dir, 'src'));
      expect(project.sqlitePath).toBe(join(dir, 'data', 'demo', 'md.sqlite'));
    });

    it('ships a valid example configuration with Markdown-only defaults', () => {
      const config = loadConfig(REPO_CONFIG);

      expect(config.projectIds()).toEqual(['notes']);
      const project = config.project('notes');
      expect(project.collection.alias).toBe('md_notes');
      expect(project.include).toEqual(['**/*.md', '**/*.markdown']);
      expect(project.exclude).toContain('**/.env*');
      expect(project.maxFileBytes).toBe(512 * 1024);
    });
  });
});
