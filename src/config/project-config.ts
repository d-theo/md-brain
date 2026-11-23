import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { type CollectionNames, collectionNames } from '../domain/collection.js';
import { describeError } from '../domain/errors.js';
import { type ProjectId, toProjectId } from '../domain/project-id.js';
import {
  configSchema,
  type EmbeddingsConfig,
  type KnowledgeConfig,
  type QdrantConfig,
  type RawConfig,
} from './config-schema.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class UnknownProjectError extends ConfigError {
  constructor(project: string, known: readonly string[]) {
    super(`Unknown project "${project}". Configured projects: ${known.join(', ')}.`);
    this.name = 'UnknownProjectError';
  }
}

/** Fully resolved, isolated configuration of a single project. */
export interface ProjectConfig {
  readonly id: ProjectId;
  readonly name: string;
  readonly root: string;
  readonly dataDir: string;
  readonly sqlitePath: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly maxFileBytes: number;
  readonly embeddings: EmbeddingsConfig;
  readonly qdrant: QdrantConfig;
  readonly knowledge: KnowledgeConfig;
  readonly collection: CollectionNames;
}

export interface PathContext {
  /** Directory of the configuration file: base for relative paths. */
  readonly baseDir: string;
  readonly homeDir: string;
}

export class KnowledgeBaseConfig {
  private constructor(
    private readonly raw: RawConfig,
    private readonly paths: PathContext,
  ) {}

  static parse(yamlText: string, paths: PathContext): KnowledgeBaseConfig {
    let document: unknown;
    try {
      document = parseYaml(yamlText);
    } catch (error) {
      throw new ConfigError(`Configuration is not valid YAML: ${describeError(error)}`);
    }
    const result = configSchema.safeParse(document);
    if (!result.success) {
      throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
    }
    return new KnowledgeBaseConfig(result.data, paths);
  }

  projectIds(): string[] {
    return Object.keys(this.raw.projects).sort();
  }

  project(id: string): ProjectConfig {
    const project = Object.hasOwn(this.raw.projects, id) ? this.raw.projects[id] : undefined;
    if (project === undefined) {
      throw new UnknownProjectError(id, this.projectIds());
    }
    const projectId = toProjectId(id);
    const defaults = this.raw.defaults.embeddings;
    const override = project.embeddings ?? {};
    const embeddings: EmbeddingsConfig = {
      provider: override.provider ?? defaults.provider,
      host: override.host ?? defaults.host,
      model: override.model ?? defaults.model,
      dimensions: override.dimensions ?? defaults.dimensions,
      queryInstruction: override.queryInstruction ?? defaults.queryInstruction,
      batchSize: override.batchSize ?? defaults.batchSize,
    };
    const dataDir = join(this.resolvePath(this.raw.dataDir), projectId);
    return {
      id: projectId,
      name: project.name,
      root: this.resolvePath(project.root),
      dataDir,
      sqlitePath: join(dataDir, 'md.sqlite'),
      include: project.include,
      exclude: project.exclude,
      maxFileBytes: project.maxFileBytes,
      embeddings,
      qdrant: this.raw.defaults.qdrant,
      knowledge: project.knowledge ?? this.raw.defaults.knowledge,
      collection: collectionNames(projectId, embeddings),
    };
  }

  private resolvePath(value: string): string {
    if (value === '~') {
      return this.paths.homeDir;
    }
    if (value.startsWith('~/')) {
      return join(this.paths.homeDir, value.slice(2));
    }
    return isAbsolute(value) ? resolve(value) : resolve(this.paths.baseDir, value);
  }
}

export function defaultPathContext(configPath: string): PathContext {
  return { baseDir: resolve(configPath, '..'), homeDir: homedir() };
}
