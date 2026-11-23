import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toProjectId } from '../../../src/domain/project-id.js';
import { MAX_DEPTH, ProjectDiscovery } from '../../../src/ingestion/discovery.js';
import { NotesFixture } from '../../support/notes-fixture.js';
import { aProjectConfig } from '../../support/project-config.js';

const project = toProjectId('discovery-test');

describe('ProjectDiscovery', () => {
  let fixture: NotesFixture;

  function discover(overrides: Parameters<typeof aProjectConfig>[2] = {}) {
    return new ProjectDiscovery(aProjectConfig(project, fixture.root, overrides)).discover();
  }

  beforeEach(() => {
    fixture = new NotesFixture(mkdtempSync(join(tmpdir(), 'md-discovery-')));
    fixture.write('README.md', '# Notes');
    fixture.write('work/kb.md', '# KB');
    fixture.write('work/Plan.markdown', '# Plan');
    fixture.write('work/SHOUT.MD', '# Globs are case-sensitive');
    fixture.write('work/todo.txt', 'included by the globs but not Markdown');
    fixture.write('work/diagram.png', 'png');
    fixture.write('work/big.md', 'x'.repeat(2_000));
    fixture.write('work/archive/old.md', '# Excluded by glob');
    fixture.write('.git/HEAD', 'ref: refs/heads/main');
    fixture.write('.git/notes.md', '# Inside .git');
    fixture.write('.obsidian/workspace.md', '# Editor state');
    fixture.write('node_modules/lib/README.md', '# Dependency');
    fixture.write('.drafts/idea.md', '# Dotted folders are walked');
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('lists Markdown notes from disk, sorted, with root-relative paths', async () => {
    const { files } = await discover();

    expect(files.map((file) => file.path)).toEqual([
      '.drafts/idea.md',
      'README.md',
      'work/kb.md',
      'work/Plan.markdown',
    ]);
  });

  it('records sizes, mtimes and absolute paths', async () => {
    const { files } = await discover();
    const kb = files.find((file) => file.path === 'work/kb.md');

    expect(kb).toMatchObject({ absolutePath: join(fixture.root, 'work/kb.md'), size: 4 });
    expect(Number.isInteger(kb?.mtimeMs)).toBe(true);
  });

  it('reports non-Markdown, oversized and non-regular files', async () => {
    symlinkSync('/etc/hostname', join(fixture.root, 'work/link.md'));

    const { files, skipped } = await discover();

    expect(files.map((file) => file.path)).not.toContain('work/link.md');
    expect(skipped).toEqual([
      { path: 'work/big.md', reason: 'too_large' },
      { path: 'work/link.md', reason: 'not_a_file' },
      { path: 'work/todo.txt', reason: 'unsupported' },
    ]);
  });

  it('prunes excluded folders and ignores files outside the include globs', async () => {
    const { files, skipped } = await discover({ include: ['work/**'], exclude: ['work/'] });

    expect(files).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('stops walking below the maximum depth', async () => {
    const deep = Array.from({ length: MAX_DEPTH + 1 }, (_, index) => `d${index}`).join('/');
    fixture.write(`${deep}/too-deep.md`, '# Deep');
    fixture.write(`${deep.split('/').slice(0, MAX_DEPTH).join('/')}/deepest.md`, '# Deepest');

    const paths = (await discover()).files.map((file) => file.path);

    expect(paths.some((path) => path.endsWith('deepest.md'))).toBe(true);
    expect(paths.some((path) => path.endsWith('too-deep.md'))).toBe(false);
  });
});
