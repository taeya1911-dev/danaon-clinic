/* capture.mjs — deterministic frame capture, then encode.
 *
 * The page is stepped one frame at a time rather than played and recorded, so the
 * output is exact: no dropped frames, no timing jitter, and the clip is always
 * precisely DURATION seconds long.
 */
import { launch } from './browser.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/* ------------------------------------------------------------------ options */

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);

const WIDTH = parseInt(arg('width', '1920'), 10);
const HEIGHT = parseInt(arg('height', '1080'), 10);
const FPS = parseInt(arg('fps', '60'), 10);
const FIT = arg('fit', null);
const SCALE = parseFloat(arg('scale', '1'));       // render at 2 for a supersampled master
const OUT = resolve(root, arg('out', 'out'));
const KEEP = flag('keep-frames');
const FORMAT = arg('format', 'mp4');               // mp4 | webm | png

const framesDir = join(OUT, 'frames');

/* -------------------------------------------------------------------- setup */

if (!existsSync(resolve(root, 'src/logo.js'))) {
  console.error('\n  src/logo.js missing. Run `npm run logo` first.\n');
  process.exit(1);
}

rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

const pageURL = new URL(pathToFileURL(resolve(root, 'src/index.html')));
pageURL.searchParams.set('capture', '1');
pageURL.searchParams.set('w', String(WIDTH));
pageURL.searchParams.set('h', String(HEIGHT));
if (FIT) pageURL.searchParams.set('fit', FIT);

console.log(`  capturing ${WIDTH}x${HEIGHT} @ ${FPS}fps${SCALE !== 1 ? ` (x${SCALE} supersample)` : ''}`);

const browser = await launch();
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: SCALE
});

page.on('console', (m) => { if (m.type() === 'error') console.error('  [page]', m.text()); });

await page.goto(pageURL.href, { waitUntil: 'load' });
await page.waitForFunction(() => window.__anim !== undefined, { timeout: 15000 });

const info = await page.evaluate(() => ({
  ready: window.__anim.ready,
  error: window.__anim.error,
  duration: window.__anim.duration,
  count: window.__anim.count,
  warnings: window.__anim.warnings
}));

if (!info.ready) {
  console.error(`\n  Scene failed to build: ${info.error}\n`);
  await browser.close();
  process.exit(1);
}
for (const w of info.warnings) console.warn(`  ! ${w}`);
console.log(`  ${info.count} logo component(s), ${info.duration.toFixed(3)}s timeline`);

/* ------------------------------------------------------------------ capture */

const totalFrames = Math.round(info.duration * FPS);
const pad = String(totalFrames).length + 1;

for (let f = 0; f < totalFrames; f++) {
  const t = f / FPS;
  await page.evaluate((time) => window.__anim.setTime(time), t);
  await page.screenshot({
    path: join(framesDir, `${String(f).padStart(pad, '0')}.png`),
    animations: 'disabled'
  });
  if (f % 30 === 0 || f === totalFrames - 1) {
    process.stdout.write(`\r  frame ${f + 1}/${totalFrames}`);
  }
}
process.stdout.write('\n');

// A dedicated still of the finished mark, for checking against the reference.
await page.evaluate((d) => window.__anim.setTime(d), info.duration);
await page.screenshot({ path: join(OUT, 'final-frame.png'), animations: 'disabled' });

await browser.close();

const written = readdirSync(framesDir).filter((f) => f.endsWith('.png')).length;
if (written !== totalFrames) {
  console.error(`\n  Expected ${totalFrames} frames, wrote ${written}.\n`);
  process.exit(1);
}

if (FORMAT === 'png') {
  console.log(`\n  ${written} frames in ${framesDir}\n  still: ${join(OUT, 'final-frame.png')}\n`);
  process.exit(0);
}

/* ------------------------------------------------------------------- encode */

const { default: ffmpegPath } = await import('ffmpeg-static');

const outFile = join(OUT, `logo-construction-4s.${FORMAT}`);
const codec = FORMAT === 'webm'
  ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-row-mt', '1']
  : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '15',
     '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

const args = [
  '-y', '-framerate', String(FPS),
  '-i', join(framesDir, `%0${pad}d.png`),
  ...codec,
  '-r', String(FPS),
  // yuv420p needs even dimensions; supersampled masters are scaled back down here.
  '-vf', SCALE !== 1
    ? `scale=${WIDTH}:${HEIGHT}:flags=lanczos`
    : 'scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos',
  outFile
];

await new Promise((res, rej) => {
  const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d.toString(); });
  p.on('close', (code) => code === 0 ? res() : rej(new Error(err.split('\n').slice(-25).join('\n'))));
});

if (!KEEP) rmSync(framesDir, { recursive: true, force: true });

console.log(`\n  video: ${outFile}`);
console.log(`  still: ${join(OUT, 'final-frame.png')}`);
console.log(`  ${totalFrames} frames @ ${FPS}fps = ${(totalFrames / FPS).toFixed(3)}s\n`);
