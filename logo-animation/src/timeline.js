/* timeline.js — the 4.000s spec, expressed as a pure function of time.
 *
 * There are no CSS animations and no requestAnimationFrame accumulation anywhere
 * in this project. Every visual property is computed from `t` alone, so frame N
 * of a capture is bit-identical to frame N of a replay and the 4s runs exactly
 * 240 frames at 60fps.
 */
(function (global) {
  'use strict';

  var DURATION = 4.0;

  var PHASE = {
    scaffold:  { start: 0.00, end: 0.70 },  // guides, anchors, measurement marks
    trace:     { start: 0.70, end: 2.50 },  // vector outlines draw in
    fill:      { start: 2.50, end: 3.20 },  // original colours lock in
    resolve:   { start: 3.20, end: 4.00 }   // construction fades, final hold
  };

  /* ------------------------------------------------------------------ easing */

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  // Cubic bezier solver, same curve definition CSS uses.
  function cubicBezier(x1, y1, x2, y2) {
    function A(a, b) { return 1 - 3 * b + 3 * a; }
    function B(a, b) { return 3 * b - 6 * a; }
    function C(a) { return 3 * a; }
    function calc(t, a, b) { return ((A(a, b) * t + B(a, b)) * t + C(a)) * t; }
    function slope(t, a, b) { return 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a); }

    return function (x) {
      x = clamp01(x);
      if (x === 0 || x === 1) return x;
      var t = x;
      for (var i = 0; i < 8; i++) {            // Newton-Raphson converges fast here
        var s = slope(t, x1, x2);
        if (Math.abs(s) < 1e-6) break;
        var err = calc(t, x1, x2) - x;
        if (Math.abs(err) < 1e-7) break;
        t -= err / s;
      }
      return calc(clamp01(t), y1, y2);
    };
  }

  var EASE = {
    // Restrained mechanical curves only. Nothing here overshoots or bounces.
    inOut:   cubicBezier(0.65, 0.00, 0.35, 1.00),
    out:     cubicBezier(0.22, 1.00, 0.36, 1.00),
    outSoft: cubicBezier(0.33, 1.00, 0.68, 1.00),
    in:      cubicBezier(0.55, 0.00, 1.00, 0.45),
    linear:  function (x) { return clamp01(x); }
  };

  /** Normalised 0..1 progress across [a,b], clamped outside. */
  function span(t, a, b, ease) {
    if (b <= a) return t >= b ? 1 : 0;
    var p = clamp01((t - a) / (b - a));
    return (ease || EASE.linear)(p);
  }

  /**
   * Stagger a window across n items with overlap.
   *
   * overlap 0 = strictly sequential, 1 = all items simultaneous. Returns the
   * [start, end] slot for item i inside [winStart, winEnd].
   */
  function slot(i, n, winStart, winEnd, overlap) {
    if (n <= 1) return [winStart, winEnd];
    var total = winEnd - winStart;
    var step = overlap;                              // fraction of one duration between starts
    var each = total / (1 + (n - 1) * step);
    var s = winStart + i * each * step;
    return [s, s + each];
  }

  /**
   * Full render state at time t.
   *
   * `n` is the number of logo elements; `order` maps draw position -> element.
   * The caller applies the returned numbers to the DOM and does no timing of
   * its own.
   */
  function stateAt(t, n) {
    t = Math.max(0, Math.min(DURATION, t));

    var S = PHASE.scaffold, T = PHASE.trace, F = PHASE.fill, R = PHASE.resolve;

    // --- construction scaffold ------------------------------------------------
    // Guides sweep in first, then anchors register, then the measurement marks.
    var guideDraw   = span(t, S.start + 0.00, S.start + 0.46, EASE.inOut);
    var guideFade   = span(t, S.start + 0.00, S.start + 0.18, EASE.outSoft);
    var anchorIn    = span(t, S.start + 0.26, S.start + 0.60, EASE.out);
    var measureIn   = span(t, S.start + 0.38, S.end,          EASE.out);

    // Construction geometry retires during the resolve phase, well before the hold.
    var scaffoldOut = span(t, R.start + 0.02, R.start + 0.36, EASE.inOut);
    var handleOut   = span(t, F.start + 0.04, F.start + 0.30, EASE.inOut);

    var scaffoldOpacity = guideFade * (1 - scaffoldOut);

    var state = {
      t: t,
      phase: t < T.start ? 'scaffold' : t < F.start ? 'trace' : t < R.start ? 'fill' : 'resolve',
      guides: {
        draw: guideDraw,
        opacity: scaffoldOpacity
      },
      anchors: {
        scale: anchorIn,
        opacity: anchorIn * (1 - scaffoldOut)
      },
      measures: {
        draw: measureIn,
        opacity: measureIn * (1 - scaffoldOut)
      },
      elements: []
    };

    for (var i = 0; i < n; i++) {
      // Outlines trace across the whole trace window, generously overlapped so
      // the build reads as one continuous construction rather than n solos.
      var tr = slot(i, n, T.start, T.end, 0.55);
      var trace = span(t, tr[0], tr[1], EASE.inOut);

      // Handles bloom just ahead of their own outline and retract behind it.
      var hIn  = span(t, tr[0] - 0.10, tr[0] + 0.14, EASE.out);
      var hOut = span(t, tr[1] - 0.06, tr[1] + 0.16, EASE.inOut);
      var handleOpacity = hIn * (1 - hOut) * (1 - handleOut);

      // Colour arrives per element, tighter stagger, then the outline hands off.
      var fl = slot(i, n, F.start, F.end, 0.40);
      var fill = span(t, fl[0], fl[1], EASE.outSoft);

      // Each component settles the last fraction of a unit into place as it locks.
      var settle = 1 - span(t, fl[0] - 0.06, fl[1] + 0.05, EASE.out);

      // The tracing stroke fades once the fill beneath it is established, so the
      // final frame carries only the logo's own artwork. The caller gates this on
      // the element's own trace having started.
      var outlineOpacity = 1 - span(t, fl[0] + 0.04, fl[1] + 0.10, EASE.inOut);

      state.elements.push({
        trace: trace,
        outlineOpacity: outlineOpacity,
        fill: fill,
        settle: settle,
        handleOpacity: handleOpacity
      });
    }

    return state;
  }

  global.Timeline = {
    DURATION: DURATION,
    PHASE: PHASE,
    EASE: EASE,
    span: span,
    slot: slot,
    stateAt: stateAt
  };
})(window);
