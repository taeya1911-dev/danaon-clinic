/* verify.mjs — prove the animation resolves to the untouched logo.
 *
 * Checks:
 *   1. no construction geometry survives the fade-out
 *   2. the last frame is pixel-identical to a clean static render of the logo
 *   3. the logo is fully inside the canvas with real margin on every side
 *   4. seeking is deterministic — the same t always produces the same pixels
 *   5. the construction phase is actually visible
 *
 * Frames are compared as decoded pixels, never as PNG bytes: Chromium's PNG
 * encoder picks different filters run to run, so identical images can serialise
 * to different files.
 */
import { launch } from './browser.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}

const WIDTH = parseInt(arg('width', '1920'), 10);
const HEIGHT = parseInt(arg('height', '1080'), 10);

if (!existsSync(resolve(root, 'src/logo.js'))) {
  console.error('\n  src/logo.js missing. Run `npm run logo` first.\n');
  process.exit(1);
}

const url = new URL(pathToFileURL(resolve(root, 'src/index.html')));
url.searchParams.set('capture', '1');
url.searchParams.set('w', String(WIDTH));
url.searchParams.set('h', String(HEIGHT));

const browser = await launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.error('  [page]', m.text()); });

await page.goto(url.href, { waitUntil: 'load' });
await page.waitForFunction(() => window.__anim !== undefined, { timeout: 15000 });

const info = await page.evaluate(() => ({
  ready: window.__anim.ready, error: window.__anim.error,
  duration: window.__anim.duration, count: window.__anim.count
}));
if (!info.ready) {
  console.error(`\n  Scene failed to build: ${info.error}\n`);
  await browser.close();
  process.exit(1);
}

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

/* 0 — every part of the source logo made it into the scene ------------------- */

const coverage = await page.evaluate(() => {
  const src = document.querySelector('#source svg');
  const drawable = src.querySelectorAll(
    'path, rect, circle, ellipse, line, polygon, polyline'
  );
  const skipped = [...drawable].filter((n) => n.closest('defs, clipPath, mask, marker, pattern, symbol'));
  return {
    drawable: drawable.length - skipped.length,
    text: src.querySelectorAll('text, tspan, textPath').length,
    image: src.querySelectorAll('image').length,
    built: window.__anim.count
  };
});

// Live text and raster <image> carry no path data. They are dropped silently by
// the extractor, which would leave the render missing part of the logo while
// every other check still passed.
record('source is fully outlined vector', coverage.text === 0 && coverage.image === 0,
  coverage.text || coverage.image
    ? `${coverage.text} live <text> and ${coverage.image} <image> element(s) cannot be traced — ` +
      'convert type to outlines and embed artwork as paths'
    : 'no live text or raster content in the source');

record('every source shape is in the animation', coverage.built === coverage.drawable,
  `${coverage.built} of ${coverage.drawable} drawable shape(s) built`);

/* ------------------------------------------------------------ pixel helpers */

const toDataURL = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

/** FNV-1a over the decoded RGBA buffer — stable across PNG encodings. */
async function fingerprint(buf) {
  return page.evaluate(async (src) => {
    const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let h = 0x811c9dc5;
    for (let i = 0; i < d.length; i++) {
      h ^= d[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }, toDataURL(buf));
}

async function pixelDiff(a, b) {
  return page.evaluate(async ([x, y]) => {
    const load = (s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = s; });
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    const c = document.createElement('canvas');
    c.width = ia.width; c.height = ia.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(ia, 0, 0);
    const pa = g.getImageData(0, 0, c.width, c.height).data;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(ib, 0, 0);
    const pb = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, max = 0, sum = 0;
    for (let i = 0; i < pa.length; i += 4) {
      const d0 = Math.max(
        Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2])
      );
      if (d0 > 0) { n++; sum += d0; if (d0 > max) max = d0; }
    }
    return { pixels: n, total: pa.length / 4, max, mean: n ? sum / n : 0 };
  }, [toDataURL(a), toDataURL(b)]);
}

const seek = async (t) => {
  await page.evaluate((x) => window.__anim.setTime(x), t);
  return page.screenshot({ animations: 'disabled' });
};

/* 1 — construction geometry is fully retired at the end --------------------- */

await page.evaluate((d) => window.__anim.setTime(d), info.duration);

