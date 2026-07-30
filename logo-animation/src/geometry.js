/* geometry.js — turn an SVG logo into the construction geometry the animation draws.
 *
 * Everything here is derived from the logo's own path data. Nothing is invented:
 * anchors are real on-curve points, handles are real control points, and a guide
 * is only emitted when two or more parts of the logo actually line up on it.
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /* ---------------------------------------------------------------- path parsing */

  var ARG_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

  function tokenize(d) {
    var re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
    var out = [], m;
    while ((m = re.exec(d)) !== null) {
      out.push(m[1] !== undefined ? m[1] : parseFloat(m[2]));
    }
    return out;
  }

  // Endpoint-parameterised arc -> one or more cubics. Standard SVG 1.1 F.6 conversion.
  function arcToCubic(x0, y0, rx, ry, angleDeg, largeArc, sweep, x, y) {
    if (rx === 0 || ry === 0) return [[x0, y0, x, y, x, y]];

    var rad = (angleDeg * Math.PI) / 180;
    var cosA = Math.cos(rad), sinA = Math.sin(rad);
    var dx2 = (x0 - x) / 2, dy2 = (y0 - y) / 2;
    var x1 = cosA * dx2 + sinA * dy2;
    var y1 = -sinA * dx2 + cosA * dy2;

    rx = Math.abs(rx); ry = Math.abs(ry);
    // Scale radii up if they are too small to span the endpoints.
    var lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) { var s = Math.sqrt(lambda); rx *= s; ry *= s; }

    var sq = (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) /
             (rx * rx * y1 * y1 + ry * ry * x1 * x1);
    sq = sq < 0 ? 0 : sq;
    var coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(sq);
    var cx1 = (coef * rx * y1) / ry;
    var cy1 = (-coef * ry * x1) / rx;

    var cx = cosA * cx1 - sinA * cy1 + (x0 + x) / 2;
    var cy = sinA * cx1 + cosA * cy1 + (y0 + y) / 2;

    function angleOf(ux, uy, vx, vy) {
      var dot = ux * vx + uy * vy;
      var len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
      var a = Math.acos(Math.max(-1, Math.min(1, dot / (len || 1e-12))));
      return ux * vy - uy * vx < 0 ? -a : a;
    }

    var theta = angleOf(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    var delta = angleOf((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    if (sweep && delta < 0) delta += 2 * Math.PI;

    // Keep each cubic under a quarter turn so the approximation stays tight.
    var segs = Math.ceil(Math.abs(delta / (Math.PI / 2)));
    var step = delta / segs;
    var t = (4 / 3) * Math.tan(step / 4);
    var result = [];
    var px = x0, py = y0;

    for (var i = 0; i < segs; i++) {
      var a1 = theta + i * step, a2 = a1 + step;
      var cos1 = Math.cos(a1), sin1 = Math.sin(a1);
      var cos2 = Math.cos(a2), sin2 = Math.sin(a2);

      var e1x = cosA * rx * cos1 - sinA * ry * sin1 + cx;
      var e1y = sinA * rx * cos1 + cosA * ry * sin1 + cy;
      var e2x = cosA * rx * cos2 - sinA * ry * sin2 + cx;
      var e2y = sinA * rx * cos2 + cosA * ry * sin2 + cy;

      var d1x = t * (-cosA * rx * sin1 - sinA * ry * cos1);
      var d1y = t * (-sinA * rx * sin1 + cosA * ry * cos1);
      var d2x = t * (cosA * rx * sin2 + sinA * ry * cos2);
      var d2y = t * (sinA * rx * sin2 - cosA * ry * cos2);

      result.push([e1x + d1x, e1y + d1y, e2x + d2x, e2y + d2y, e2x, e2y]);
      px = e2x; py = e2y;
    }
    void px; void py;
    return result;
  }

  /**
   * Normalise any path `d` to absolute M / L / C / Z segments.
   * Quadratics become cubics and arcs become cubics, so every curve in the
   * result carries genuine Bezier control points we can draw handles for.
   */
  function normalizePath(d) {
    var tok = tokenize(d);
    var segs = [];
    var i = 0, cmd = null;
    var cx = 0, cy = 0;      // current point
    var sx = 0, sy = 0;      // subpath start
    var lastC = null;        // previous cubic control2 (for S)
    var lastQ = null;        // previous quadratic control (for T)

    while (i < tok.length) {
      if (typeof tok[i] === 'string') { cmd = tok[i]; i++; }
      else if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';

      var up = cmd.toUpperCase();
      var rel = cmd !== up;
      var n = ARG_COUNT[up];
      var a = tok.slice(i, i + n);
      i += n;

      var isCurve = false;

      switch (up) {
        case 'M': {
          cx = rel ? cx + a[0] : a[0];
          cy = rel ? cy + a[1] : a[1];
          sx = cx; sy = cy;
          segs.push({ type: 'M', p: [cx, cy] });
          break;
        }
        case 'L': {
          cx = rel ? cx + a[0] : a[0];
          cy = rel ? cy + a[1] : a[1];
          segs.push({ type: 'L', p: [cx, cy] });
          break;
        }
        case 'H': {
          cx = rel ? cx + a[0] : a[0];
          segs.push({ type: 'L', p: [cx, cy] });
          break;
        }
        case 'V': {
          cy = rel ? cy + a[0] : a[0];
          segs.push({ type: 'L', p: [cx, cy] });
          break;
        }
        case 'C': {
          var c1 = [rel ? cx + a[0] : a[0], rel ? cy + a[1] : a[1]];
          var c2 = [rel ? cx + a[2] : a[2], rel ? cy + a[3] : a[3]];
          var pC = [rel ? cx + a[4] : a[4], rel ? cy + a[5] : a[5]];
          segs.push({ type: 'C', c1: c1, c2: c2, p: pC });
          cx = pC[0]; cy = pC[1]; lastC = c2; isCurve = true;
          break;
        }
        case 'S': {
          var rc1 = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy];
          var rc2 = [rel ? cx + a[0] : a[0], rel ? cy + a[1] : a[1]];
          var pS = [rel ? cx + a[2] : a[2], rel ? cy + a[3] : a[3]];
          segs.push({ type: 'C', c1: rc1, c2: rc2, p: pS });
          cx = pS[0]; cy = pS[1]; lastC = rc2; isCurve = true;
          break;
        }
        case 'Q': {
          var q = [rel ? cx + a[0] : a[0], rel ? cy + a[1] : a[1]];
          var pQ = [rel ? cx + a[2] : a[2], rel ? cy + a[3] : a[3]];
          segs.push(quadToCubic(cx, cy, q, pQ));
          cx = pQ[0]; cy = pQ[1]; lastQ = q; isCurve = true;
          break;
        }
        case 'T': {
          var rq = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
          var pT = [rel ? cx + a[0] : a[0], rel ? cy + a[1] : a[1]];
          segs.push(quadToCubic(cx, cy, rq, pT));
          cx = pT[0]; cy = pT[1]; lastQ = rq; isCurve = true;
          break;
        }
        case 'A': {
          var ax = rel ? cx + a[5] : a[5];
          var ay = rel ? cy + a[6] : a[6];
          var cubics = arcToCubic(cx, cy, a[0], a[1], a[2], !!a[3], !!a[4], ax, ay);
          for (var k = 0; k < cubics.length; k++) {
            var cu = cubics[k];
            segs.push({ type: 'C', c1: [cu[0], cu[1]], c2: [cu[2], cu[3]], p: [cu[4], cu[5]] });
          }
          cx = ax; cy = ay; isCurve = true;
          break;
        }
        case 'Z': {
          segs.push({ type: 'Z' });
          cx = sx; cy = sy;
          break;
        }
      }

      if (!isCurve) { lastC = null; lastQ = null; }
      if (up !== 'C' && up !== 'S') lastC = null;
      if (up !== 'Q' && up !== 'T') lastQ = null;
    }

    return segs;
  }

  function quadToCubic(x0, y0, q, p) {
    return {
      type: 'C',
      c1: [x0 + (2 / 3) * (q[0] - x0), y0 + (2 / 3) * (q[1] - y0)],
      c2: [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])],
      p: [p[0], p[1]]
    };
  }

  function segmentsToD(segs) {
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.type === 'M') out.push('M' + s.p[0] + ' ' + s.p[1]);
      else if (s.type === 'L') out.push('L' + s.p[0] + ' ' + s.p[1]);
      else if (s.type === 'C') out.push('C' + s.c1[0] + ' ' + s.c1[1] + ' ' + s.c2[0] + ' ' + s.c2[1] + ' ' + s.p[0] + ' ' + s.p[1]);
      else out.push('Z');
    }
    return out.join(' ');
  }

  /* ------------------------------------------------- primitive shapes -> path d */

  function shapeToPathD(el) {
    var t = el.tagName.toLowerCase();
    var f = function (name, dflt) {
      var v = parseFloat(el.getAttribute(name));
      return isNaN(v) ? (dflt || 0) : v;
    };

    if (t === 'path') return el.getAttribute('d') || '';

    if (t === 'rect') {
      var x = f('x'), y = f('y'), w = f('width'), h = f('height');
      var rx = el.hasAttribute('rx') ? f('rx') : (el.hasAttribute('ry') ? f('ry') : 0);
      var ry = el.hasAttribute('ry') ? f('ry') : rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (!rx && !ry) {
        return 'M' + x + ' ' + y + 'H' + (x + w) + 'V' + (y + h) + 'H' + x + 'Z';
      }
      return 'M' + (x + rx) + ' ' + y +
        'H' + (x + w - rx) + 'A' + rx + ' ' + ry + ' 0 0 1 ' + (x + w) + ' ' + (y + ry) +
        'V' + (y + h - ry) + 'A' + rx + ' ' + ry + ' 0 0 1 ' + (x + w - rx) + ' ' + (y + h) +
        'H' + (x + rx) + 'A' + rx + ' ' + ry + ' 0 0 1 ' + x + ' ' + (y + h - ry) +
        'V' + (y + ry) + 'A' + rx + ' ' + ry + ' 0 0 1 ' + (x + rx) + ' ' + y + 'Z';
    }

    if (t === 'circle' || t === 'ellipse') {
      var cxv = f('cx'), cyv = f('cy');
      var rxv = t === 'circle' ? f('r') : f('rx');
      var ryv = t === 'circle' ? f('r') : f('ry');
      return 'M' + (cxv - rxv) + ' ' + cyv +
        'A' + rxv + ' ' + ryv + ' 0 1 0 ' + (cxv + rxv) + ' ' + cyv +
        'A' + rxv + ' ' + ryv + ' 0 1 0 ' + (cxv - rxv) + ' ' + cyv + 'Z';
    }

    if (t === 'line') {
      return 'M' + f('x1') + ' ' + f('y1') + 'L' + f('x2') + ' ' + f('y2');
    }

    if (t === 'polygon' || t === 'polyline') {
      var pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return '';
      var d = 'M' + pts[0] + ' ' + pts[1];
      for (var i = 2; i < pts.length - 1; i += 2) d += 'L' + pts[i] + ' ' + pts[i + 1];
      return d + (t === 'polygon' ? 'Z' : '');
    }

    return '';
  }

  /* --------------------------------------------------------------- extraction */

  var DRAWABLE = ['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline'];

  function matrixOf(el, root) {
    // Flatten any ancestor transforms into the element's own coordinates.
    var ctm = el.getScreenCTM();
    var rootCtm = root.getScreenCTM();
    if (!ctm || !rootCtm) return null;
    return rootCtm.inverse().multiply(ctm);
  }

  function applyMatrix(m, x, y) {
    if (!m) return [x, y];
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  }

  function transformSegments(segs, m) {
    if (!m) return segs;
    return segs.map(function (s) {
      if (s.type === 'Z') return s;
      var o = { type: s.type, p: applyMatrix(m, s.p[0], s.p[1]) };
      if (s.type === 'C') {
        o.c1 = applyMatrix(m, s.c1[0], s.c1[1]);
        o.c2 = applyMatrix(m, s.c2[0], s.c2[1]);
      }
      return o;
    });
  }

  function resolvedPaint(el, prop) {
    var v = el.getAttribute(prop);
    if (v === null || v === '') {
      var cs = global.getComputedStyle(el);
      v = cs.getPropertyValue(prop);
    }
    return (v || '').trim();
  }

  /**
   * Walk a live, in-document <svg> and pull out one record per drawable element.
   * The SVG must be rendered (not display:none) so getBBox/getScreenCTM work.
   */
  function extract(svgRoot) {
    var els = [];
    var warnings = [];

    var textNodes = svgRoot.querySelectorAll('text, tspan, textPath');
    if (textNodes.length) {
      warnings.push(
        'The logo contains ' + textNodes.length + ' live <text> element(s). Live text has no ' +
        'path data, so it cannot be traced and will not render identically without the font. ' +
        'Convert type to outlines before exporting the SVG.'
      );
    }

    var candidates = svgRoot.querySelectorAll(DRAWABLE.join(','));

    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el.closest('defs, clipPath, mask, marker, pattern, symbol')) continue;

      var d = shapeToPathD(el);
      if (!d) continue;

      var m = matrixOf(el, svgRoot);
      var segs = transformSegments(normalizePath(d), m);
      if (!segs.length) continue;

      var flatD = segmentsToD(segs);

      // Measure via a throwaway path so bbox/length reflect the flattened geometry.
      var probe = document.createElementNS(SVG_NS, 'path');
      probe.setAttribute('d', flatD);
      svgRoot.appendChild(probe);
      var bbox, length;
      try {
        bbox = probe.getBBox();
        length = probe.getTotalLength();
      } catch (e) {
        svgRoot.removeChild(probe);
        continue;
      }
      svgRoot.removeChild(probe);

      if (!isFinite(length) || length <= 0) continue;

      var fill = resolvedPaint(el, 'fill');
      var stroke = resolvedPaint(el, 'stroke');

      els.push({
        index: els.length,
        tag: el.tagName.toLowerCase(),
        d: flatD,
        segments: segs,
        bbox: { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height },
        area: bbox.width * bbox.height,
        length: length,
        fill: fill === 'none' ? null : (fill || '#000000'),
        stroke: stroke === 'none' ? null : (stroke || null),
        strokeWidth: parseFloat(resolvedPaint(el, 'stroke-width')) || 1,
        fillOpacity: parseFloat(resolvedPaint(el, 'fill-opacity')),
        opacity: parseFloat(resolvedPaint(el, 'opacity')),
        fillRule: resolvedPaint(el, 'fill-rule') || 'nonzero',
        source: el
      });
    }

    return { elements: els, warnings: warnings };
  }

  /* ------------------------------------------------------- derived construction */

  function anchorsOf(el) {
    var out = [], seen = {};
    for (var i = 0; i < el.segments.length; i++) {
      var s = el.segments[i];
      if (s.type === 'Z') continue;
      var key = s.p[0].toFixed(2) + ',' + s.p[1].toFixed(2);
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({ x: s.p[0], y: s.p[1] });
    }
    return out;
  }

  function handlesOf(el) {
    var out = [];
    var prev = null;
    for (var i = 0; i < el.segments.length; i++) {
      var s = el.segments[i];
      if (s.type === 'C' && prev) {
        out.push({ ax: prev[0], ay: prev[1], hx: s.c1[0], hy: s.c1[1] });
        out.push({ ax: s.p[0], ay: s.p[1], hx: s.c2[0], hy: s.c2[1] });
      }
      if (s.type !== 'Z') prev = s.p;
    }
    return out;
  }

  /** Overall bbox across every element. */
  function unionBBox(els) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < els.length; i++) {
      var b = els[i].bbox;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * Alignment guides the logo actually implies.
   *
   * A vertical or horizontal guide is emitted only where two or more elements
   * share an edge or centre line within `tol`. Nothing is placed on a grid or a
   * ratio the logo does not itself contain.
   */
  function alignmentGuides(els, frame, tol) {
    tol = tol || Math.max(frame.w, frame.h) * 0.006;

    function collect(getter) {
      var raw = [];
      for (var i = 0; i < els.length; i++) {
        var vals = getter(els[i].bbox);
        for (var j = 0; j < vals.length; j++) raw.push({ v: vals[j], el: i });
      }
      raw.sort(function (a, b) { return a.v - b.v; });

      var clusters = [];
      for (var k = 0; k < raw.length; k++) {
        var last = clusters[clusters.length - 1];
        if (last && Math.abs(raw[k].v - last.mean) <= tol) {
          last.items.push(raw[k]);
          last.mean = last.items.reduce(function (s, it) { return s + it.v; }, 0) / last.items.length;
        } else {
          clusters.push({ mean: raw[k].v, items: [raw[k]] });
        }
      }

      return clusters.filter(function (c) {
        var distinct = {};
        for (var q = 0; q < c.items.length; q++) distinct[c.items[q].el] = 1;
        return Object.keys(distinct).length >= 2;
      }).map(function (c) { return c.mean; });
    }

    var vs = collect(function (b) { return [b.x, b.x + b.w, b.x + b.w / 2]; });
    var hs = collect(function (b) { return [b.y, b.y + b.h, b.y + b.h / 2]; });

    var guides = [];
    for (var i = 0; i < vs.length; i++) guides.push({ axis: 'v', at: vs[i] });
    for (var j = 0; j < hs.length; j++) guides.push({ axis: 'h', at: hs[j] });
    return guides;
  }

  /**
   * A radial construction mark for elements that are genuinely circular:
   * every anchor sits at (near) the same distance from the centroid.
   */
  function radialMark(el) {
    if (el.tag === 'circle') {
      var b = el.bbox;
      return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, r: Math.min(b.w, b.h) / 2 };
    }
    var pts = anchorsOf(el);
    if (pts.length < 4) return null;

    var cx = 0, cy = 0;
    for (var i = 0; i < pts.length; i++) { cx += pts[i].x; cy += pts[i].y; }
    cx /= pts.length; cy /= pts.length;

    var rs = pts.map(function (p) { return Math.hypot(p.x - cx, p.y - cy); });
    var mean = rs.reduce(function (a, b2) { return a + b2; }, 0) / rs.length;
    if (mean <= 0) return null;

    for (var j = 0; j < rs.length; j++) {
      if (Math.abs(rs[j] - mean) / mean > 0.04) return null;
    }
    return { cx: cx, cy: cy, r: mean };
  }

  /**
   * Map each element to the shape it knocks out of, if any.
   *
   * A counter -- the white centre of a ring, the hole in an "o" -- sits inside an
   * earlier-painted shape and only makes sense once that shape exists. Returning
   * the container lets the caller colour them in the same beat instead of
   * briefly showing a ring as a solid disc.
   *
   * Returns an array of container element indices (or null), one per element.
   */
  function knockoutParents(els) {
    var tol = 1e-6;
    var parents = els.map(function () { return null; });

    for (var i = 0; i < els.length; i++) {
      var b = els[i].bbox;
      var best = null, bestArea = Infinity;

      // Only earlier elements: painting order is what makes it a knockout.
      for (var j = 0; j < i; j++) {
        var c = els[j].bbox;
        var contains = c.x - tol <= b.x && c.y - tol <= b.y &&
                       c.x + c.w + tol >= b.x + b.w &&
                       c.y + c.h + tol >= b.y + b.h;
        // A container that is the same size is a duplicate, not a counter.
        if (contains && els[j].area > els[i].area * 1.05 && els[j].area < bestArea) {
          best = j; bestArea = els[j].area;
        }
      }
      parents[i] = best;
    }

    // Collapse chains so a counter inside a counter resolves to the outermost shape.
    for (var k = 0; k < parents.length; k++) {
      var seen = {}, p = parents[k];
      while (p !== null && parents[p] !== null && !seen[p]) {
        seen[p] = 1;
        p = parents[p];
      }
      parents[k] = p;
    }

    return parents;
  }

  /**
   * Build order: major geometry first, then smaller detail and typography.
   *
   * Small elements that sit in a horizontal run (the signature of a wordmark)
   * are grouped and ordered left-to-right so type builds the way it reads.
   */
  function buildOrder(els, frame) {
    var areaThreshold = frame.w * frame.h * 0.012;
    var major = [], minor = [];

    for (var i = 0; i < els.length; i++) {
      (els[i].area >= areaThreshold ? major : minor).push(els[i]);
    }

    major.sort(function (a, b) { return b.area - a.area || a.index - b.index; });
    minor.sort(function (a, b) { return a.bbox.x - b.bbox.x || a.index - b.index; });

    return major.concat(minor);
  }

  global.Geometry = {
    normalizePath: normalizePath,
    segmentsToD: segmentsToD,
    shapeToPathD: shapeToPathD,
    extract: extract,
    anchorsOf: anchorsOf,
    handlesOf: handlesOf,
    unionBBox: unionBBox,
    alignmentGuides: alignmentGuides,
    radialMark: radialMark,
    knockoutParents: knockoutParents,
    buildOrder: buildOrder
  };
})(window);
