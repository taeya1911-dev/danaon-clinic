# Logo construction animation — 4.000s

A premium vector-construction reveal, generated from a logo's **own path data**.
Guides, anchor points, Bézier handles and alignment marks are all read out of the
SVG, so nothing is invented and the last frame is the untouched logo.

> **The logo currently in this folder is a placeholder.** `logo.svg` is a copy of
> `logo.placeholder.svg` — a generic set of shapes, not anyone's brand. Replace it
> with the real artwork (see below) before rendering anything for use.

## Quick start

```bash
npm install
cp /path/to/your-logo.svg logo.svg
npm run logo        # inline the SVG so the player can read it offline
npm run preview     # prints a file:// URL — open it, press Space
npm run verify      # prove the animation resolves to the untouched logo
npm run render      # out/logo-construction-4s.mp4 + out/final-frame.png
```

## What the logo file must be

- **A real vector SVG.** A PNG or JPEG traced by hand is a redraw, not the logo.
- **Type converted to outlines.** Live `<text>` has no path data, so it cannot be
  traced, and it will not render identically on a machine without the font.
  `npm run logo` warns if it finds any.
- **Self-contained.** No external images, fonts or stylesheets — the renderer is
  offline. Embedded gradients, `fill-rule`, opacity and strokes are all preserved.

Everything else — colours, curves, kerning, spacing, stroke weights, negative
space — is used exactly as authored. The pipeline never redraws geometry; it only
reveals it.

## The 4-second timeline

| Time | What happens |
|---|---|
| 0.00–0.70 | Alignment guides sweep in, anchor points register, dimension marks on the logo's own bounding box appear. |
| 0.70–2.50 | Each component's outline traces in. Bézier handles bloom just ahead of the stroke and retract behind it. Major shapes first, then smaller detail and typography left-to-right. |
| 2.50–3.20 | Original colours wipe in per component; each locks the last few pixels into position. |
| 3.20–4.00 | All construction geometry fades out. Clean hold on the finished logo. |

Motion uses only non-overshooting curves — no bounce, elastic or settle-back.

### Geometry is derived, never invented

- **Anchors** are real on-curve points. Quadratics and arcs are converted to
  cubics first, so every curve carries genuine control points.
- **Handles** are the actual Bézier control arms of those curves.
- **Alignment guides** appear only where two or more components genuinely share
  an edge or centre line, plus the logo's own bounding box and centre cross.
- **Radial marks** appear only for components that are actually circular — every
  anchor within 4% of the same radius from the centroid.

No golden-ratio overlays, no forced grids, no circles the logo does not contain.

## Two details worth knowing

**Colour arrives by clip, not by fade.** If a logo has a knockout — a white
counter over a dark shape, a ring, the hole in an "o" — fading opacity would show
the shape underneath through the half-opaque fill, putting colours on screen that
the logo does not contain. A clip wipe only ever reveals final-colour pixels.
Counters are also timed with the shape they knock out of, so a ring never flashes
as a solid disc.

**Build order does not change paint order.** Components are *drawn* largest-first
so the construction reads logically, but they are *stacked* exactly as the source
SVG orders them. Overlapping artwork therefore composites correctly and the final
frame is the reference logo rather than a re-layered version of it.

## Rendering

```bash
npm run render                                  # 1920x1080 mp4, 60fps
npm run render:square                           # 1080x1080
npm run render:master                           # 2x supersampled, keeps frames
npm run render:frames                           # PNG sequence only
node scripts/capture.mjs --width=1080 --height=1920 --fps=30 --format=webm
```

Options: `--width --height --fps --scale --fit --format (mp4|webm|png) --out --keep-frames`.

`--fit` is the largest fraction of each canvas axis the logo may occupy (default
`0.62`). Lower it for more white space; the logo is never cropped either way.

Frames are captured by stepping the page one frame at a time rather than by
recording playback, so a 4-second clip is always exactly `4.000s` — 240 frames at
60fps, none dropped, no timing jitter.

## What `npm run verify` checks

1. No construction geometry survives the fade-out (effective opacity is exactly 0).
2. The final frame is **pixel-identical** to a clean static render of the source SVG.
3. The logo sits fully inside the frame with a wide margin on every side.
4. Seeking is deterministic — the same `t` always produces the same pixels,
   whether reached forwards or backwards.
5. The construction phase is actually visible.

Check 4 allows a few pixels of antialiasing drift (budget: 0.01% of the frame, ≤4
levels). Chromium re-antialiases edges slightly differently depending on what it
had cached; a structural change would move far more pixels, far further.

Frames are compared as **decoded pixels, never as PNG bytes** — Chromium's PNG
encoder picks different filters run to run, so identical images can serialise to
different files.

## Layout

```
logo.svg                  the reference logo — replace this
logo.placeholder.svg      generic stand-in, safe to delete once the real logo is in
src/geometry.js           SVG -> paths, anchors, handles, guides, build order
src/timeline.js           the 4s spec as a pure function of t
src/scene.js              builds the layered stage and applies timeline state
src/player.js             mounts the scene, exposes the seek API, preview HUD
src/index.html            the stage
scripts/build-logo.mjs    logo.svg -> src/logo.js
scripts/capture.mjs       deterministic frame capture + encode
scripts/verify.mjs        the checks above
scripts/browser.mjs       resolves a local Chromium instead of downloading one
```

There is no bundler and no CSS animation. Every visual property is computed from
`t` alone, which is what makes preview, verification and export agree.

## Tuning

Most adjustments are one number in `CONFIG` at the top of `src/scene.js` — stroke
weights, anchor size, guide colours, how far a component travels as it locks in.
Phase boundaries and easing live in `PHASE` and `EASE` at the top of
`src/timeline.js`. Changing a phase boundary changes only that phase; the total
stays 4.000s unless you change `DURATION`.
