/* scene.js — build the layered stage from the logo's geometry, then drive it.
 *
 * Layer order, bottom to top:
 *   guides    alignment lines and radial construction implied by the logo
 *   measures  dimension marks on the logo's own bounding box
 *   artwork   the real logo (fills) plus a thin tracing outline per element
 *   handles   Bezier control arms
 *   anchors   on-curve points
 */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var G = global.Geometry;
  var T = global.Timeline;

  var CONFIG = {
    width: 1920,
    height: 1080,
    // Largest fraction of each canvas axis the logo may occupy. Fitting both axes
    // independently keeps a wide wordmark from being shrunk to the height of a
    // square one, while still leaving a wide, quiet margin on every side.
    logoFit: 0.62,
    // Stroke weights in final-output pixels; converted to user units per logo.
    px: {
      guide: 1.0,
      measure: 1.0,
      tick: 1.0,
      outline: 1.6,
      handle: 1.0,
      anchor: 1.4,
      radial: 1.0
    },
    anchorSize: 7,        // px, square side
    handleDot: 3.2,       // px, radius
    anchorBudget: 120,    // total anchors drawn across the whole logo
    settlePx: 5,          // px each component travels as it locks into place
    color: {
      bg: '#FFFFFF',
      guide: '#D3D8DF',
      measure: '#C2C8D1',
      anchorStroke: '#59616F',
      anchorFill: '#FFFFFF',
      handle: '#AAB2BF',
      handleDot: '#59616F',
      outline: '#1B1F24',
      radial: '#DCE0E6'
    }
  };

  function el(name, attrs) {
    var n = document.createElementNS(SVG_NS, name);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  function evenSample(arr, keep) {
    if (keep >= arr.length) return arr.slice();
    var out = [];
    for (var i = 0; i < keep; i++) out.push(arr[Math.floor((i * arr.length) / keep)]);
    return out;
  }

  /**
   * Construct the whole scene.
   * @param {SVGSVGElement} stage   empty output svg
   * @param {SVGSVGElement} source  the logo svg, live in the document
   */
  function build(stage, source, cfg) {
    cfg = Object.assign({}, CONFIG, cfg || {});
    cfg.px = Object.assign({}, CONFIG.px, (cfg || {}).px || {});
    cfg.color = Object.assign({}, CONFIG.color, (cfg || {}).color || {});

    var W = cfg.width, H = cfg.height;
    stage.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    stage.setAttribute('width', W);
    stage.setAttribute('height', H);
    while (stage.firstChild) stage.removeChild(stage.firstChild);

    var res = G.extract(source);
    if (!res.elements.length) throw new Error('No drawable geometry found in the logo SVG.');

    var frame = G.unionBBox(res.elements);

    // Build order decides *when* each component is drawn. Paint order stays exactly
    // as the logo authored it, so overlapping artwork stacks the way it should and
    // the finished frame is the reference logo, not a re-layered version of it.
    var ordered = G.buildOrder(res.elements, frame);
    var buildIndexOf = {};
    for (var oi = 0; oi < ordered.length; oi++) buildIndexOf[ordered[oi].index] = oi;

    // Counters take their colour cue from the shape they knock out of.
    var knockout = G.knockoutParents(res.elements);

    // Fit the logo into the canvas: uniform scale, centred, never cropped.
    var scale = Math.min((W * cfg.logoFit) / frame.w, (H * cfg.logoFit) / frame.h);
    var tx = W / 2 - scale * (frame.x + frame.w / 2);
    var ty = H / 2 - scale * (frame.y + frame.h / 2);

    // Stroke widths are authored in output pixels, so divide by the fit scale.
    var u = function (px) { return px / scale; };

    stage.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, fill: cfg.color.bg }));

    var defs = el('defs');
    stage.appendChild(defs);

    var root = el('g', { transform: 'translate(' + tx + ' ' + ty + ') scale(' + scale + ')' });
    stage.appendChild(root);

    var lGuides = el('g'), lMeasures = el('g'), lArt = el('g'), lHandles = el('g'), lAnchors = el('g');
    root.appendChild(lGuides);
    root.appendChild(lMeasures);
    root.appendChild(lArt);
    root.appendChild(lHandles);
    root.appendChild(lAnchors);

    /* ------------------------------------------------------------- guides */

    var pad = Math.max(frame.w, frame.h) * 0.16;
    var guideDefs = G.alignmentGuides(res.elements, frame);

    // The logo's own bounding frame always reads as construction, plus its centre cross.
    guideDefs.push({ axis: 'v', at: frame.x });
    guideDefs.push({ axis: 'v', at: frame.x + frame.w });
    guideDefs.push({ axis: 'v', at: frame.x + frame.w / 2 });
    guideDefs.push({ axis: 'h', at: frame.y });
    guideDefs.push({ axis: 'h', at: frame.y + frame.h });
    guideDefs.push({ axis: 'h', at: frame.y + frame.h / 2 });

    // Drop duplicates so shared edges are not stroked twice (they would look heavier).
    var seenGuide = {};
    guideDefs = guideDefs.filter(function (g) {
      var key = g.axis + ':' + g.at.toFixed(3);
      if (seenGuide[key]) return false;
      seenGuide[key] = 1;
      return true;
    });

    var guideNodes = [];
    guideDefs.forEach(function (g) {
      var d = g.axis === 'v'
        ? 'M' + g.at + ' ' + (frame.y - pad) + 'L' + g.at + ' ' + (frame.y + frame.h + pad)
        : 'M' + (frame.x - pad) + ' ' + g.at + 'L' + (frame.x + frame.w + pad) + ' ' + g.at;
      var node = el('path', {
        d: d,
        fill: 'none',
        stroke: cfg.color.guide,
        'stroke-width': u(cfg.px.guide),
        'shape-rendering': 'geometricPrecision'
      });
      var len = (g.axis === 'v' ? frame.h : frame.w) + pad * 2;
      node.setAttribute('stroke-dasharray', len);
      guideNodes.push({ node: node, len: len });
      lGuides.appendChild(node);
    });

    // Radial construction, only for elements that are genuinely circular.
    res.elements.forEach(function (e) {
      var rm = G.radialMark(e);
      if (!rm) return;
      var ring = el('circle', {
        cx: rm.cx, cy: rm.cy, r: rm.r,
        fill: 'none', stroke: cfg.color.radial, 'stroke-width': u(cfg.px.radial)
      });
      var circumference = 2 * Math.PI * rm.r;
      ring.setAttribute('stroke-dasharray', circumference);
      guideNodes.push({ node: ring, len: circumference });
      lGuides.appendChild(ring);

      var cross = el('path', {
        d: 'M' + (rm.cx - u(6)) + ' ' + rm.cy + 'h' + u(12) +
           'M' + rm.cx + ' ' + (rm.cy - u(6)) + 'v' + u(12),
        fill: 'none', stroke: cfg.color.measure, 'stroke-width': u(cfg.px.tick)
      });
      var crossLen = u(24);
      cross.setAttribute('stroke-dasharray', crossLen);
      guideNodes.push({ node: cross, len: crossLen });
      lGuides.appendChild(cross);
    });

    /* ----------------------------------------------------------- measures */

    // Dimension marks on the logo's real width and height. No numerals: the brief
    // forbids adding text, so these read purely as extension lines and end ticks.
    var mOff = Math.max(frame.w, frame.h) * 0.105;
    var tick = u(5);
    var measureNodes = [];

    function addMeasure(d, len) {
      var node = el('path', {
        d: d, fill: 'none', stroke: cfg.color.measure,
        'stroke-width': u(cfg.px.measure), 'stroke-dasharray': len
      });
      measureNodes.push({ node: node, len: len });
      lMeasures.appendChild(node);
    }

    var wy = frame.y + frame.h + mOff;
    addMeasure(
      'M' + frame.x + ' ' + (wy - tick) + 'v' + (tick * 2) +
      'M' + frame.x + ' ' + wy + 'H' + (frame.x + frame.w) +
      'M' + (frame.x + frame.w) + ' ' + (wy - tick) + 'v' + (tick * 2),
      frame.w + tick * 4
    );

    var hx = frame.x - mOff;
    addMeasure(
      'M' + (hx - tick) + ' ' + frame.y + 'h' + (tick * 2) +
      'M' + hx + ' ' + frame.y + 'V' + (frame.y + frame.h) +
      'M' + (hx - tick) + ' ' + (frame.y + frame.h) + 'h' + (tick * 2),
      frame.h + tick * 4
    );

    /* ------------------------------------------- artwork, handles, anchors */

    var totalAnchors = ordered.reduce(function (s, e) { return s + G.anchorsOf(e).length; }, 0);
    var anchorRatio = totalAnchors > cfg.anchorBudget ? cfg.anchorBudget / totalAnchors : 1;

    var cxLogo = frame.x + frame.w / 2;
    var cyLogo = frame.y + frame.h / 2;
    var settleU = u(cfg.settlePx);

    // Colour is revealed by a clip that sweeps along the logo's dominant axis
    // rather than by fading opacity. A logo whose parts knock out of one another
    // -- a white counter sitting on a dark shape, say -- would show the shape
    // underneath through a half-opaque fill, so the "original colours" would pass
    // through colours the logo does not contain. A clip never does that: every
    // pixel it reveals is already the final colour.
    var wipeAxis = frame.w >= frame.h ? 'x' : 'y';
    var wipePad = u(cfg.px.outline) * 2 + settleU;

    var items = res.elements.map(function (e) {
      var group = el('g');
      lArt.appendChild(group);

      var clipId = 'wipe-' + e.index;
      var clipRect = el('rect', {
        x: e.bbox.x - wipePad,
        y: e.bbox.y - wipePad,
        width: wipeAxis === 'x' ? 0 : e.bbox.w + wipePad * 2,
        height: wipeAxis === 'y' ? 0 : e.bbox.h + wipePad * 2
      });
      var clip = el('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
      clip.appendChild(clipRect);
      defs.appendChild(clip);

      var artClip = el('g', { 'clip-path': 'url(#' + clipId + ')' });
      group.appendChild(artClip);

      // The logo exactly as authored; the clip decides how much of it is showing.
      var artAttrs = {
        d: e.d,
        fill: e.fill || 'none',
        'fill-rule': e.fillRule,
        'shape-rendering': 'geometricPrecision'
      };
      if (e.stroke) {
        artAttrs.stroke = e.stroke;
        artAttrs['stroke-width'] = e.strokeWidth;
      }
      var art = el('path', artAttrs);
      var baseOpacity = (isNaN(e.opacity) ? 1 : e.opacity) *
                        (isNaN(e.fillOpacity) ? 1 : e.fillOpacity);
      artClip.appendChild(art);

      // Thin tracing outline drawn on top while the component is being built.
      var outline = el('path', {
        d: e.d,
        fill: 'none',
        stroke: cfg.color.outline,
        'stroke-width': u(cfg.px.outline),
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': e.length,
        'stroke-dashoffset': e.length,
        'shape-rendering': 'geometricPrecision'
      });
      group.appendChild(outline);

      // Handles: one arm per real control point.
      var hGroup = el('g');
      lHandles.appendChild(hGroup);
      var handles = G.handlesOf(e);
      handles = evenSample(handles, Math.max(2, Math.round(handles.length * anchorRatio)));
      handles.forEach(function (h) {
        if (Math.hypot(h.hx - h.ax, h.hy - h.ay) < u(1.5)) return;   // degenerate arm
        hGroup.appendChild(el('path', {
          d: 'M' + h.ax + ' ' + h.ay + 'L' + h.hx + ' ' + h.hy,
          stroke: cfg.color.handle, 'stroke-width': u(cfg.px.handle), fill: 'none'
        }));
        hGroup.appendChild(el('circle', {
          cx: h.hx, cy: h.hy, r: u(cfg.handleDot), fill: cfg.color.handleDot
        }));
      });

      // Anchors: real on-curve points, square like a vector editor draws them.
      var aGroup = el('g');
      lAnchors.appendChild(aGroup);
      var pts = G.anchorsOf(e);
      pts = evenSample(pts, Math.max(2, Math.round(pts.length * anchorRatio)));
      var half = u(cfg.anchorSize) / 2;
      var anchorNodes = pts.map(function (p) {
        var sq = el('rect', {
          x: p.x - half, y: p.y - half,
          width: half * 2, height: half * 2,
          fill: cfg.color.anchorFill,
          stroke: cfg.color.anchorStroke,
          'stroke-width': u(cfg.px.anchor)
        });
        aGroup.appendChild(sq);
        return { node: sq, x: p.x, y: p.y };
      });

      // Direction this component travels as it locks in: a few pixels inward.
      var ecx = e.bbox.x + e.bbox.w / 2;
      var ecy = e.bbox.y + e.bbox.h / 2;
      var dx = ecx - cxLogo, dy = ecy - cyLogo;
      var mag = Math.hypot(dx, dy);
      var dir = mag < 1e-6 ? [0, 1] : [dx / mag, dy / mag];

      return {
        group: group, art: art, outline: outline,
        hGroup: hGroup, aGroup: aGroup, anchorNodes: anchorNodes,
        clipRect: clipRect,
        clipAxis: wipeAxis === 'x' ? 'width' : 'height',
        clipFull: wipeAxis === 'x' ? e.bbox.w + wipePad * 2 : e.bbox.h + wipePad * 2,
        length: e.length, baseOpacity: baseOpacity,
        buildIndex: buildIndexOf[e.index],
        fillIndex: buildIndexOf[knockout[e.index] === null ? e.index : knockout[e.index]],
        dir: dir, half: half
      };
    });

    return {
      config: cfg,
      warnings: res.warnings,
      count: items.length,
      frame: frame,
      scale: scale,
      settleU: settleU,
      layers: { guides: lGuides, measures: lMeasures, art: lArt, handles: lHandles, anchors: lAnchors },
      guideNodes: guideNodes,
      measureNodes: measureNodes,
      items: items
    };
  }

  /** Apply the timeline state for time `t`. Pure: same t always yields same DOM. */
  function apply(scene, t) {
    var s = T.stateAt(t, scene.count);

    scene.layers.guides.setAttribute('opacity', s.guides.opacity);
    scene.guideNodes.forEach(function (g) {
      g.node.setAttribute('stroke-dashoffset', g.len * (1 - s.guides.draw));
    });

    scene.layers.measures.setAttribute('opacity', s.measures.opacity);
    scene.measureNodes.forEach(function (m) {
      m.node.setAttribute('stroke-dashoffset', m.len * (1 - s.measures.draw));
    });

    scene.layers.anchors.setAttribute('opacity', s.anchors.opacity);

    for (var i = 0; i < scene.items.length; i++) {
      var it = scene.items[i];
      var st = s.elements[it.buildIndex];        // tracing: this element's own slot
      var fs = s.elements[it.fillIndex];         // colour: its knockout group's slot

      // Always written, never removed: removing and re-adding an attribute
      // reorders it in the serialised DOM, which makes state diffs noisy.
      var off = fs.settle * scene.settleU;
      var tf = 'translate(' + it.dir[0] * off + ' ' + it.dir[1] * off + ')';
      it.group.setAttribute('transform', tf);
      it.hGroup.setAttribute('transform', tf);
      it.aGroup.setAttribute('transform', tf);

      it.outline.setAttribute('stroke-dashoffset', it.length * (1 - st.trace));
      it.outline.setAttribute('opacity', st.trace > 0 ? fs.outlineOpacity : 0);
      it.art.setAttribute('opacity', it.baseOpacity);
      it.clipRect.setAttribute(it.clipAxis, it.clipFull * fs.fill);
      it.hGroup.setAttribute('opacity', st.handleOpacity);

      // Anchors register with a scale-in, no overshoot.
      var k = s.anchors.scale;
      for (var j = 0; j < it.anchorNodes.length; j++) {
        var an = it.anchorNodes[j];
        var h = it.half * k;
        an.node.setAttribute('x', an.x - h);
        an.node.setAttribute('y', an.y - h);
        an.node.setAttribute('width', h * 2);
        an.node.setAttribute('height', h * 2);
      }
    }

    return s;
  }

  /**
   * Render the logo alone, with no construction geometry and every component at
   * full opacity in its final position. This is the reference the last frame of
   * the animation is checked against.
   */
  function renderStatic(scene) {
    scene.layers.guides.setAttribute('opacity', 0);
    scene.layers.measures.setAttribute('opacity', 0);
    scene.layers.anchors.setAttribute('opacity', 0);
    for (var i = 0; i < scene.items.length; i++) {
      var it = scene.items[i];
      it.group.setAttribute('transform', 'translate(0 0)');
      it.hGroup.setAttribute('transform', 'translate(0 0)');
      it.aGroup.setAttribute('transform', 'translate(0 0)');
      it.hGroup.setAttribute('opacity', 0);
      it.outline.setAttribute('opacity', 0);
      it.art.setAttribute('opacity', it.baseOpacity);
      it.clipRect.setAttribute(it.clipAxis, it.clipFull);
    }
  }

  global.Scene = { CONFIG: CONFIG, build: build, apply: apply, renderStatic: renderStatic };
})(window);
