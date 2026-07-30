/* player.js — mounts the scene and exposes a deterministic seek API.
 *
 * Preview playback uses a wall clock, but nothing about the render depends on it:
 * every frame goes through Scene.apply(scene, t). The capture script drives the
 * exact same entry point one frame at a time, so preview and export match.
 */
(function (global) {
  'use strict';

  var stage = document.getElementById('stage');
  var sourceHost = document.getElementById('source');
  var scene = null;
  var mountError = null;

  function readQuery() {
    var q = {};
    var s = global.location.search.replace(/^\?/, '');
    if (!s) return q;
    s.split('&').forEach(function (kv) {
      var p = kv.split('=');
      q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    return q;
  }

  function mount() {
    var q = readQuery();

    if (!global.LOGO_SVG || !String(global.LOGO_SVG).trim()) {
      throw new Error(
        'No logo loaded. Put the reference logo at logo-animation/logo.svg and run ' +
        '`npm run logo` to regenerate src/logo.js.'
      );
    }

    sourceHost.innerHTML = String(global.LOGO_SVG);
    var svg = sourceHost.querySelector('svg');
    if (!svg) throw new Error('logo.svg does not contain an <svg> root element.');

    // Give the source an explicit box so getScreenCTM is well defined even when
    // the file declares only a viewBox.
    var vb = svg.getAttribute('viewBox');
    if (vb) {
      var p = vb.trim().split(/[\s,]+/).map(Number);
      svg.setAttribute('width', p[2]);
      svg.setAttribute('height', p[3]);
    }

    var cfg = {};
    if (q.w) cfg.width = parseInt(q.w, 10);
    if (q.h) cfg.height = parseInt(q.h, 10);
    if (q.fit) cfg.logoFit = parseFloat(q.fit);

    scene = global.Scene.build(stage, svg, cfg);

    if (scene.warnings.length) {
      var warn = document.getElementById('warn');
      warn.textContent = scene.warnings.join('\n');
      warn.style.display = 'block';
    }

    if (q.capture === '1') document.body.classList.add('capture');

    global.Scene.apply(scene, 0);
    return scene;
  }

  /* ------------------------------------------------------------- seek API */

  var current = 0;

  function setTime(t) {
    if (!scene) return null;
    current = Math.max(0, Math.min(global.Timeline.DURATION, t));
    var st = global.Scene.apply(scene, current);
    var hud = document.getElementById('clock');
    if (hud) {
      hud.textContent = current.toFixed(3) + 's / ' + global.Timeline.DURATION.toFixed(3) + 's';
      document.getElementById('phase').textContent = st.phase;
      document.getElementById('scrub').value = Math.round(current * 1000);
    }
    return st;
  }

  /* --------------------------------------------------------- preview only */

  var playing = false, rafId = null, startWall = 0, startT = 0;

  function tick(now) {
    if (!playing) return;
    var t = startT + (now - startWall) / 1000;
    if (t >= global.Timeline.DURATION) { setTime(global.Timeline.DURATION); stop(); return; }
    setTime(t);
    rafId = global.requestAnimationFrame(tick);
  }

  function play() {
    if (playing) return;
    if (current >= global.Timeline.DURATION) current = 0;
    playing = true;
    startT = current;
    startWall = global.performance.now();
    document.getElementById('play').textContent = 'Pause';
    rafId = global.requestAnimationFrame(tick);
  }

  function stop() {
    playing = false;
    if (rafId) global.cancelAnimationFrame(rafId);
    rafId = null;
    var b = document.getElementById('play');
    if (b) b.textContent = 'Play';
  }

  function wireHud() {
    var playBtn = document.getElementById('play');
    if (!playBtn) return;
    playBtn.addEventListener('click', function () { playing ? stop() : play(); });
    document.getElementById('restart').addEventListener('click', function () {
      stop(); setTime(0); play();
    });
    document.getElementById('scrub').addEventListener('input', function (e) {
      stop(); setTime(parseInt(e.target.value, 10) / 1000);
    });
    document.addEventListener('keydown', function (e) {
      if (e.code === 'Space') { e.preventDefault(); playing ? stop() : play(); }
      if (e.code === 'ArrowRight') { stop(); setTime(current + 1 / 60); }
      if (e.code === 'ArrowLeft') { stop(); setTime(current - 1 / 60); }
    });
  }

  try {
    mount();
    wireHud();
  } catch (err) {
    mountError = err;
    var warn = document.getElementById('warn');
    if (warn) { warn.textContent = err.message; warn.style.display = 'block'; }
    console.error(err);
  }

  // Contract used by scripts/capture.mjs.
  global.__anim = {
    ready: !!scene,
    error: mountError ? mountError.message : null,
    duration: global.Timeline.DURATION,
    count: scene ? scene.count : 0,
    warnings: scene ? scene.warnings : [],
    setTime: setTime,
    play: play,
    stop: stop,
    renderStatic: function () { if (scene) global.Scene.renderStatic(scene); }
  };
})(window);
