import picomatch from 'picomatch';

const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

/** Markdown notes are the only files ever indexed, whatever the include globs say. */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export type PathMatcher = (projectPath: string) => boolean;

/** Glob matcher on project-relative POSIX paths (dotfiles included). Empty list matches nothing. */
export function globMatcher(globs: readonly string[]): PathMatcher {
  if (globs.length === 0) {
    return () => false;
  }
  return picomatch([...globs], { dot: true });
}
