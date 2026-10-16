import { copyFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../out/', import.meta.url));
let copied = 0;

// Next's Windows export can preserve backslashes in segment request keys,
// creating directories where the browser expects dot-separated filenames.
// Keep the original files and add the portable names within each route.
async function normalizeSegments(route, directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizeSegments(route, source);
    } else if (entry.isFile() && entry.name.endsWith('.txt')) {
      const filename = relative(route, source).split(sep).join('.');
      await copyFile(source, join(route, filename));
      copied += 1;
    }
  }
}

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(directory, entry.name);
    if (entry.name.startsWith('__next.')) {
      await normalizeSegments(directory, child);
    } else {
      await visit(child);
    }
  }
}

await visit(root);
console.log(`Documentation export: normalized ${copied} segment files.`);
