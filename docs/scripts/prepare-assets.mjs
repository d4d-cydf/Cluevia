import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Keep the documentation's downloads, fonts and identity tied to the actual app.
const destination = new URL('../public/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const asset of ['brand', 'fonts', 'examples']) {
  await cp(new URL(`../../public/${asset}`, destination), new URL(asset, destination), { recursive: true });
}
console.log(`Cluevia assets synced to ${fileURLToPath(destination)}`);