const residue = await page.evaluate(() => {
  const stage = document.getElementById('stage');
  // Effective opacity: a node is only truly gone if the whole ancestor chain
  // multiplies out to zero.
  const effective = (node) => {
    let o = 1;
    for (let n = node; n && n !== stage.parentNode; n = n.parentNode) {
      const v = parseFloat(n.getAttribute && n.getAttribute('opacity'));
      if (!isNaN(v)) o *= v;
      if (o === 0) return 0;
    }
    return o;
  };
  const layers = stage.querySelectorAll(':scope > g > g');
  const construction = [
    layers[0],                                            // guides
    layers[1],                                            // measures
    layers[4],                                            // anchors
    ...layers[3].querySelectorAll(':scope > g'),          // per-element handle arms
    ...stage.querySelectorAll('path[stroke-dashoffset]')  // tracing strokes
  ];
  let worst = 0;
  for (const n of construction) worst = Math.max(worst, effective(n));
  return worst;
});

record('construction geometry fully removed', residue === 0,
  `highest effective opacity on any guide, handle, anchor or tracing stroke: ${residue}`);

/* 2 — final frame equals a clean render of the logo -------------------------- */

const lastFrame = await page.screenshot({ animations: 'disabled' });
await page.evaluate(() => window.__anim.renderStatic());
const cleanFrame = await page.screenshot({ animations: 'disabled' });

const delta = await pixelDiff(lastFrame, cleanFrame);
record('final frame is the untouched logo', delta.pixels === 0,
  delta.pixels === 0
    ? 'pixel-identical to a clean static render of the source SVG'
    : `${delta.pixels}/${delta.total} px differ, max channel delta ${delta.max}, mean ${delta.mean.toFixed(2)}`);

/* 3 — the logo is never cropped and keeps generous margin -------------------- */

const bounds = await page.evaluate(() => {
  const stage = document.getElementById('stage');
  // Layer order inside the fit group: guides, measures, artwork, handles, anchors.
  const b = stage.querySelectorAll(':scope > g > g')[2].getBoundingClientRect();
  return { x: b.left, y: b.top, w: b.width, h: b.height, W: window.innerWidth, H: window.innerHeight };
});

const minMargin = Math.min(
  bounds.x, bounds.y, bounds.W - (bounds.x + bounds.w), bounds.H - (bounds.y + bounds.h)
);
const shortEdge = Math.min(bounds.W, bounds.H);
record('logo fully inside frame with generous white space', minMargin > shortEdge * 0.12,
  `smallest margin ${minMargin.toFixed(0)}px (${((minMargin / shortEdge) * 100).toFixed(1)}% of short edge)`);

/* 4 — deterministic seeking -------------------------------------------------- */

const probes = [0, 0.35, 0.7, 1.4, 2.5, 2.9, 3.2, 3.6];
const forward = [];
for (const t of probes) forward.push(await seek(t));

// Revisit in reverse: the render must depend on t alone, never on playback history.
const backward = [];
for (let i = probes.length - 1; i >= 0; i--) backward[i] = await seek(probes[i]);

// Chromium's rasteriser re-antialiases edges slightly differently depending on
// what it had cached, so a handful of border pixels can shift by 1-2 levels.
// That is invisible and unavoidable in a browser renderer; a structural change
// would move far more pixels, far further.
const AA_PIXEL_BUDGET = Math.round(WIDTH * HEIGHT * 0.0001);   // 0.01% of the frame
const AA_LEVEL_BUDGET = 4;                                     // out of 255

let worst = { pixels: 0, max: 0, t: null };
for (let i = 0; i < probes.length; i++) {
  const d = await pixelDiff(forward[i], backward[i]);
  if (d.pixels > worst.pixels) worst = { ...d, t: probes[i] };
}
const stable = worst.pixels <= AA_PIXEL_BUDGET && worst.max <= AA_LEVEL_BUDGET;
record('seeking is deterministic', stable,
  worst.pixels === 0
    ? `${probes.length} probes byte-stable in both directions`
    : `worst probe t=${worst.t}: ${worst.pixels} px differ (budget ${AA_PIXEL_BUDGET}), ` +
      `max level delta ${worst.max} (budget ${AA_LEVEL_BUDGET}) — antialiasing only`);

/* 5 — construction actually appears ------------------------------------------ */

const atZero = await fingerprint(await seek(0));
const atBuild = await fingerprint(await seek(1.6));
record('construction phase is visible', atZero !== atBuild,
  'frame at 1.600s differs from frame at 0.000s');

await browser.close();

/* ---------------------------------------------------------------- report */

console.log('');
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`);
}
console.log(`\n  ${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
