/*
 * reveal.html을 프레임 단위로 찍어 mp4로 묶는다.
 *
 * 브라우저 애니메이션을 화면 녹화하지 않고 프레임을 하나씩 찍는 이유:
 * 녹화는 프레임이 밀리거나 중복되어 "일정하고 기계적인" 타이핑 박자가 흔들린다.
 * drawAt(t)를 t = f/fps로 직접 호출하면 박자가 정확히 스펙대로 나온다.
 */

import { chromium } from 'playwright-core';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const configPath = path.resolve(arg('config', path.join(HERE, 'config.json')));
const specPath = path.resolve(arg('spec', path.join(HERE, 'spec.json')));
const outPath = path.resolve(arg('out', path.join(HERE, 'out', 'logo-reveal.mp4')));
const framesDir = path.resolve(arg('frames', path.join(HERE, 'frames')));

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const r = spawnSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim();
  const w = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (w.status === 0) return w.stdout.trim();
  throw new Error('ffmpeg을 찾을 수 없다. `pip install imageio-ffmpeg` 후 다시 시도하거나 FFMPEG=/path/to/ffmpeg 로 지정한다.');
}

// Playwright 브라우저 경로는 환경마다 버전 접미사가 붙는다. 하드코딩하지 않고 찾는다.
function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(root)) {
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium')).sort().reverse();
    // headless_shell보다 full chromium을 먼저 쓴다. 폰트 렌더링이 실제 브라우저와 같아야 한다.
    const ordered = [...dirs.filter((d) => !d.includes('headless')), ...dirs.filter((d) => d.includes('headless'))];
    for (const d of ordered) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;   // playwright-core의 기본 탐색에 맡긴다
}

function fontDataUrl() {
  const f = cfg.wordmark.fontFile;
  if (!f) return null;
  const abs = path.resolve(HERE, f);
  if (!fs.existsSync(abs)) throw new Error(`fontFile을 찾을 수 없다: ${abs}`);
  const ext = path.extname(abs).toLowerCase();
  const mime = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.otf': 'font/otf', '.ttf': 'font/ttf' }[ext] || 'font/ttf';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

// 타임라인이 스펙과 어긋난 채로 4분짜리 렌더가 돌아가면 시간만 버린다. 먼저 막는다.
function validateSpec() {
  const p = spec.phases;
  const order = ['caret', 'typing', 'settle', 'hold'];
  for (let i = 0; i < order.length; i++) {
    const cur = p[order[i]];
    if (cur.end <= cur.start) throw new Error(`phase ${order[i]}: end가 start보다 뒤여야 한다`);
    if (i > 0 && Math.abs(p[order[i - 1]].end - cur.start) > 1e-9) {
      throw new Error(`phase ${order[i - 1]} → ${order[i]} 사이에 틈이나 겹침이 있다`);
    }
  }
  if (Math.abs(p.hold.end - spec.duration) > 1e-9) throw new Error('마지막 phase가 duration과 맞지 않는다');
  if (Math.abs(p.caret.start) > 1e-9) throw new Error('첫 phase는 0초에서 시작해야 한다');
}

async function main() {
  validateSpec();

  const ffmpeg = findFfmpeg();
  const fps = cfg.canvas.fps;
  const frameCount = Math.round(spec.duration * fps);

  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none'],
  });
  const page = await browser.newPage({
    viewport: { width: cfg.canvas.width, height: cfg.canvas.height },
    deviceScaleFactor: 1,
  });

  await page.goto(pathToFileURL(path.join(HERE, 'reveal.html')).href);

  const metrics = await page.evaluate(
    ([c, s, f]) => window.LR.init(c, s, f),
    [cfg, spec, fontDataUrl()],
  );

  // 요청한 폰트가 실제로 쓰였는지 확인한다. 없는 폰트를 지정하면 브라우저가
  // 조용히 대체 폰트로 그리고, 그러면 "원본 로고와 동일한 자형"이 깨진다.
  const fontOk = await page.evaluate((fam) => document.fonts.check(`200px "${fam}"`), cfg.wordmark.fontFamily);
  if (!fontOk) {
    console.warn(`\n  ⚠  "${cfg.wordmark.fontFamily}" 폰트를 찾지 못했다. 브라우저 대체 폰트로 그려진다.`);
    console.warn(`     로고 자형이 원본과 달라진다. config.json의 fontFile에 실제 폰트 파일을 지정할 것.\n`);
  }

  console.log('워드마크 :', JSON.stringify(metrics.text));
  console.log('글자 수  :', metrics.chars, `(글자당 ${metrics.msPerChar}ms)`);
  console.log('폰트 크기:', metrics.fontSizePx + 'px');
  console.log('워드마크 폭:', metrics.wordmarkWidthPx + 'px', `(화면의 ${(metrics.widthRatio * 100).toFixed(1)}%)`);
  console.log('프레임   :', frameCount, `@ ${fps}fps`);
  console.log('');

  const pad = String(frameCount).length + 1;
  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    await page.evaluate((tt) => window.LR.drawAt(tt), t);
    await page.locator('#c').screenshot({
      path: path.join(framesDir, `f${String(f).padStart(pad, '0')}.png`),
      animations: 'disabled',
    });
    if (f % 30 === 0 || f === frameCount - 1) {
      process.stdout.write(`\r  렌더 ${f + 1}/${frameCount}`);
    }
  }
  process.stdout.write('\n');

  await browser.close();

  execFileSync(ffmpeg, [
    '-y',
    '-framerate', String(fps),
    '-i', path.join(framesDir, `f%0${pad}d.png`),
    '-c:v', 'libx264',
    '-preset', 'veryslow',
    '-crf', '16',
    // 순수 검정 배경 + 얇은 흰 캐럿 조합은 4:2:0에서 뭉개지기 쉽다.
    // 색이 흑백뿐이라 크로마 손실은 없지만 CRF를 낮게 잡아 캐럿 가장자리를 지킨다.
    '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-movflags', '+faststart',
    '-an',
    outPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  if (has('gif')) {
    const gifPath = outPath.replace(/\.mp4$/, '.gif');
    const palette = path.join(framesDir, 'palette.png');
    execFileSync(ffmpeg, ['-y', '-i', outPath, '-vf', 'palettegen=max_colors=32', palette], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync(ffmpeg, ['-y', '-i', outPath, '-i', palette, '-lavfi', 'paletteuse', gifPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log('GIF :', gifPath);
  }

  if (!has('keep-frames')) fs.rmSync(framesDir, { recursive: true, force: true });

  const size = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log('완료 :', outPath, `(${size} KB)`);

  fs.writeFileSync(
    path.join(path.dirname(outPath), 'metrics.json'),
    JSON.stringify({ ...metrics, fps, frameCount, duration: spec.duration }, null, 2),
  );
}

main().catch((e) => { console.error(e.message); process.exit(1); });
