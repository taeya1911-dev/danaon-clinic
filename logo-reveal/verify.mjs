/*
 * 렌더된 mp4를 브리프의 제약과 대조한다.
 *
 * reveal.html의 로직이 아니라 "실제로 인코딩된 결과물"을 검사한다.
 * 폰트를 바꾸거나 자간을 만지면 조용히 깨지는 것들 — 잘림, 중앙 정렬 틀어짐,
 * 타이핑 중 글자 밀림 — 을 잡는 게 목적이다.
 *
 * 사용: node verify.mjs [--in out/logo-reveal.mp4]
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const videoPath = path.resolve(arg('in', path.join(HERE, 'out', 'logo-reveal.mp4')));
const spec = JSON.parse(fs.readFileSync(path.resolve(arg('spec', path.join(HERE, 'spec.json'))), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.resolve(arg('config', path.join(HERE, 'config.json'))), 'utf8'));

function ffmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const r = spawnSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim();
  return 'ffmpeg';
}

// 분석 해상도. 원본 1920 기준으로 1픽셀 = 2픽셀이라 정렬·여백 판정에는 충분하고,
// 240프레임을 통째로 메모리에 올리지 않아도 된다.
const AW = 960, AH = 540;
const SCALE = cfg.canvas.width / AW;

const INK = 110;   // 글자/커서로 칠 임계값
const BG_MAX = 6;  // 배경이 순수 검정인지 볼 때 허용할 최대값 (인코딩 잡음 여유)

function decodeFrames(onFrame) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg(), [
      '-v', 'error', '-i', videoPath,
      '-vf', `scale=${AW}:${AH}:flags=area`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const frameSize = AW * AH;
    let buf = Buffer.alloc(0);
    let n = 0;
    let err = '';

    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= frameSize) {
        onFrame(n++, buf.subarray(0, frameSize));
        buf = buf.subarray(frameSize);
      }
    });
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg 실패: ${err}`));
      resolve(n);
    });
  });
}

function analyze(px) {
  let ink = 0, minX = AW, maxX = -1, minY = AH, maxY = -1, borderMax = 0;
  const bx = Math.floor(AW * 0.05), by = Math.floor(AH * 0.05);

  for (let y = 0; y < AH; y++) {
    const row = y * AW;
    const inBorderRow = y < by || y >= AH - by;
    for (let x = 0; x < AW; x++) {
      const v = px[row + x];
      if (v >= INK) {
        ink++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (inBorderRow || x < bx || x >= AW - bx) {
        if (v > borderMax) borderMax = v;
      }
    }
  }
  return { ink, minX, maxX, minY, maxY, borderMax, empty: maxX < 0 };
}

const results = [];
function check(name, pass, detail) { results.push({ name, pass, detail }); }

async function main() {
  if (!fs.existsSync(videoPath)) {
    console.error(`영상이 없다: ${videoPath}\n먼저 node render.mjs 를 돌린다.`);
    process.exit(1);
  }

  const fps = cfg.canvas.fps;
  const frames = [];
  const total = await decodeFrames((i, px) => { frames[i] = analyze(px); });

  const expected = Math.round(spec.duration * fps);
  check('길이 = 4.0초', total === expected, `${total}프레임 (기대 ${expected}) = ${(total / fps).toFixed(3)}초`);

  const at = (t) => frames[Math.min(total - 1, Math.floor(t * fps))];
  const range = (a, b) => frames.slice(Math.floor(a * fps), Math.min(total, Math.ceil(b * fps)));

  // 1. 배경은 순수 검정이어야 한다. 글로우/그라데이션/스캔라인이 끼면 여기서 걸린다.
  const worstBorder = Math.max(...frames.map((f) => f.borderMax));
  check('배경 순수 검정 (테두리 5%)', worstBorder <= BG_MAX, `최대 휘도 ${worstBorder}/255`);

  // 2. 0초 시점: 캐럿만 있고 글자는 없다.
  const f0 = frames[0];
  const caretW = Math.max(cfg.cursor.widthEm * 200, cfg.cursor.minWidthPx) / SCALE;
  check('0.0초 = 캐럿 하나만', !f0.empty && (f0.maxX - f0.minX + 1) <= caretW * 3,
    f0.empty ? '화면이 비어 있다' : `폭 ${f0.maxX - f0.minX + 1}px`);

  // 3. 캐럿이 실제로 깜빡이는지. 0-0.6초 안에 켜짐과 꺼짐이 모두 있어야 한다.
  const caretFrames = range(spec.phases.caret.start, spec.phases.caret.end);
  const anyOn = caretFrames.some((f) => !f.empty);
  const anyOff = caretFrames.some((f) => f.empty);
  check('0.0-0.6초 캐럿 깜빡임', anyOn && anyOff, `켜짐 ${caretFrames.filter(f => !f.empty).length} / 꺼짐 ${caretFrames.filter(f => f.empty).length} 프레임`);

  // 4. 타이핑은 왼쪽에서 오른쪽으로만 자란다. 오른쪽 끝이 뒤로 물러나면
  //    글자가 사라졌거나 다시 정렬된 것이다.
  const typing = range(spec.phases.typing.start, spec.phases.typing.end).filter((f) => !f.empty);
  let regress = 0;
  for (let i = 1; i < typing.length; i++) if (typing[i].maxX < typing[i - 1].maxX - 1) regress++;
  check('타이핑은 좌→우 단조 증가', regress === 0, `되돌아간 프레임 ${regress}개`);

  // 5. 이미 찍힌 글자는 움직이지 않는다 (= 왼쪽 끝 고정).
  //    매 프레임 가운데 정렬을 다시 하면 왼쪽 끝이 계속 왼쪽으로 밀린다.
  //    캐럿만 떠 있는 프레임은 제외한다. 캐럿은 글자 칸의 왼쪽 끝에 서고 글자는
  //    사이드베어링만큼 안쪽에서 시작하므로, 둘을 섞으면 밀리지 않았는데 밀린 것으로 나온다.
  const glyphFrames = typing.filter((f) => (f.maxX - f.minX + 1) > caretW * 3);
  const lefts = glyphFrames.map((f) => f.minX);
  const leftDrift = Math.max(...lefts) - Math.min(...lefts);
  check('글자 밀림 없음 (왼쪽 끝 고정)', leftDrift <= 2, `왼쪽 끝 이동 ${(leftDrift * SCALE).toFixed(1)}px (원본 기준)`);

  // 6. 2.8초에 워드마크가 완성되어 있다.
  const done = at(spec.phases.settle.start + 0.01);
  const last = frames[total - 1];
  check('2.8초에 워드마크 완성', Math.abs(done.maxX - Math.max(done.maxX, last.maxX)) <= caretW * 3 && done.maxX >= last.maxX - 2,
    `2.8초 오른쪽 끝 ${done.maxX}, 최종 ${last.maxX}`);

  // 7. 마무리 구간에서 캐럿이 두 번 깜빡인다: 켜짐 구간이 정확히 2개.
  const settle = range(spec.phases.settle.start, spec.phases.settle.end);
  const textRight = last.maxX;                       // 캐럿 없는 최종 상태의 오른쪽 끝
  const caretOn = settle.map((f) => f.maxX > textRight + 1);
  let bursts = 0;
  for (let i = 0; i < caretOn.length; i++) if (caretOn[i] && !caretOn[i - 1]) bursts++;
  check('2.8-3.4초 캐럿 깜빡임 후 사라짐', bursts === spec.settle.blinkCount && !caretOn[caretOn.length - 1],
    `깜빡임 ${bursts}회, 끝에서 ${caretOn[caretOn.length - 1] ? '남아 있음' : '사라짐'}`);

  // 8. 홀드 구간은 완전히 정지. 카메라 움직임/흔들림/전환이 있으면 여기서 걸린다.
  const hold = range(spec.phases.hold.start, spec.duration);
  const ref = hold[0];
  const frozen = hold.every((f) => f.minX === ref.minX && f.maxX === ref.maxX && f.minY === ref.minY && f.maxY === ref.maxY && Math.abs(f.ink - ref.ink) <= 2);
  check('3.4-4.0초 완전 정지 (락오프)', frozen, `${hold.length}프레임`);

  // 9. 최종 워드마크가 가운데 정렬. 캐럿이 사라진 뒤의 글자만으로 판정한다.
  const center = (last.minX + last.maxX + 1) / 2;
  const off = Math.abs(center - AW / 2) * SCALE;
  check('최종 워드마크 가운데 정렬', off <= 4, `중심에서 ${off.toFixed(1)}px 벗어남 (원본 기준)`);

  // 10. 절대 잘리지 않고 여백이 넉넉해야 한다.
  const marginL = last.minX, marginR = AW - 1 - last.maxX;
  const marginT = last.minY, marginB = AH - 1 - last.maxY;
  const minMargin = Math.min(marginL, marginR);
  check('좌우 여백 확보 (잘림 없음)', minMargin >= AW * 0.08,
    `좌 ${(marginL * SCALE).toFixed(0)}px / 우 ${(marginR * SCALE).toFixed(0)}px (화면의 ${(minMargin / AW * 100).toFixed(1)}%)`);
  check('상하 여백 확보', Math.min(marginT, marginB) >= AH * 0.08,
    `상 ${(marginT * SCALE).toFixed(0)}px / 하 ${(marginB * SCALE).toFixed(0)}px`);

  // 결과
  console.log('');
  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}\n       ${r.detail}`);
  }
  console.log('');
  console.log(failed === 0 ? `  통과 ${results.length}/${results.length}` : `  실패 ${failed}/${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
