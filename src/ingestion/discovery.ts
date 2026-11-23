import { type Dirent, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../config/project-config.js';
import { globMatcher, isMarkdownPath, type PathMatcher } from './classifier.js';

/** Deeper folders are not walked (guards against pathological trees). */
export const MAX_DEPTH = 16;

/** Folders never walked: version control and editor internals, dependencies. */
const PRUNED_FOLDERS = new Set(['.git', '.hg', '.svn', 'node_modules', '.obsidian', '.trash']);

export interface DiscoveredFile {
  /** Relative to the project root (POSIX separators). */
  readonly path: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export type SkipReason = 'unsupported' | 'too_large' | 'not_a_file';

export interface SkippedFile {
  readonly path: string;
  readonly reason: SkipReason;
}

export interface Discovery {
  readonly files: readonly DiscoveredFile[];
  readonly skipped: readonly SkippedFile[];
}

/**
 * Lists the Markdown notes of a project from the files on disk: the root folder is walked
 * recursively, include/exclude globs are applied to root-relative paths. Content is not read.
 * Symbolic links are never followed (they could point outside of the project).
 */
export class ProjectDiscovery {
  private readonly include: PathMatcher;
  private readonly exclude: PathMatcher;

  constructor(private readonly project: ProjectConfig) {
    this.include = globMatcher(project.include);
    this.exclude = globMatcher(project.exclude);
  }

  async discover(): Promise<Discovery> {
    const files: DiscoveredFile[] = [];
    const skipped: SkippedFile[] = [];
    this.walk('', 0, (path) => {
      if (!this.include(path) || this.exclude(path)) {
        return;
      }
      if (!isMarkdownPath(path)) {
        skipped.push({ path, reason: 'unsupported' });
        return;
      }
      const absolutePath = join(this.project.root, path);
      const stats = lstatSync(absolutePath, { throwIfNoEntry: false });
      if (stats === undefined) {
        return;
      }
      if (!stats.isFile()) {
        skipped.push({ path, reason: 'not_a_file' });
        return;
      }
      if (stats.size > this.project.maxFileBytes) {
        skipped.push({ path, reason: 'too_large' });
        return;
      }
      files.push({ path, absolutePath, size: stats.size, mtimeMs: Math.floor(stats.mtimeMs) });
    });
    return { files, skipped };
  }

  private walk(dir: string, depth: number, visit: (path: string) => void): void {
    for (const entry of this.readDir(join(this.project.root, dir))) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!this.isPruned(entry, path) && depth < MAX_DEPTH) {
          this.walk(path, depth + 1, visit);
        }
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        visit(path);
      }
    }
  }

  private isPruned(entry: Dirent, path: string): boolean {
    return PRUNED_FOLDERS.has(entry.name) || this.exclude(`${path}/`);
  }

  private readDir(absoluteDir: string): Dirent[] {
    return readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
}
