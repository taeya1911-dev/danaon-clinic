/* preview.mjs — print the local URL of the player. */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page = resolve(root, 'src/index.html');

if (!existsSync(resolve(root, 'src/logo.js'))) {
  console.error('\n  src/logo.js missing. Run `npm run logo` first.\n');
  process.exit(1);
}

console.log('\n  Open this in a browser:\n');
console.log('    ' + pathToFileURL(page).href + '\n');
console.log('  Space plays/pauses, arrow keys step one frame.\n');
