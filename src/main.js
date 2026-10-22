(() => {
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const stage = $('stage'), chadsEl = $('chads'), hintEl = $('hint');

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const hypot = Math.hypot;
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const rot = (x, y, a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return { x: x * c - y * s, y: x * s + y * c };
  };

  /* ---------- Texture: cloudy formation + fine tooth + fibers ---------- */

  function hash(x, y, s) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, s, oct) {
    let sum = 0, amp = .5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * vnoise(x * f, y * f, s + i * 17);
      norm += amp; amp *= .5; f *= 2.03;
    }
    return sum / norm;
  }

  function makeTexture(N = 1024) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(N, N);
    const px = img.data;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const f = fbm(x / 230, y / 230, 3, 4);        // large cloudy formation
        const m = fbm(x / 54, y / 30, 11, 3);         // fiber flocs, stretched along machine direction
        const g = Math.random();                      // fine tooth
        const a = clamp(.5 + (f - .5) * .6 + (m - .5) * .22 + (g - .5) * .1, .26, .86);
        const lum = (g - .5) * 7 + (m - .5) * 10;
        const i = (y * N + x) * 4;
        px[i] = 228 + lum; px[i + 1] = 221 + lum; px[i + 2] = 204 + lum * .9;
        px[i + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Fibers: mostly light (denser pulp), a few darker, loosely aligned
    const machine = -0.12;
    for (let i = 0; i < 2800; i++) {
      const x = Math.random() * N, y = Math.random() * N;
      const len = 4 + Math.pow(Math.random(), 2) * 42;
      const ang = machine + (Math.random() - .5) * 2.4;
      const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
      const bend = (Math.random() - .5) * len * .5;
      const cx = (x + ex) / 2 - Math.sin(ang) * bend, cy = (y + ey) / 2 + Math.cos(ang) * bend;
      const light = Math.random() < .72;
      ctx.strokeStyle = light
        ? `rgba(255,253,246,${.08 + Math.random() * .24})`
        : `rgba(150,128,92,${.03 + Math.random() * .07})`;
      ctx.lineWidth = .35 + Math.random() * .9;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(cx, cy, ex, ey); ctx.stroke();
    }
    // Specks
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = `rgba(120,98,66,${.05 + Math.random() * .1})`;
      ctx.beginPath();
      ctx.arc(Math.random() * N, Math.random() * N, .4 + Math.random() * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    // Opened from disk, Firefox (and Zen) won't paint a blob: URL as a CSS background, so the
    // texture goes in as a data: URL there.
    if (location.protocol === 'file:') return Promise.resolve(cv.toDataURL('image/png'));
    return new Promise(res => cv.toBlob(b => res(URL.createObjectURL(b)), 'image/png'));
  }

  /* ---------- Pieces ----------
     A piece is one physical sheet: the plain square, or one half of the perforated one.
     While the perforated halves are still joined they share the `pair` body. */

  const S = clamp(Math.round(Math.min(innerWidth * .78, innerHeight * .62)), 240, 540);
  root.style.setProperty('--s', S + 'px');

  const HOLE_R = .022 * S;
  const ROT_ICON = `<svg width="22" height="22" viewBox="0 0 22 22">
    <path class="halo" d="M5 15A10 10 0 0 1 15 5M2.5 12.5L5 15l2.5-2.5M12.5 2.5L15 5l-2.5 2.5"/>
    <path class="ink" d="M5 15A10 10 0 0 1 15 5M2.5 12.5L5 15l2.5-2.5M12.5 2.5L15 5l-2.5 2.5"/></svg>`;

  const SURFACE = '<svg class="ink"></svg><div class="sheen"></div><svg class="rims"></svg>';
  const STRIP_SHADOW = '<div class="layer shadow holed sts"></div>';

  let variant = 'plain';
  let pieces = [];
  let pair = null;
  let punching = false;
  let drag = null;          // { type: 'move' | 'peel' | 'rotate' | 'tear', piece, ... }
  let hover = null;         // { kind: 'peel' | 'rotate', piece, c | k, t }
  let lastP = { x: 0, y: 0, t: 0 };

  const makeBody = (x, y, a) => ({ x, y, a, vx: 0, vy: 0, va: 0, lift: 0, liftV: 0 });

  function createPiece(W, H, texX, side) {
    const el = document.createElement('div');
    el.className = 'piece';
    el.style.width = W + 'px'; el.style.height = H + 'px';
    el.innerHTML = `
      <div class="shadow-wrap sw"><div class="layer shadow holed ss"></div>${STRIP_SHADOW}${STRIP_SHADOW}</div>
      <div class="layer tex holed sheet">${SURFACE}</div>
      <div class="layer tex holed strip">${SURFACE}</div>
      <div class="layer tex holed strip">${SURFACE}</div>
      <div class="shadow-wrap fsw"><div class="layer shadow holed fs"></div></div>
      <div class="layer tex holed flap"><svg class="ink"></svg><div class="flapShade"></div><svg class="rims"></svg></div>
      ${[0, 1, 2, 3].map(k => `<div class="rot" style="left:${k === 1 || k === 2 ? W : 0}px;top:${k >= 2 ? H : 0}px;transform:rotate(${k * 90}deg)">${ROT_ICON}</div>`).join('')}`;
    stage.appendChild(el);
    const q = s => el.querySelector(s);
    const p = {
      el, W, H, texX, side, joined: !!side, edges: { left: 'cut', right: 'cut' },
      body: makeBody(0, 0, 0), holes: [], texts: [], gone: false,
      peel: { on: false, C: { x: 0, y: 0 }, P: { x: 0, y: 0 }, V: { x: 0, y: 0 }, T: { x: 0, y: 0 },
              progress: 0, off: 0, offT: null, offFrames: 0, liftOff: 0 },
      sw: q('.sw'), ss: q('.ss'), sheet: q('.sheet'),
      strips: el.querySelectorAll('.strip'), sts: el.querySelectorAll('.sts'),     // [top, bottom]
      fsw: q('.fsw'), fs: q('.fs'), flap: q('.flap'), shade: q('.flapShade'),
      rims: el.querySelectorAll('.rims'), inks: el.querySelectorAll('.ink'), handles: el.querySelectorAll('.rot'),
    };
    for (const l of el.querySelectorAll('.layer')) { l.style.width = W + 'px'; l.style.height = H + 'px'; }
    for (const t of el.querySelectorAll('.tex')) t.style.backgroundPosition = `${-texX}px 0`;
    for (const r of [...p.rims, ...p.inks]) r.setAttribute('viewBox', `0 0 ${W} ${H}`);
    p.base = basePoly(p);
    updateMask(p);
    return p;
  }

  // Perforation slits; each half owns `depth` px of every slit.
  const PERF = { start: 2, pitch: 7, len: 3, depth: 1.5 };

  // Outline of a piece. A torn perforation keeps half of each slit as a small square
  // notch, with slightly fuzzy paper bridges where the fibers actually tore.
  function basePoly(p) {
    const { W, H } = p;
    const perfEdge = (x, inward, down) => {
      const pts = [];
      let prev = 0;
      for (let y0 = PERF.start; y0 + PERF.len < H; y0 += PERF.pitch) {
        const y1 = y0 + PERF.len, xi = x + inward * PERF.depth;
        pts.push({ x: x + (Math.random() - .5) * .8, y: (prev + y0) / 2 });
        pts.push({ x, y: y0 }, { x: xi, y: y0 }, { x: xi, y: y1 }, { x, y: y1 });
        prev = y1;
      }
      return down ? pts : pts.reverse();
    };
    return [
      { x: 0, y: 0 }, { x: W, y: 0 },
      ...(p.edges.right === 'torn' ? perfEdge(W, -1, true) : []),
      { x: W, y: H }, { x: 0, y: H },
      ...(p.edges.left === 'torn' ? perfEdge(0, 1, false) : []),
    ];
  }
  const isTorn = p => p.edges.left === 'torn' || p.edges.right === 'torn';
  const corners = p => [{ x: 0, y: 0 }, { x: p.W, y: 0 }, { x: p.W, y: p.H }, { x: 0, y: p.H }];
  // While joined, only the outer corners of the whole sheet rotate it.
  const rotCorners = p => !p.joined ? [0, 1, 2, 3] : p.side === 'A' ? [0, 3] : [1, 2];
  const inRect = (p, q, pad = 0) => q.x >= -pad && q.y >= -pad && q.x <= p.W + pad && q.y <= p.H + pad;

  // World position of a piece's local origin, and its angle.
  function frame(p) {
    if (p.joined) {
      const w = rot((p.side === 'A' ? 0 : S / 2) - S / 2, -S / 2, pair.a);
      return { ox: pair.x + w.x, oy: pair.y + w.y, a: pair.a };
    }
    const b = p.body, w = rot(-p.W / 2, -p.H / 2, b.a);
    return { ox: b.x + w.x, oy: b.y + w.y, a: b.a };
  }
  function toLocal(p, x, y) {
    const f = frame(p), r = rot(x - f.ox, y - f.oy, -f.a);
    return r;
  }
  function toWorld(p, lx, ly) {
    const f = frame(p), r = rot(lx, ly, f.a);
    return { x: f.ox + r.x, y: f.oy + r.y };
  }
  function toPair(x, y) {
    const r = rot(x - pair.x, y - pair.y, -pair.a);
    return { x: r.x + S / 2, y: r.y + S / 2 };
  }

  /* ---------- Masks: punched holes + perforation slits ---------- */

  function updateMask(p) {
    const { W, H } = p;
    let cut = p.holes.map(h => `<circle cx='${h.x}' cy='${h.y}' r='${h.r}'/>`).join('');
    cut += p.texts.map((t, i) => t.cut ? textSvg(t, i) : '').join('');
    if (p.joined) {
      const x = p.side === 'A' ? W - PERF.depth : 0;
      for (let y = PERF.start; y + PERF.len < H; y += PERF.pitch)
        cut += `<rect x='${x}' y='${y}' width='${PERF.depth}' height='${PERF.len}'/>`;
      // Along the torn stretches the bridges between slits have given way.
      const { top, bottom } = pair.tears, tx = p.side === 'A' ? W - .6 : 0;
      if (top.L > 0) cut += `<rect x='${tx}' y='0' width='.6' height='${top.L}'/>`;
      if (bottom.L > 0) cut += `<rect x='${tx}' y='${H - bottom.L}' width='.6' height='${bottom.L}'/>`;
    }
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='none'>`
      + `<mask id='m'><rect width='${W}' height='${H}' fill='white'/><g fill='black'>${cut}</g></mask>`
      + `<rect width='${W}' height='${H}' fill='black' mask='url(#m)'/></svg>`;
    const url = cut ? `url("data:image/svg+xml,${encodeURIComponent(svg)}")` : 'none';
    for (const el of [p.sheet, p.flap, p.ss, p.fs, ...p.strips, ...p.sts]) { el.style.webkitMaskImage = url; el.style.maskImage = url; }
    const rims = p.holes.map(h => `<circle cx="${h.x}" cy="${h.y}" r="${h.r + .5}"/>`).join('');
    p.rims.forEach(el => { el.innerHTML = rims; });
  }

  /* ---------- Build / reset ---------- */

  function build() {
    stage.replaceChildren();
    chads.length = 0; chadsEl.replaceChildren();
    drag = hover = editor = null;
    const cx = innerWidth / 2, cy = innerHeight / 2;
    if (variant === 'plain') {
      pair = null;
      const p = createPiece(S, S, 0, null);
      p.body = makeBody(cx, cy, -0.035);
      pieces = [p];
    } else {
      // Each end of the perforation tears independently; the halves part once the fronts meet.
      const tear = () => ({ L: 0, k: 0, kV: 0, kT: 0, piece: null });
      pair = { ...makeBody(cx, cy, -0.035), tears: { top: tear(), bottom: tear() }, maskSig: '0,0' };
      pieces = [createPiece(S / 2, S, 0, 'A'), createPiece(S / 2, S, S / 2, 'B')];
    }
    updateHint();
  }

  function updateHint() {
    let t;
    if (typing) t = 'Click the paper to type · click a line to edit it · T or Esc when done';
    else if (punching) t = 'Click to punch a hole · click a line of text to punch its letters out · H or Esc when done';
    else if (pieces.every(p => p.gone)) t = 'Peeled clean off. Hit Reset for a fresh sheet';
    else if (pair) t = 'Pull a half sideways to tear the perforation from the nearer end · tear from both ends to meet in the middle · peel a corner to rip it off';
    else t = 'Drag to slide · grab outside a corner to rotate · peel a corner past halfway and it comes off';
    hintEl.textContent = t;
  }

  /* ---------- Hit testing ---------- */

  const zone = p => Math.max(40, Math.min(p.W, p.H) * .15);

  function hitTest(x, y) {
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      if (p.gone || p.peel.off) continue;
      const q = toLocal(p, x, y);
      if (inRect(p, q)) return { kind: 'body', p, q };
      for (const k of rotCorners(p)) {
        const c = corners(p)[k];
        if (hypot(q.x - c.x, q.y - c.y) < 30) return { kind: 'rotate', p, q, k };
      }
    }
    return null;
  }
  function nearestCorner(p, q) {
    let best = null, bd = Infinity;
    for (const c of corners(p)) { const d = hypot(q.x - c.x, q.y - c.y); if (d < bd) { bd = d; best = c; } }
    return { c: best, d: bd };
  }

  /* ---------- Cursors ---------- */

  const cursorCache = {};
  function rotCursor(rad) {
    const deg = ((Math.round(rad * 180 / Math.PI / 10) * 10) % 360 + 360) % 360;
    if (!cursorCache[deg]) {
      const d = 'M13 23A10 10 0 0 1 23 13M10.5 20.5L13 23l2.5-2.5M20.5 10.5L23 13l-2.5 2.5';
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><g transform='rotate(${deg} 16 16)' fill='none' stroke-linecap='round' stroke-linejoin='round'>`
        + `<path d='${d}' stroke='white' stroke-width='4'/><path d='${d}' stroke='black' stroke-width='1.6'/></g></svg>`;
      cursorCache[deg] = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, alias`;
    }
    return cursorCache[deg];
  }
  function setCursor(c) { document.body.style.cursor = c || ''; }

  function setPunchCursor() {
    const r = HOLE_R, c = Math.ceil(r) + 2, w = c * 2;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${w}'>`
      + `<circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='white' stroke-width='3'/>`
      + `<circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='black' stroke-width='1'/>`
      + `<path d='M${c - 3} ${c}h6M${c} ${c - 3}v6' stroke='black'/></svg>`;
    root.style.setProperty('--punch-cursor', `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}`);
  }

  function showHandles(x, y) {
    for (const p of pieces) {
      if (p.gone) continue;
      const q = toLocal(p, x, y), near = !punching && !typing && inRect(p, q, 50) && !p.peel.off;
      const ks = rotCorners(p);
      p.handles.forEach((h, k) => {
        const active = (hover?.kind === 'rotate' && hover.piece === p && hover.k === k)
          || (drag?.type === 'rotate' && drag.piece === p && drag.k === k);
        h.style.opacity = !ks.includes(k) ? 0 : active ? 1 : (near && !drag) ? .45 : 0;
      });
    }
  }

  /* ---------- Pointer ---------- */

  function startPeel(p, C) {
    const pe = p.peel;
    if (!pe.on || hypot(pe.C.x - C.x, pe.C.y - C.y) > 1) {
      pe.C = { ...C }; pe.P = { ...C }; pe.V = { x: 0, y: 0 };
    }
    pe.on = true; pe.progress = 0;
  }
  function toFront(p) {
    pieces.splice(pieces.indexOf(p), 1); pieces.push(p);
    stage.appendChild(p.el);
  }

  addEventListener('pointerdown', e => {
    if (e.target.closest?.('button') || e.target.closest?.('.editor')) return;
    const x = e.clientX, y = e.clientY;
    const h = hitTest(x, y);
    if (typing) {
      commitEditor();
      if (h?.kind === 'body') textClick(h.p, h.q);
      return;
    }
    if (!h) return;
    if (punching) {
      if (h.kind !== 'body') return;
      const i = textAt(h.p, h.q);
      if (i >= 0) punchText(h.p, i); else punch(h.p, h.q, x, y);
      return;
    }

    const p = h.p;
    if (h.kind === 'rotate') {
      const tgt = p.joined ? pair : p.body;
      tgt.vx = tgt.vy = tgt.va = 0;
      drag = { type: 'rotate', piece: p, k: h.k, tgt, prev: Math.atan2(y - tgt.y, x - tgt.x) };
      setCursor(rotCursor(frame(p).a + h.k * Math.PI / 2));
    } else {
      if (!p.joined) toFront(p);
      const q = h.q, nc = nearestCorner(p, q);
      const edge = Math.min(q.x, q.y, p.W - q.x, p.H - q.y);
      const perfEdge = p.joined && (p.side === 'A' ? p.W - q.x : q.x) === edge;
      if (nc.d < zone(p)) {
        startPeel(p, nc.c);
        drag = { type: 'peel', piece: p };
      } else if (p.joined && (edge >= 16 || perfEdge)) {
        drag = { type: 'tear', piece: p, q0: toPair(x, y) };
      } else if (edge < 16) {
        const C = edge === q.x ? { x: 0, y: q.y } : edge === q.y ? { x: q.x, y: 0 }
                : edge === p.W - q.x ? { x: p.W, y: q.y } : { x: q.x, y: p.H };
        startPeel(p, C);
        drag = { type: 'peel', piece: p };
      } else {
        const b = p.body;
        b.vx = b.vy = b.va = 0;
        drag = { type: 'move', piece: p, grabR: { x: x - b.x, y: y - b.y } };
      }
      p.peel.T = q;
      setCursor('grabbing');
    }
    hover = null;
    lastP = { x, y, t: performance.now() };
    try { e.target.setPointerCapture(e.pointerId); } catch {}
  });

  addEventListener('pointermove', e => {
    const x = e.clientX, y = e.clientY;
    const now = performance.now();
    const dt = Math.max(1, now - lastP.t) / 16.67;

    if (drag?.type === 'move') moveDrag(x, y, dt);
    else if (drag?.type === 'peel') peelDrag(x, y);
    else if (drag?.type === 'rotate') {
      const t = drag.tgt;
      const ang = Math.atan2(y - t.y, x - t.x), da = wrap(ang - drag.prev);
      drag.prev = ang;
      t.a += da;
      t.va = t.va * .5 + da / dt * .5;
      setCursor(rotCursor(frame(drag.piece).a + drag.k * Math.PI / 2));
    } else if (drag?.type === 'tear') tearDrag(x, y);
    else if (!punching && !typing && e.pointerType === 'mouse') {
      const h = hitTest(x, y);
      hover = null;
      if (h?.kind === 'rotate') {
        hover = { kind: 'rotate', piece: h.p, k: h.k };
        setCursor(rotCursor(frame(h.p).a + h.k * Math.PI / 2));
      } else if (h) {
        const nc = nearestCorner(h.p, h.q), pe = h.p.peel;
        if (nc.d < zone(h.p)) {
          hover = { kind: 'peel', piece: h.p, c: nc.c, t: 1 - nc.d / zone(h.p) };
          if (!pe.on || hypot(pe.P.x - pe.C.x, pe.P.y - pe.C.y) < 1) startPeel(h.p, nc.c);
        }
        setCursor('grab');
      } else setCursor('');
    }
    showHandles(x, y);
    lastP = { x, y, t: now };
  });

  function release() {
    if (!drag) return;
    const stale = performance.now() - lastP.t > 80;
    if (drag.type === 'move' && stale) { const b = drag.piece.body; b.vx = b.vy = b.va = 0; }
    if (drag.type === 'rotate' && stale) drag.tgt.va = 0;
    if (drag.type === 'peel') {
      const pe = drag.piece.peel;
      if (pe.progress > .5) {
        // Past halfway: let go and it keeps going, flips all the way over, and lifts off.
        const ux = pe.P.x - pe.C.x, uy = pe.P.y - pe.C.y, L = hypot(ux, uy);
        const R = reach(drag.piece, pe.C, ux / L, uy / L);
        pe.off = 1; pe.offFrames = 0;
        pe.offT = { x: pe.C.x + ux / L * R * 2.15, y: pe.C.y + uy / L * R * 2.15 };
      }
    }
    if (drag.type === 'tear' && drag.end) {
      const t = pair.tears[drag.end];
      t.kT = 0;
      if (t.L < 3) t.L = 0;
    }
    drag = null;
    setCursor('');
    showHandles(lastP.x, lastP.y);
  }
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);

  // Paper dragged on a table: the far side lags behind and swings toward the trail.
  function moveDrag(x, y, dt) {
    const p = drag.piece, b = p.body, g = drag.grabR;
    const u0 = { x: b.x - lastP.x, y: b.y - lastP.y };
    const u1 = { x: b.x - x, y: b.y - y };
    const lever = clamp(hypot(g.x, g.y) / (Math.max(p.W, p.H) * .3), 0, 1);
    let dA = wrap(Math.atan2(u1.y, u1.x) - Math.atan2(u0.y, u0.x));
    dA = clamp(dA * .5 * lever * lever, -.12, .12);
    const pa = b.a, px = b.x, py = b.y;
    b.a += dA;
    drag.grabR = rot(g.x, g.y, dA);
    b.x = x - drag.grabR.x; b.y = y - drag.grabR.y;
    b.vx = b.vx * .5 + (b.x - px) / dt * .5;
    b.vy = b.vy * .5 + (b.y - py) / dt * .5;
    b.va = b.va * .5 + (b.a - pa) / dt * .5;
  }

  // How far the sheet extends from the grabbed point C along direction u.
  function reach(p, C, ux, uy) {
    let R = 0;
    for (const c of corners(p)) R = Math.max(R, (c.x - C.x) * ux + (c.y - C.y) * uy);
    return R;
  }

  function peelDrag(x, y) {
    const p = drag.piece, pe = p.peel, b = p.body;
    const q = toLocal(p, x, y);
    const vx = q.x - pe.C.x, vy = q.y - pe.C.y, L = hypot(vx, vy);
    if (L < .5) { pe.T = q; pe.progress = 0; return; }
    const R = reach(p, pe.C, vx / L, vy / L), max = R * 1.94;
    if (L > max) {
      // Folded as far as it goes: the rest of the sheet gets pulled along.
      const k = 1 - max / L;
      if (!p.joined) {
        const w = rot(vx * k, vy * k, b.a);
        b.x += w.x; b.y += w.y;
      }
      pe.T = { x: pe.C.x + vx * (1 - k), y: pe.C.y + vy * (1 - k) };
    } else pe.T = q;
    pe.progress = Math.min(L, max) / (2 * R);
  }

  /* ---------- Perforation tearing ----------
     Each end of the perforation has its own tear front. Only the torn strip of the held
     half bends open (a shear that leaves the front itself in place), so the untorn part
     stays joined. Tears from the top and bottom can meet in the middle. */

  const tornThrough = () => pair.tears.top.L + pair.tears.bottom.L >= S - 2;

  function tearDrag(x, y) {
    const p = drag.piece, q = toPair(x, y), dir = p.side === 'A' ? -1 : 1;
    const { top, bottom } = pair.tears;
    // Pull on whichever tear front is nearer to where the half was grabbed.
    drag.end ??= drag.q0.y - top.L < S - bottom.L - drag.q0.y ? 'top' : 'bottom';
    const t = pair.tears[drag.end];
    if (t.piece !== p && Math.abs(t.k) > .002) return;     // other half's strip is still settling
    t.piece = p;
    const d = Math.max(0, (q.x - drag.q0.x) * dir);
    const want = Math.min(d * 5, S);
    if (want > t.L) t.L += (want - t.L) * .35;
    t.kT = dir * Math.min(.22, d / Math.max(t.L, 24));
    if (tornThrough()) separate(p, x, y);
  }

  // A fold that crosses the perforation tears it from that end up to the crease.
  function foldTear(p) {
    const pe = p.peel, dx = pe.C.x - pe.P.x, dy = pe.C.y - pe.P.y, dist = hypot(dx, dy);
    if (dist < .5) return;
    const n = { x: dx / dist, y: dy / dist };
    const M = { x: (pe.C.x + pe.P.x) / 2, y: (pe.C.y + pe.P.y) / 2 };
    // Along the perforation edge the folded side is where s0 + y * n.y > 0.
    const s0 = ((p.side === 'A' ? p.W : 0) - M.x) * n.x - M.y * n.y;
    let top = 0, bottom = 0;
    if (Math.abs(n.y) < 1e-6) top = s0 > 0 ? p.H : 0;
    else {
      const ys = clamp(-s0 / n.y, 0, p.H);
      if (n.y > 0) bottom = p.H - ys; else top = ys;
    }
    const T = pair.tears;
    T.top.L = Math.max(T.top.L, top); T.bottom.L = Math.max(T.bottom.L, bottom);
    if (tornThrough()) separate(p, lastP.x, lastP.y, 'peel');
  }

  function separate(held, x, y, keep) {
    const other = pieces.find(p => p !== held);
    for (const p of [held, other]) {
      const f = frame(p), c = rot(p.W / 2, p.H / 2, f.a);
      p.body = makeBody(f.ox + c.x, f.oy + c.y, f.a);
      p.body.lift = pair.lift;
    }
    for (const p of pieces) {
      p.joined = false;
      p.edges = p.side === 'A' ? { left: 'cut', right: 'torn' } : { left: 'torn', right: 'cut' };
      p.base = basePoly(p);
    }
    pair = null;
    pieces.forEach(updateMask);
    // A little recoil on the half left behind
    const dx = other.body.x - held.body.x, dy = other.body.y - held.body.y, d = hypot(dx, dy) || 1;
    other.body.vx = dx / d * 1.6; other.body.vy = dy / d * 1.6;
    other.body.va = (Math.random() - .5) * .006;
    toFront(held);
    if (keep !== 'peel') drag = { type: 'move', piece: held, grabR: { x: x - held.body.x, y: y - held.body.y } };
    updateHint();
  }

  /* ---------- Hole punch ---------- */

  const chads = [];

  function punch(p, q, x, y) {
    const h = { x: q.x, y: q.y, r: HOLE_R };
    p.holes.push(h);
    updateMask(p);
    dropChad(p, h, x, y);
    press(p);
  }
  // The sheet gets pressed down for a beat.
  const press = p => { if (p.joined) pair.liftV -= .18; else p.body.liftV -= .18; };

  // The punched-out disc tumbles off the bottom of the screen.
  function dropChad(p, h, x, y) {
    const d = h.r * 2;
    const el = document.createElement('div');
    el.className = 'chad';
    el.style.width = el.style.height = d + 'px';
    el.style.backgroundSize = `${S}px ${S}px`;
    el.style.backgroundPosition = `${-(h.x + p.texX - h.r)}px ${-(h.y - h.r)}px`;
    chadsEl.appendChild(el);
    chads.push({
      el, w: d, h: d, x, y, a: frame(p).a, delay: 0,
      vx: (Math.random() - .5) * 2.4, vy: -1.5 - Math.random() * 2,
      va: (Math.random() - .5) * .25, flip: Math.random() * 6, flipV: .12 + Math.random() * .2,
    });
  }

  function tickChads() {
    for (let i = chads.length - 1; i >= 0; i--) {
      const c = chads[i];
      if (c.delay > 0) {
        c.delay--;
        c.el.style.transform = `translate(${c.x - c.w / 2}px,${c.y - c.h / 2}px) rotate(${c.a}rad)`;
        continue;
      }
      c.vy = Math.min(c.vy + .32, 14);            // gravity, with a little air drag on top speed
      c.vx *= .99;
      c.x += c.vx + Math.sin(c.flip) * .4;         // flutter
      c.y += c.vy;
      c.a += c.va; c.flip += c.flipV;
      const sy = .35 + .65 * Math.abs(Math.cos(c.flip));   // tumbling disc foreshortens
      c.el.style.transform = `translate(${c.x - c.w / 2}px,${c.y - c.h / 2}px) rotate(${c.a}rad) scaleY(${sy})`;
      if (c.y - Math.max(c.w, c.h) > innerHeight) { c.el.remove(); chads.splice(i, 1); }
    }
  }

  function setPunching(on) {
    if (on && typing) setTyping(false);
    punching = on;
    hover = null;
    setCursor('');
    document.body.classList.toggle('punching', on);
    $('punch').classList.toggle('on', on);
    showHandles(lastP.x, lastP.y);
    updateHint();
  }

  /* ---------- Text ----------
     Text is printed into the sheet as SVG, so the same markup can be reused in the
     mask to die-cut the letters out of the paper. */

  const FONT = 'Iowan Old Style, Palatino, Georgia, serif';
  const TEXT_SIZE = Math.round(S * .055);
  let typing = false;
  let editor = null;        // { el, p, x, y, size }

  const esc = s => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  function textSvg(t, i) {
    const spans = t.lines.map((l, k) => `<tspan x='${t.x}'${k ? ` dy='${t.size * 1.2}'` : ''}>${esc(l || ' ')}</tspan>`).join('');
    return `<text data-i='${i}' x='${t.x}' y='${t.y}' font-family='${FONT}' font-size='${t.size}' style='white-space:pre'>${spans}</text>`;
  }
  function renderInk(p) {
    const markup = p.texts.map((t, i) => t.cut ? '' : textSvg(t, i)).join('');
    p.inks.forEach(el => { el.innerHTML = markup; });
  }

  function textAt(p, q) {
    for (let i = p.texts.length - 1; i >= 0; i--) {
      const node = !p.texts[i].cut && p.inks[0].querySelector(`text[data-i='${i}']`);
      if (!node) continue;
      const b = node.getBBox();
      if (q.x >= b.x - 4 && q.x <= b.x + b.width + 4 && q.y >= b.y - 4 && q.y <= b.y + b.height + 4) return i;
    }
    return -1;
  }

  function textClick(p, q) {
    const i = textAt(p, q);
    if (i >= 0) {
      const t = p.texts.splice(i, 1)[0];
      renderInk(p);
      openEditor(p, t.x, t.y, t.size, t.lines);
    } else openEditor(p, q.x, q.y + TEXT_SIZE * .35, TEXT_SIZE);
  }

  function openEditor(p, x, y, size, lines) {
    const el = document.createElement('div');
    el.className = 'editor';
    el.contentEditable = 'plaintext-only';
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.spellcheck = false;
    el.style.fontSize = size + 'px';
    el.style.left = x + 'px';
    el.style.top = (y - size * 1.02) + 'px';
    el.textContent = lines ? lines.join('\n') : '';
    p.sheet.appendChild(el);
    editor = { el, p, x, y, size };
    setTimeout(() => {
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el); r.collapse(false);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    });
  }

  function commitEditor() {
    if (!editor) return;
    const { el, p, x, y, size } = editor;
    editor = null;
    const lines = el.innerText.replace(/\n+$/, '').split('\n');
    el.remove();
    if (lines.some(l => l.trim())) p.texts.push({ x, y, size, lines, cut: false });
    renderInk(p);
  }

  function setTyping(on) {
    if (!on) commitEditor();
    if (on && punching) setPunching(false);
    typing = on;
    hover = null;
    setCursor('');
    document.body.classList.toggle('typing', on);
    $('text').classList.toggle('on', on);
    showHandles(lastP.x, lastP.y);
    updateHint();
  }

  // Die-cut a line of text: the letters become holes and fall out of the sheet one by one.
  function punchText(p, i) {
    const t = p.texts[i];
    const node = p.inks[0].querySelector(`text[data-i='${i}']`);
    const chars = t.lines.map(l => l || ' ').join('');
    const a = frame(p).a, n = Math.min(node.getNumberOfChars(), chars.length);
    let k = 0;
    for (let c = 0; c < n; c++) {
      if (chars[c].trim()) dropLetter(p, chars[c], node.getExtentOfChar(c), node.getStartPositionOfChar(c), t.size, a, k++);
    }
    t.cut = true;
    renderInk(p);
    updateMask(p);
    press(p);
  }

  // Each letter is redrawn at its exact baseline position, so it starts out filling its own hole.
  function dropLetter(p, ch, b, start, size, a, k) {
    const el = document.createElement('div');
    el.className = 'letter';
    el.innerHTML = `<svg width='${b.width}' height='${b.height}'><text x='${start.x - b.x}' y='${start.y - b.y}' `
      + `font-family='${FONT}' font-size='${size}'>${esc(ch)}</text></svg>`;
    chadsEl.appendChild(el);
    const c = toWorld(p, b.x + b.width / 2, b.y + b.height / 2);
    chads.push({
      el, w: b.width, h: b.height, x: c.x, y: c.y, a, delay: 6 + k * 2,
      vx: (Math.random() - .5) * 2, vy: -1 - Math.random() * 2,
      va: (Math.random() - .5) * .12, flip: 0, flipV: .05 + Math.random() * .12,
    });
  }

  /* ---------- Geometry ---------- */

  function clipHalf(poly, M, n, sign) {
    const out = [];
    const side = p => ((p.x - M.x) * n.x + (p.y - M.y) * n.y) * sign;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = side(a), db = side(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return out;
  }
  const polyCss = pts => `polygon(${pts.map(p => `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`).join(',')})`;

  /* ---------- Loop ---------- */

  function keepOnScreen(b, m) {
    if (b.x < m) { b.x = m; b.vx *= -.3; }
    if (b.x > innerWidth - m) { b.x = innerWidth - m; b.vx *= -.3; }
    if (b.y < m) { b.y = m; b.vy *= -.3; }
    if (b.y > innerHeight - m) { b.y = innerHeight - m; b.vy *= -.3; }
  }
  function settle(b, target) {
    b.liftV = (b.liftV + (target - b.lift) * .12) * .72;
    b.lift += b.liftV;
  }
  const liftFor = p => drag?.piece !== p ? 0
    : drag.type === 'move' ? 1 : drag.type === 'tear' ? .5 : drag.type === 'peel' ? .3 : .2;

  function tick() {
    if (pair) {
      if (drag?.tgt !== pair) {
        pair.a += pair.va; pair.va *= .9;
      }
      keepOnScreen(pair, S * .25);
      settle(pair, drag && pieces.includes(drag.piece) ? liftFor(drag.piece) : 0);
      for (const t of Object.values(pair.tears)) {
        t.kV = (t.kV + (t.kT - t.k) * .3) * .6;
        t.k += t.kV;
        if (!t.kT && Math.abs(t.k) < .0005) t.k = t.kV = 0;
      }
      const sig = `${Math.round(pair.tears.top.L)},${Math.round(pair.tears.bottom.L)}`;
      if (sig !== pair.maskSig) { pair.maskSig = sig; pieces.forEach(updateMask); }
    }

    for (const p of [...pieces]) {     // a copy: tearing through reorders pieces
      if (p.gone) continue;
      const b = p.body, pe = p.peel;
      if (p.joined && pe.on && (pe.off || (drag?.type === 'peel' && drag.piece === p))) foldTear(p);
      if (!p.joined) {
        if (!(drag?.piece === p && (drag.type === 'move' || drag.type === 'rotate'))) {
          b.x += b.vx; b.y += b.vy; b.a += b.va;
          b.vx *= .92; b.vy *= .92; b.va *= .9;
        }
        keepOnScreen(b, Math.min(p.W, p.H) * .25);
        settle(b, pe.off ? .6 : liftFor(p));
      }

      if (pe.on) {
        let T, k = .13, d = .74;
        if (pe.off) { T = pe.offT; k = .045; d = .88; pe.offFrames++; }
        else if (drag?.type === 'peel' && drag.piece === p) { T = pe.T; k = .35; d = .55; }
        else if (hover?.kind === 'peel' && hover.piece === p && hover.c.x === pe.C.x && hover.c.y === pe.C.y) {
          const ix = p.W / 2 - pe.C.x, iy = p.H / 2 - pe.C.y, il = hypot(ix, iy);
          const amt = Math.min(p.W, p.H) * (.02 + .07 * hover.t * hover.t);
          T = { x: pe.C.x + ix / il * amt, y: pe.C.y + iy / il * amt };
        } else T = pe.C;
        pe.V.x = (pe.V.x + (T.x - pe.P.x) * k) * d;
        pe.V.y = (pe.V.y + (T.y - pe.P.y) * k) * d;
        pe.P.x += pe.V.x; pe.P.y += pe.V.y;
        if (pe.off === 1 && pe.offFrames > 90) pe.off = 2;
        if (pe.off === 2) {
          pe.liftOff += 1 / 48;
          if (pe.liftOff >= 1) { p.gone = true; p.el.style.display = 'none'; updateHint(); continue; }
        }
        if (!pe.off && !drag && !hover && hypot(pe.P.x - pe.C.x, pe.P.y - pe.C.y) < .3 && hypot(pe.V.x, pe.V.y) < .05) {
          pe.on = false; pe.P = { ...pe.C };
        }
      }
      render(p);
    }

    tickChads();
    requestAnimationFrame(tick);
  }

  function render(p) {
    const f = frame(p), l = p.joined ? pair.lift : p.body.lift, pe = p.peel, lo = pe.liftOff;
    p.el.style.transform = `translate(${f.ox}px,${f.oy - 40 * lo * lo}px) rotate(${f.a}rad)`;
    p.el.style.setProperty('--ang', (115 - f.a * 57.3) + 'deg');

    // Light comes from above, so shadow offsets are fixed in screen space.
    const so = rot(.5 + 3 * l, 1.5 + 14 * l, -f.a);
    p.sw.style.filter = `blur(${Math.max(0, 1.5 + 16 * l)}px)`;
    p.ss.style.transform = `translate(${so.x}px,${so.y}px)`;
    p.ss.style.background = `rgb(52 40 20 / ${.09 + .07 * l})`;

    const stripClip = renderStrips(p, so);
    const baseClip = stripClip ?? (isTorn(p) ? polyCss(p.base) : 'none');
    const dx = pe.C.x - pe.P.x, dy = pe.C.y - pe.P.y, dist = hypot(dx, dy);
    const flat = () => {
      p.sheet.style.display = p.sw.style.display = 'block';
      p.sheet.style.clipPath = p.ss.style.clipPath = baseClip;
      p.flap.style.display = p.fsw.style.display = 'none';
    };
    if (!pe.on || dist < .5 || stripClip) return flat();

    const n = { x: dx / dist, y: dy / dist };
    const M = { x: (pe.C.x + pe.P.x) / 2, y: (pe.C.y + pe.P.y) / 2 };
    const main = clipHalf(p.base, M, n, -1), part = clipHalf(p.base, M, n, 1);
    if (part.length < 3) return flat();

    if (main.length < 3) {
      // Folded all the way over: nothing left lying on the table.
      p.sheet.style.display = p.sw.style.display = 'none';
      if (pe.off === 1) pe.off = 2;
    } else {
      p.sheet.style.display = p.sw.style.display = 'block';
      p.sheet.style.clipPath = p.ss.style.clipPath = polyCss(main);
    }

    // Reflect the folded part across the crease line.
    const ux = -n.y, uy = n.x;
    const a = ux * ux - uy * uy, b = 2 * ux * uy, dd = uy * uy - ux * ux;
    const e = M.x - (a * M.x + b * M.y), g = M.y - (b * M.x + dd * M.y);
    const mtx = `matrix(${a},${b},${b},${dd},${e},${g})`;

    p.flap.style.display = 'block';
    p.flap.style.clipPath = polyCss(part);
    p.flap.style.transform = mtx;
    p.flap.style.opacity = 1 - lo;

    let depth = 0;
    for (const pt of part) depth = Math.max(depth, (pt.x - M.x) * n.x + (pt.y - M.y) * n.y);
    const H = Math.max(p.W, p.H) * 3;
    Object.assign(p.shade.style, {
      left: M.x + 'px', top: (M.y - H / 2) + 'px', width: (depth + 2) + 'px', height: H + 'px',
      transform: `rotate(${Math.atan2(n.y, n.x)}rad)`,
    });

    const k = clamp(dist / (Math.min(p.W, p.H) * .5), 0, 1);
    const fo = rot((1 + 4 * k) * (1 + 3 * lo), (2 + 7 * k) * (1 + 4 * lo), -f.a);
    p.fsw.style.display = 'block';
    p.fsw.style.opacity = 1 - lo;
    p.fsw.style.filter = `blur(${2 + 8 * k + 18 * lo}px)`;
    p.fs.style.clipPath = polyCss(part);
    p.fs.style.transform = `translate(${fo.x}px,${fo.y}px) ${mtx}`;
    p.fs.style.background = `rgb(52 40 20 / ${.08 + .1 * k})`;
  }

  // Torn ends of a joined half bend open along the perforation. Each strip is sheared about
  // its tear front, so it stays attached there. Returns the clip for the untorn middle, if any.
  function renderStrips(p, so) {
    const rect = (y0, y1) => polyCss([{ x: 0, y: y0 }, { x: p.W, y: y0 }, { x: p.W, y: y1 }, { x: 0, y: y1 }]);
    let y0 = 0, y1 = p.H, any = false;
    ['top', 'bottom'].forEach((end, i) => {
      const t = p.joined && pair.tears[end];
      const on = t && t.piece === p && t.k !== 0 && t.L > .5;
      p.strips[i].style.display = p.sts[i].style.display = on ? 'block' : 'none';
      if (!on) return;
      any = true;
      const sg = end === 'top' ? -1 : 1, front = end === 'top' ? t.L : p.H - t.L;
      const m = `matrix(1,0,${sg * t.k},1,${-sg * t.k * front},0)`;
      const clip = end === 'top' ? rect(0, front + .5) : rect(front - .5, p.H);
      p.strips[i].style.clipPath = p.sts[i].style.clipPath = clip;
      p.strips[i].style.transform = m;
      p.sts[i].style.transform = `translate(${so.x}px,${so.y}px) ${m}`;
      p.sts[i].style.background = p.ss.style.background;
      if (end === 'top') y0 = front; else y1 = front;
    });
    return any ? rect(y0, y1) : null;
  }

  /* ---------- UI ---------- */

  $('punch').addEventListener('click', () => setPunching(!punching));
  $('perf').addEventListener('click', e => {
    variant = variant === 'plain' ? 'perf' : 'plain';
    e.currentTarget.classList.toggle('on', variant === 'perf');
    build();
  });
  $('toggleUnder').addEventListener('click', e => {
    const on = document.body.classList.toggle('under');
    e.currentTarget.textContent = on ? 'Hide underlay' : 'Show underlay';
  });
  $('reset').addEventListener('click', build);
  $('text').addEventListener('click', () => setTyping(!typing));
  addEventListener('keydown', e => {
    if (e.target.isContentEditable) { if (e.key === 'Escape') setTyping(false); return; }
    if (e.key === 'h' || e.key === 'H') setPunching(!punching);
    else if (e.key === 't' || e.key === 'T') setTyping(!typing);
    else if (e.key === 'Escape') { setPunching(false); setTyping(false); }
  });

  setPunchCursor();
  build();
  makeTexture().then(url => {
    // A real rule, not a custom property: Firefox (and Zen) won't paint an image URL that
    // arrives through var() set from script.
    const css = document.createElement('style');
    css.textContent = `.tex, .chad { background-image:url("${url}"); }`;
    document.head.append(css);
    stage.classList.add('ready');
  });
  requestAnimationFrame(tick);
})();
