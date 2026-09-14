/**
 * Where sealed reports live: one directory per id under the data root, with
 * the upload as received, the sealed output, and a small JSON record of what
 * was done. Plain files, so a backup is a copy and an inspection is `ls`.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ID_PATTERN } from './links.mjs';

export class Store {
  constructor(root) { this.root = root; }

  /** The directory for an id. Refuses anything that is not an id, so no path can be smuggled in. */
  dirFor(id) {
    if (!ID_PATTERN.test(String(id))) throw new Error('not a report id');
    return path.join(this.root, 'reports', id);
  }

  async save(id, { original, sealed, meta }) {
    const dir = this.dirFor(id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'original.pdf'), original);
    await writeFile(path.join(dir, 'sealed.pdf'), sealed);
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  }

  async meta(id) {
    try {
      return JSON.parse(await readFile(path.join(this.dirFor(id), 'meta.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  sealedPath(id) { return path.join(this.dirFor(id), 'sealed.pdf'); }

  async sealedSize(id) {
    try {
      return (await stat(this.sealedPath(id))).size;
    } catch {
      return null;
    }
  }
}
