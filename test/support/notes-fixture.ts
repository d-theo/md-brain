import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let clock = Date.UTC(2026, 0, 1) / 1000;

/** Notes on disk under a temporary project root. */
export class NotesFixture {
  constructor(readonly root: string) {}

  /** Writes a file with a strictly increasing mtime, as an editor would. */
  write(path: string, content: string): void {
    const absolute = join(this.root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    clock += 10;
    utimesSync(absolute, clock, clock);
  }

  remove(path: string): void {
    rmSync(join(this.root, path), { recursive: true, force: true });
  }
}
