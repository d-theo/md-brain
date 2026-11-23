import { z } from 'zod';
import { PROJECT_ID_PATTERN } from '../domain/project-id.js';

const globList = z.array(z.string().min(1));

export const embeddingsSchema = z.strictObject({
  provider: z.literal('ollama'),
  host: z.url({ protocol: /^https?$/ }),
  model: z.string().min(1),
  dimensions: z.int().positive().max(8192),
  /** Prepended to queries only (Qwen3-Embedding: `Instruct: {task}\nQuery:{query}`). */
  queryInstruction: z.string().min(1),
  batchSize: z.int().positive().max(512).default(32),
});

export const qdrantSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
});

export const knowledgeSchema = z
  .strictObject({
    duplicateThreshold: z.number().gt(0).max(1),
    similarThreshold: z.number().gt(0).max(1),
  })
  .refine((value) => value.similarThreshold < value.duplicateThreshold, {
    message: 'similarThreshold must be lower than duplicateThreshold',
  });

export const projectSchema = z.strictObject({
  name: z.string().min(1),
  /** Folder holding the Markdown notes (walked recursively). */
  root: z.string().min(1),
  /** Globs relative to root; only Markdown files (`.md`, `.markdown`) are ever indexed. */
  include: globList.min(1).default(['**/*.md', '**/*.markdown']),
  exclude: globList.default([]),
  /** Larger files are skipped (generated or vendored content). */
  maxFileBytes: z
    .int()
    .positive()
    .default(512 * 1024),
  embeddings: embeddingsSchema
    .partial()
    .refine((value) => value.model === undefined || value.dimensions !== undefined, {
      message: 'overriding the embedding model requires its dimensions',
      path: ['dimensions'],
    })
    .optional(),
  knowledge: knowledgeSchema.optional(),
});

export const configSchema = z.strictObject({
  dataDir: z.string().min(1),
  defaults: z.strictObject({
    embeddings: embeddingsSchema,
    qdrant: qdrantSchema,
    knowledge: knowledgeSchema,
  }),
  projects: z
    .record(z.string().regex(PROJECT_ID_PATTERN), projectSchema)
    .refine((projects) => Object.keys(projects).length > 0, {
      message: 'at least one project is required',
    }),
});

export type RawConfig = z.infer<typeof configSchema>;
export type EmbeddingsConfig = z.infer<typeof embeddingsSchema>;
export type QdrantConfig = z.infer<typeof qdrantSchema>;
export type KnowledgeConfig = z.infer<typeof knowledgeSchema>;
