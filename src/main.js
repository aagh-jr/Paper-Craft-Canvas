(() => {
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const stage = $('stage'), chadsEl = $('chads'), hintEl = $('hint');
  // A page embedding the paper can set window.PAPER_CONFIG before this script:
  //   border  the starting border ('none' or a name in BORDERS)
  //   keys    false turns off the H (punch) and T (type) shortcuts
  //   ignore  a selector; pointer presses and hovers over it never reach the paper
  const CONFIG = { border: 'none', keys: true, ignore: '', ...window.PAPER_CONFIG };
  const ignored = e => !!CONFIG.ignore && !!e.target.closest?.(CONFIG.ignore);

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const hypot = Math.hypot;
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const rot = (x, y, a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return { x: x * c - y * s, y: x * s + y * c };
  };

  /* ---------- Metallic shine ----------
     The bright bands on metallic paper slide with the pointer, or with the sheet where there's
     no hover. With reduced motion they hold still in the middle (the sheet's turn still swings
     them, as it would on real foil). */
  const noHover = matchMedia('(hover: none)'), still = matchMedia('(prefers-reduced-motion: reduce)');
  let glint = .5;
  function setGlint(g) {
    g = still.matches ? .5 : clamp(g, 0, 1);
    if (Math.abs(g - glint) < .002 || !document.body.classList.contains('metal')) return;
    glint = g;
    root.style.setProperty('--glint', g.toFixed(3));
  }
  still.addEventListener('change', () => { if (still.matches) { glint = .5; root.style.setProperty('--glint', '.5'); } });

  /* ---------- Undo ----------
     Cmd/Ctrl+Z steps back through what was done: the switches, paper, font and theme, punched
     holes and letters, typed text, and the letter's edits and marks. Each entry is a function
     that puts things back; replaying one never records a new entry. */
  const undoStack = [];
  let replaying = false;
  const remember = fn => {
    if (replaying) return;
    undoStack.push(fn);
    if (undoStack.length > 200) undoStack.shift();
  };
  function undo() {
    const fn = undoStack.pop();
    if (!fn) return;
    replaying = true;
    try { fn(); } finally { replaying = false; }
  }

  // The original study drew a 1024px canvas across a ~527px sheet. Keep that grain density on
  // any sheet size: a bigger sheet gets a bigger canvas, not a stretched one.
  const TEX_DENSITY = 1024 / 527;
  let TEXS = 0;                     // css px covered by one texture tile (set when it's drawn)

  // Opened from disk, Firefox (and Zen) won't paint a blob: URL as a CSS background, so the
  // texture goes in as a data: URL there.
  function textureUrl(cv) {
    if (location.protocol === 'file:') return Promise.resolve(cv.toDataURL('image/png'));
    return new Promise(res => cv.toBlob(b => res(URL.createObjectURL(b)), 'image/png'));
  }

  /* ---------- Pieces ----------
     A piece is one physical sheet: the plain square, or one half of the perforated one.
     While the perforated halves are still joined they share the `pair` body. */

  // The sheet is the letter, so its size comes from laying out the letter text.
  // S is the texture tile size (it must cover the whole sheet).
  const letterTpl = $('letter'), slot = $('slot');
  let S, W, H, HOLE_R, TEXT_SIZE;
  // #slot holds an invisible copy of the letter, so CSS lays it out (fonts, breakpoints) and
  // reserves its place on the page; the parchment sheet is built to match it.
  function measure() {
    const r = slot.getBoundingClientRect();
    W = Math.round(r.width); H = Math.ceil(r.height);
    S = Math.max(W, H);
    HOLE_R = .022 * Math.min(W, H);
    TEXT_SIZE = parseFloat(getComputedStyle(slot.querySelector('p')).fontSize);   // typed text matches the letter
  }
  // Blocks of color on the table behind the sheet, under the words marked data-block.
  // They stay put when the sheet moves, so they only show through where the vellum lies.
  const blocksEl = $('blocks');
  // Marks punch out unless they're pressed in or raised instead.
  const CUT_MARKS = '[data-block]:not([data-mark="in"], [data-mark="out"])';
  function placeBlocks() {
    blocksEl.replaceChildren();
    for (const span of slot.querySelectorAll(CUT_MARKS)) {
      // Text gets one block per line; anything else (the signature) gets one block.
      const range = document.createRange();
      range.selectNodeContents(span);
      const rects = span instanceof SVGElement ? [span.getBoundingClientRect()] : range.getClientRects();
      for (const r of rects) {
        const b = document.createElement('div');
        b.className = 'block';
        // A little past the words and blurred (style.css), so the color ombrés out around them.
        b.style.cssText = `left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px;`
          + `background:var(--block-${span.dataset.block})`;
        blocksEl.append(b);
      }
    }
  }
  function writeLetter(p) {
    // Above the sheen, so the gloss doesn't wash out a band of words.
    p.sheet.querySelector('.sheen').after(letterTpl.content.cloneNode(true));
    const back = letterTpl.content.firstElementChild.cloneNode(true);
    back.setAttribute('aria-hidden', 'true');
    back.inert = true;
    p.flap.prepend(back);
  }
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
      <div class="layer clipw"><div class="layer tex holed sheet">${SURFACE}</div></div>
      <svg class="thick tmain"></svg>
      <div class="layer tex holed strip">${SURFACE}</div>
      <div class="layer tex holed strip">${SURFACE}</div>
      <div class="shadow-wrap fsw"><div class="layer shadow holed fs"></div></div>
      <div class="layer clipw flapw"><div class="layer tex holed flap"><svg class="ink"></svg><div class="flapShade"></div><svg class="rims"></svg></div></div>
      <svg class="thick tflap"></svg>
      ${[0, 1, 2, 3].map(k => `<div class="rot" style="left:${k === 1 || k === 2 ? W : 0}px;top:${k >= 2 ? H : 0}px;transform:rotate(${k * 90}deg)">${ROT_ICON}</div>`).join('')}`;
    stage.appendChild(el);
    const q = s => el.querySelector(s);
    const p = {
      el, W, H, texX, side, joined: !!side, edges: { left: 'cut', right: 'cut' },
      body: makeBody(0, 0, 0), holes: [], texts: [], gone: false,
      peel: { on: false, C: { x: 0, y: 0 }, P: { x: 0, y: 0 }, V: { x: 0, y: 0 }, T: { x: 0, y: 0 },
              progress: 0, off: 0, offT: null, offFrames: 0, liftOff: 0 },
      sw: q('.sw'), ss: q('.ss'), tmain: q('.tmain'), tflap: q('.tflap'), sheet: q('.sheet'), sheetW: q('.clipw'), flapW: q('.flapw'),
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

  // Binder holes: center in from the left edge, and radius (px).
  const BINDER = { x: 28, r: 8 };

  // Perforation slits; each half owns `depth` px of every slit.
  const PERF = { start: 3, pitch: 11, len: 5, depth: 2.5 };

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
    // A border reshapes the whole outline (and takes the place of any corner shape). The halves
    // of a perforated sheet keep straight edges.
    if (!p.side && BORDERS[border]) return BORDERS[border](W, H);
    // A shaped corner replaces the corner point, walking from the edge it arrives on to the next.
    const cut = (x, y, din, dout) => p.side || !CORNERS[corner] ? [{ x, y }] : CORNERS[corner](x, y, din, dout);
    return [
      ...cut(0, 0, { x: 0, y: -1 }, { x: 1, y: 0 }), ...cut(W, 0, { x: 1, y: 0 }, { x: 0, y: 1 }),
      ...(p.edges.right === 'torn' ? perfEdge(W, -1, true) : []),
      ...cut(W, H, { x: 0, y: 1 }, { x: -1, y: 0 }), ...cut(0, H, { x: -1, y: 0 }, { x: 0, y: -1 }),
      ...(p.edges.left === 'torn' ? perfEdge(0, 1, false) : []),
    ];
  }

  // Corner shapes, by name; 'square' has none. Each takes the corner and the directions of the
  // edges arriving at and leaving it, and returns the outline in order.
  // Scalloped: a square notch cut out of the corner, with a quarter-round tab rising from the
  // notch's inner corner toward the outer one, like a die-cut stationery card.
  // notch: the square's side. r: the tab's radius, a little less, so a short step shows each side.
  const SCALLOP = { notch: 14, r: 10 };
  const CORNERS = {
    scalloped(x, y, din, dout) {
      const { notch, r } = SCALLOP;
      // The notch's inner corner, `notch` in from each edge.
      const O = { x: x + (dout.x - din.x) * notch, y: y + (dout.y - din.y) * notch };
      const pts = [{ x: x - din.x * notch, y: y - din.y * notch }];
      for (let i = 0; i <= 12; i++) {
        const t = Math.PI / 2 * i / 12;     // from the step off the incoming edge round to the outgoing one
        pts.push({ x: O.x - dout.x * r * Math.cos(t) + din.x * r * Math.sin(t),
                   y: O.y - dout.y * r * Math.cos(t) + din.y * r * Math.sin(t) });
      }
      pts.push({ x: x + dout.x * notch, y: y + dout.y * notch });
      return pts;
    },
  };
  let corner = 'square';

  // Border shapes, by name; 'none' has none. Each returns the whole outline, inside W x H.
  // Hills: a row of round bumps all the way around, like UUUU along the bottom. The tops of the
  // bumps touch the sheet's edge and the dips between them sit `depth` in, so the sheet keeps
  // its size. Each corner is one round hill (a circle `width` across, touching both edges) that
  // wraps around it; each side between gets a whole number of bumps about `width` wide.
  const HILLS = { width: 16, depth: 6, steps: 8 };
  const BORDERS = {
    hills(W, H) {
      const { width, depth: d, steps } = HILLS;
      const r = width / 2, e = Math.sqrt(r * r - (r - d) ** 2);   // where a corner hill meets the dip line
      const sides = [     // dip to dip, clockwise, with the outward direction and the corner after it
        [{ x: r + e, y: d }, { x: W - r - e, y: d }, { x: 0, y: -1 }, { x: W - r, y: r }],
        [{ x: W - d, y: r + e }, { x: W - d, y: H - r - e }, { x: 1, y: 0 }, { x: W - r, y: H - r }],
        [{ x: W - r - e, y: H - d }, { x: r + e, y: H - d }, { x: 0, y: 1 }, { x: r, y: H - r }],
        [{ x: d, y: H - r - e }, { x: d, y: r + e }, { x: -1, y: 0 }, { x: r, y: r }],
      ];
      const pts = [];
      sides.forEach(([A, B, n, C], j) => {
        const L = Math.hypot(B.x - A.x, B.y - A.y), ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
        const count = Math.max(1, Math.round(L / width)), w = L / count;
        pts.push({ ...A });
        for (let k = 0; k < count; k++) {
          for (let i = 1; i <= steps; i++) {
            const t = Math.PI * i / steps;      // round each bump, from dip to top to dip
            const along = w * (k + (1 - Math.cos(t)) / 2), out = d * Math.sin(t);
            pts.push({ x: A.x + ux * along + n.x * out, y: A.y + uy * along + n.y * out });
          }
        }
        // The corner hill: round the outside of the circle from this side's last dip to the next side's first.
        const next = sides[(j + 1) % 4][0];
        const a0 = Math.atan2(B.y - C.y, B.x - C.x);
        let a1 = Math.atan2(next.y - C.y, next.x - C.x);
        while (a1 <= a0) a1 += Math.PI * 2;
        const n2 = steps * 2;
        for (let i = 1; i < n2; i++) {
          const a = a0 + (a1 - a0) * i / n2;
          pts.push({ x: C.x + r * Math.cos(a), y: C.y + r * Math.sin(a) });
        }
      });
      return pts;
    },
  };
  let border = CONFIG.border;
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
    if (p.cutMask) cut += `<image href='${p.cutMask}' width='${W}' height='${H}' preserveAspectRatio='none'/>`;
    // The letter's perforated rule above the links, edge to edge, and the vertical perforations
    // splitting the strip below it into tabs, in the same slits as the tear line.
    if (p.ruleY != null) {
      for (let x = PERF.start; x + PERF.len < W; x += PERF.pitch)
        cut += `<rect x='${x}' y='${p.ruleY - PERF.depth}' width='${PERF.len}' height='${PERF.depth * 2}'/>`;
      for (const cx of p.tabXs)
        for (let y = p.ruleY + PERF.pitch / 2; y + PERF.len < H; y += PERF.pitch)
          cut += `<rect x='${cx - PERF.depth}' y='${y}' width='${PERF.depth * 2}' height='${PERF.len}'/>`;
    }
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

  let texReady = false;
  function build() {
    const prevIntro = pieces[0]?.intro;      // a rebuild mid-intro (fonts arriving) keeps it going
    stage.replaceChildren();
    chads.length = 0; chadsEl.replaceChildren();
    if (drag?.type !== 'size' && drag?.type !== 'spin') drag = null;     // resizing rebuilds mid-drag
    hover = editor = null;
    const cx = innerWidth / 2, cy = innerHeight / 2;
    if (variant === 'plain') {
      pair = null;
      const p = createPiece(W, H, 0, null), r = slot.getBoundingClientRect();
      p.base = basePoly(p);
      // Two binder holes in the left margin, a quarter of the way in from the top and bottom.
      if (document.body.classList.contains('binder'))
        p.holes.push(...[.25, .75].map(k => ({ x: BINDER.x, y: H * k, r: BINDER.r })));
      if (!document.body.classList.contains('no-links')) {
        const tabs = [...slot.querySelector('.links').children];
        p.ruleY = tabs[0].getBoundingClientRect().top - r.top;
        p.tabXs = tabs.slice(1).map(a => a.getBoundingClientRect().left - r.left);
      }
      updateMask(p);
      p.body = makeBody(r.left + r.width / 2, r.top + r.height / 2, 0);
      p.rest = { x: p.body.x, y: p.body.y };
      writeLetter(p);
      if (cutout) applyCut(p);
      if (introPending || prevIntro) { introPending = false; startIntro(p, prevIntro?.t0); }
      pieces = [p];
    } else {
      // Each end of the perforation tears independently; the halves part once the fronts meet.
      const tear = () => ({ L: 0, k: 0, kV: 0, kT: 0, piece: null });
      pair = { ...makeBody(cx, cy, -0.035), tears: { top: tear(), bottom: tear() }, maskSig: '0,0' };
      pieces = [createPiece(S / 2, S, 0, 'A'), createPiece(S / 2, S, S / 2, 'B')];
    }
    pieces.forEach(render);      // in place right away, not at the origin until the next frame
    updateHint();
  }

  function updateHint() {
    let t;
    if (typing) t = 'Click the paper to type · click a line to edit it · T or Esc when done';
    else if (punching) t = 'Click to punch a hole · click a line of text to punch its letters out · H or Esc when done';
    else if (pieces.every(p => p.gone)) t = 'Peeled clean off. Hit Reset for a fresh sheet';
    else if (pair) t = 'Pull a half sideways to tear the perforation from the nearer end · tear from both ends to meet in the middle · peel a corner to rip it off';
    else t = 'Drag to slide · grab outside a corner to rotate · peel a corner past halfway and it comes off';
    if (hintEl) hintEl.textContent = t;
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

  // The cover's sheet doesn't rotate, so its rotate handles never show.
  function showHandles() {
    for (const p of pieces) p.handles.forEach(h => { h.style.opacity = 0; });
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
    if (e.target.closest?.('a, button, select, label, .editor') || ignored(e)) return;
    if (editing) return;            // clicks place the caret and select text
    // Resize on: the sheet's sides and corners resize it (and nothing peels).
    const edges = resizing && edgesAt(e.clientX, e.clientY);
    if (edges) {
      const r = slot.getBoundingClientRect();
      drag = { type: 'size', edges, x0: e.clientX, y0: e.clientY, w0: r.width, h0: r.height };
      return;
    }
    const x = e.clientX, y = e.clientY;
    const h = hitTest(x, y);
    if (typing) {
      commitEditor();
      if (h?.kind === 'body') textClick(h.p, h.q);
      return;
    }
    if (!h) {
      // Spin on: dragging on the page around the sheet turns it.
      if (spin && !punching) { drag = { type: 'spin', x, y }; setCursor('grabbing'); }
      return;
    }
    if (punching) {
      if (h.kind !== 'body') return;
      const i = textAt(h.p, h.q);
      if (i >= 0) punchText(h.p, i); else punch(h.p, h.q, x, y);
      return;
    }

    // The cover's sheet stays where it is: no sliding or rotating. Only its corners and edges
    // peel; a press anywhere else is left alone so the letter's text can be selected.
    const p = h.p;
    if (h.kind === 'rotate' || resizing) return;
    {
      const q = h.q, edge = Math.min(q.x, q.y, p.W - q.x, p.H - q.y);
      if (!p.joined && nearestCorner(p, q).d >= zone(p) && edge >= 16) return;
    }
    endIntro(p);
    {
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

    if (drag?.type === 'size') resizeTo(x, y);
    else if (drag?.type === 'spin') {
      spinOff.x = clamp(spinOff.x + (x - drag.x) * SPIN.drag, -SPIN.max, SPIN.max);
      spinOff.y = clamp(spinOff.y + (y - drag.y) * SPIN.drag, -SPIN.max, SPIN.max);
      drag.x = x; drag.y = y;
    }
    else if (drag?.type === 'move') moveDrag(x, y, dt);
    else if (drag?.type === 'peel') peelDrag(x, y);
    else if (drag?.type === 'rotate') {
      const t = drag.tgt;
      const ang = Math.atan2(y - t.y, x - t.x), da = wrap(ang - drag.prev);
      drag.prev = ang;
      t.a += da;
      t.va = t.va * .5 + da / dt * .5;
      setCursor(rotCursor(frame(drag.piece).a + drag.k * Math.PI / 2));
    } else if (drag?.type === 'tear') tearDrag(x, y);
    else if (e.target.closest?.('a') || ignored(e)) { hover = null; setCursor(''); }
    else if (resizing) { hover = null; const ed = edgesAt(x, y); setCursor(ed ? EDGE_CURSOR[ed] : ''); }     // links on and off the letter stay links
    else if (!punching && !typing && !editing && e.pointerType === 'mouse') {
      const h = hitTest(x, y);
      hover = null;
      if (h && h.kind !== 'rotate') {
        const nc = nearestCorner(h.p, h.q), pe = h.p.peel;
        const edge = Math.min(h.q.x, h.q.y, h.p.W - h.q.x, h.p.H - h.q.y);
        if (nc.d < zone(h.p)) {
          hover = { kind: 'peel', piece: h.p, c: nc.c, t: 1 - nc.d / zone(h.p) };
          if (!pe.on || hypot(pe.P.x - pe.C.x, pe.P.y - pe.C.y) < 1) startPeel(h.p, nc.c);
        }
        setCursor(hover || edge < 16 ? 'grab' : '');
      } else setCursor('');
    }
    showHandles(x, y);
    if (!noHover.matches) setGlint(x / innerWidth);     // the shine follows the pointer
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

  // The folded-over corner can't cross the edges it was grabbed on: past them the flap would
  // hang off the side of the sheet at an odd angle, or, just outside the corner, the whole sheet
  // would count as the flap and flip over. Past the far edges is fine (peeling it off).
  function keepIn(p, q) {
    const C = p.peel.C;
    if (C.x === 0) q.x = Math.max(q.x, 0); else if (C.x === p.W) q.x = Math.min(q.x, p.W);
    if (C.y === 0) q.y = Math.max(q.y, 0); else if (C.y === p.H) q.y = Math.min(q.y, p.H);
    return q;
  }

  function peelDrag(x, y) {
    const p = drag.piece, pe = p.peel;
    const q = keepIn(p, toLocal(p, x, y));
    const vx = q.x - pe.C.x, vy = q.y - pe.C.y, L = hypot(vx, vy);
    if (L < .5) { pe.T = q; pe.progress = 0; return; }
    const R = reach(p, pe.C, vx / L, vy / L), max = R * 1.94;
    // Pulled outward or along an edge, there's no paper to fold over: the corner stays down
    // instead of the whole sheet flipping. A fold has to head in toward the middle of the sheet.
    const ix = p.W / 2 - pe.C.x, iy = p.H / 2 - pe.C.y, inward = (vx * ix + vy * iy) / (L * hypot(ix, iy));
    if (inward < .25 || R < Math.min(p.W, p.H) * .05) { pe.T = { ...pe.C }; pe.progress = 0; return; }
    // Folded as far as it goes, it stops there; the cover's sheet never gets pulled along.
    pe.T = L > max ? { x: pe.C.x + vx / L * max, y: pe.C.y + vy / L * max } : q;
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
    remember(() => { const i = p.holes.indexOf(h); if (i >= 0) p.holes.splice(i, 1); updateMask(p); });
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
    el.style.backgroundSize = `${TEXS}px ${TEXS}px`;
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
      if (c.leaf) {
        // Like a leaf: sinks slowly, swinging side to side and tilting into each swing,
        // dropping fastest through the middle of a swing.
        c.phase += c.freq;
        const swing = Math.cos(c.phase);
        c.vy = Math.min(c.vy + .04, c.term);
        c.vx *= .97;
        c.x += c.vx + swing * c.amp;
        c.y += c.vy * (.35 + .65 * Math.abs(swing));
        c.a = c.a0 + Math.sin(c.phase) * c.tilt;
        c.flip += c.flipV;
        const sy = .6 + .4 * Math.abs(Math.cos(c.flip));
        c.el.style.transform = `translate(${c.x - c.w / 2}px,${c.y - c.h / 2}px) rotate(${c.a}rad) scaleY(${sy})`;
        if (c.y - Math.max(c.w, c.h) > innerHeight) { c.el.remove(); chads.splice(i, 1); }
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
    $('punch')?.classList.toggle('on', on);
    showHandles(lastP.x, lastP.y);
    updateHint();
  }

  /* ---------- Text ----------
     Text is printed into the sheet as SVG, so the same markup can be reused in the
     mask to die-cut the letters out of the paper. */

  const FONT = 'Iowan Old Style, Palatino, Georgia, serif';
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
      editor.prev = t;
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
    const { el, p, x, y, size, prev } = editor;
    editor = null;
    const lines = el.innerText.replace(/\n+$/, '').split('\n');
    el.remove();
    const t = lines.some(l => l.trim()) ? { x, y, size, lines, cut: false } : null;
    if (t) p.texts.push(t);
    renderInk(p);
    if (t || prev) remember(() => {
      if (t) p.texts.splice(p.texts.indexOf(t), 1);
      if (prev) p.texts.push(prev);
      renderInk(p);
    });
  }

  function setTyping(on) {
    if (!on) commitEditor();
    if (on && punching) setPunching(false);
    typing = on;
    hover = null;
    setCursor('');
    document.body.classList.toggle('typing', on);
    $('text')?.classList.toggle('on', on);
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
    remember(() => { t.cut = false; renderInk(p); updateMask(p); });
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

  /* ---------- Cut-out letters ----------
     The corner switch die-cuts the words marked data-block (and the signature) out of the
     sheet, leaving letter-shaped holes over the color blocks. The shapes are drawn to a canvas
     in the page's web fonts, since an SVG mask image can't see them, and added to the mask. */

  let cutout = false, cutCache = null;
  const cutToggle = $('cutToggle');

  // Every glyph and the signature, in sheet-local px (the slot is laid out exactly like the sheet).
  function cutGlyphs() {
    const o = slot.getBoundingClientRect(), chars = [], shapes = [], range = document.createRange();
    for (const el of slot.querySelectorAll(CUT_MARKS)) {
      if (el instanceof SVGElement) {
        const r = el.getBoundingClientRect(), vb = el.viewBox.baseVal;
        shapes.push({ d: el.querySelector('path').getAttribute('d'), x: r.left - o.left, y: r.top - o.top,
                      w: r.width, h: r.height, sx: r.width / vb.width, sy: r.height / vb.height });
        continue;
      }
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node; (node = walk.nextNode());) {
        const cs = getComputedStyle(node.parentElement), font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const str = node.textContent;
        for (let i = 0; i < str.length; i++) {
          if (!str[i].trim()) continue;
          range.setStart(node, i); range.setEnd(node, i + 1);
          const r = range.getClientRects()[0];
          if (r) chars.push({ ch: str[i], font, x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height });
        }
      }
    }
    return { chars, shapes };
  }

  // Two images: black glyphs for the mask, and the rim along the cut edges. The rim
  // is a band of even width on the paper side of every edge (the glyphs grown outward, minus the
  // glyphs), so curved letters and the pixel signature get the same outline, never doubled.
  const RIM = 1.1;          // px of rim showing on the paper
  function cutImages() {
    if (cutCache) return cutCache;
    const g = cutGlyphs(), k = 2;
    const canvas = () => {
      const cv = document.createElement('canvas');
      cv.width = W * k; cv.height = H * k;
      return [cv, cv.getContext('2d')];
    };
    const [fill, ctx] = canvas();
    ctx.scale(k, k);
    ctx.fillStyle = '#000';
    for (const c of g.chars) {
      ctx.font = c.font;
      const y = c.y + ctx.measureText(c.ch).fontBoundingBoxAscent;     // baseline inside the line's content box
      ctx.fillText(c.ch, c.x, y);
    }
    for (const sh of g.shapes) {
      ctx.save(); ctx.translate(sh.x, sh.y); ctx.scale(sh.sx, sh.sy);
      ctx.fill(new Path2D(sh.d));
      ctx.restore();
    }
    const [rim, rc] = canvas(), r = RIM * k;
    for (const d of [r / 2, r])
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2;
        rc.drawImage(fill, Math.cos(a) * d, Math.sin(a) * d);
      }
    rc.globalCompositeOperation = 'destination-out';
    rc.drawImage(fill, 0, 0);
    return cutCache = { glyphs: g, mask: fill.toDataURL(), rim: rim.toDataURL() };
  }

  function applyCut(p) {
    p.el.classList.toggle('cut', cutout);
    p.sheet.querySelector('.cutRim')?.remove();
    p.cutMask = null;
    if (cutout) {
      // The rim image is only a shape; it's colored by the paper (--cut-rim, style.css).
      const c = cutImages(), el = document.createElement('div');
      el.className = 'cutRim';
      el.style.webkitMaskImage = el.style.maskImage = `url(${c.rim})`;
      p.sheet.append(el);
      p.cutMask = c.mask;
    }
    updateMask(p);
  }

  // The punched-out letters drift away like leaves; the signature drops out last, in one piece.
  function dropCut(p) {
    const { chars, shapes } = cutImages().glyphs, a = frame(p).a;
    const fall = (el, x, y, w, h, delay) => {
      chadsEl.appendChild(el);
      const c = toWorld(p, x + w / 2, y + h / 2);
      chads.push({
        el, w, h, x: c.x, y: c.y, a, a0: a, delay, leaf: true,
        vx: (Math.random() - .5) * 1.2, vy: -.6 - Math.random() * 1.2, term: 1.1 + Math.random() * .9,
        amp: 1 + Math.random() * 1.6, phase: Math.random() * Math.PI * 2, freq: .045 + Math.random() * .035,
        tilt: .3 + Math.random() * .35, flip: Math.random() * 6, flipV: .02 + Math.random() * .05,
      });
    };
    chars.forEach((c, k) => {
      const el = document.createElement('div');
      el.className = 'letter glyph';
      Object.assign(el.style, { font: c.font, width: c.w + 'px', height: c.h + 'px', lineHeight: c.h + 'px' });
      el.textContent = c.ch;
      fall(el, c.x, c.y, c.w, c.h, 6 + Math.round(k * 1.2 + Math.random() * 18));
    });
    for (const sh of shapes) {
      const el = document.createElement('div');
      el.className = 'letter';
      el.innerHTML = `<svg class="sigCut" width="${sh.w}" height="${sh.h}" viewBox="0 0 ${sh.w / sh.sx} ${sh.h / sh.sy}" shape-rendering="crispEdges"><path d="${sh.d}"/></svg>`;
      fall(el, sh.x, sh.y, sh.w, sh.h, 6 + Math.round(chars.length * 1.2) + 24);
    }
  }

  // The Show effects switch: punched-out marks, and the pressed-in and raised ones with them.
  function showEffects() {
    cutToggle?.setAttribute('aria-checked', String(cutout));
    document.body.classList.toggle('effects-off', !cutout);
  }
  function setCutout(on) {
    cutout = on;
    showEffects();
    for (const p of pieces) {
      if (p.gone) continue;
      applyCut(p);
      if (on) { dropCut(p); press(p); }
    }
  }
  cutToggle?.addEventListener('click', () => setCutout(!cutout));

  /* ---------- Editing the letter ----------
     Edit text makes the letter's paragraphs editable on the sheet itself. Select some words
     and the bar above them marks them (data-block), the same as "product builder" and the
     signature: punched out, pressed into the paper or raised out of it (data-mark). Select
     inside a marked word to change its effect or unmark it. The punch-out is held off while
     editing, and when editing ends the letter template takes the new text and the sheet is
     rebuilt from it (the cut follows the new marks). */

  let editing = false, cutBeforeEdit = false;
  // Undo inside an editing session walks back its own snapshots (down to editFloor); once the
  // session ends they collapse into one entry that restores the letter as it was before.
  let editFloor = 0, preEdit = null, lastTypeT = 0;
  const tplEditables = () => [...letterTpl.content.querySelectorAll(EDITABLE)];
  function restoreLetter(html) {
    tplEditables().forEach((el, i) => { el.innerHTML = html[i]; });
    slot.replaceChildren(letterTpl.content.cloneNode(true));
    relayout();
  }
  function snapshotNote() {
    const html = [...liveNote().querySelectorAll(EDITABLE)].map(el => el.innerHTML);
    remember(() => {
      liveNote()?.querySelectorAll(EDITABLE).forEach((el, i) => { el.innerHTML = html[i]; });
      markBar.hidden = true;
    });
  }
  const editToggle = $('editToggle'), markBar = $('markBar');
  const EDITABLE = '.greeting, .body, .signoff';
  const liveNote = () => pieces.find(p => !p.gone)?.sheet.querySelector('.note');
  const markOf = n => (n.nodeType === 1 ? n : n.parentElement)?.closest('[data-block]');

  function setEditing(on) {
    if (on === editing) return;
    const note = liveNote();
    if (on && !note) return;
    editing = on;
    editToggle?.setAttribute('aria-checked', String(on));
    document.body.classList.toggle('editing', on);
    if (on) {
      setTyping(false); setPunching(false);
      cutBeforeEdit = cutout;
      editFloor = undoStack.length;
      preEdit = tplEditables().map(el => el.innerHTML);
      if (cutout) { cutout = false; pieces.forEach(applyCut); }
      note.querySelectorAll(EDITABLE).forEach(el => { el.contentEditable = 'true'; el.spellcheck = false; });
    } else {
      markBar.hidden = true;
      undoStack.length = Math.min(undoStack.length, editFloor);
      if (note) commitLetter(note);
      cutout = cutBeforeEdit;
      const before = preEdit;
      if (before.some((h, i) => h !== tplEditables()[i].innerHTML)) remember(() => restoreLetter(before));
    }
  }
  editToggle?.addEventListener('click', () => setEditing(!editing));

  // Keeps only the letter's own markup: marks, the .em/.thesis spans and line breaks.
  function cleanMarkup(el) {
    for (const n of [...el.querySelectorAll('*')]) {
      n.removeAttribute('style'); n.removeAttribute('contenteditable');
      if (n.dataset.font) setFontSpan(n, n.dataset.font);      // its face, restyled from the name
      const keep = n.tagName === 'BR' || (n.tagName === 'SPAN' && (n.dataset.block || n.dataset.font || n.matches('.em, .thesis')));
      if (!keep) n.replaceWith(...n.childNodes);
      else if (n.dataset.block && !n.textContent.trim()) n.remove();
    }
    el.normalize();
    while (el.lastChild?.nodeName === 'BR') el.lastChild.remove();
    return el.innerHTML;
  }

  function commitLetter(note) {
    const tplNote = letterTpl.content.querySelector('.note');
    const from = note.querySelectorAll(EDITABLE), to = tplNote.querySelectorAll(EDITABLE);
    from.forEach((el, i) => { to[i].innerHTML = cleanMarkup(el.cloneNode(true)); });
    slot.replaceChildren(letterTpl.content.cloneNode(true));
    relayout();
  }

  // The selected text in the letter's paragraphs, split out into its own text nodes (one per
  // run, so the markup around it stays intact). `want` filters which text nodes count.
  function selectedRuns(range, note, want = () => true) {
    const runs = [];
    for (const host of note.querySelectorAll(EDITABLE)) {
      if (!range.intersectsNode(host)) continue;
      const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let n; (n = walk.nextNode());) {
        if (!range.intersectsNode(n) || !want(n)) continue;
        const s = n === range.startContainer ? range.startOffset : 0;
        const e = n === range.endContainer ? range.endOffset : n.length;
        if (s < e) runs.push({ n, s, e });
      }
    }
    return runs.map(({ n, s, e }) => {
      if (e < n.length) n.splitText(e);
      return s > 0 ? n.splitText(s) : n;
    }).filter(t => t.textContent.trim());
  }

  // The one marked word a selection sits inside, if any.
  const selMark = range => {
    const m = markOf(range.startContainer);
    return m && m === markOf(range.endContainer) ? m : null;
  };
  const setMark = (span, effect) => {
    if (effect === 'cut') delete span.dataset.mark; else span.dataset.mark = effect;
  };

  // Marks the selected words with an effect, one span per run of text so markup stays intact.
  function markSelection(effect) {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0), note = liveNote(), m = selMark(range);
    snapshotNote(); lastTypeT = 0;
    if (m) {                        // inside one marked word: change its effect, or unmark it
      if (effect !== 'none') setMark(m, effect);
      else { const parent = m.parentNode; m.replaceWith(...m.childNodes); parent?.normalize(); }
    } else if (effect !== 'none') {
      for (const t of selectedRuns(range, note, n => !markOf(n))) {
        const span = document.createElement('span');
        span.className = 'em'; span.dataset.block = '1';
        setMark(span, effect);
        t.replaceWith(span); span.append(t);
      }
    }
    sel.removeAllRanges();
    markBar.hidden = true;
  }
  // Keep the selection when the bar is pressed.
  markBar?.addEventListener('pointerdown', e => e.preventDefault());
  markBar?.addEventListener('mousedown', e => e.preventDefault());
  markBar?.addEventListener('click', e => {
    const b = e.target.closest('[data-mark]');
    if (b) markSelection(b.dataset.mark);
  });

  // The mark bar floats above the selection while some letter text is selected. Over a marked
  // word it shows that word's effect, and offers Unmark.
  document.addEventListener('selectionchange', () => {
    if (!editing || !markBar) return;
    const sel = getSelection(), note = liveNote();
    const ok = sel.rangeCount && !sel.isCollapsed && note?.contains(sel.anchorNode) && note.contains(sel.focusNode);
    if (!ok) { markBar.hidden = true; return; }
    const range = sel.getRangeAt(0), r = range.getBoundingClientRect(), m = selMark(range);
    const current = m ? m.dataset.mark || 'cut' : null;
    for (const b of markBar.querySelectorAll('[data-mark]')) {
      b.hidden = b.dataset.mark === 'none' && !m;
      b.setAttribute('aria-pressed', String(b.dataset.mark === current));
    }
    markBar.style.left = `${r.left + r.width / 2}px`;
    markBar.style.top = `${r.top}px`;
    markBar.hidden = false;
  });

  // One paragraph each: Enter doesn't split them, and pasted text comes in plain.
  addEventListener('keydown', e => {
    if (editing && e.key === 'Enter' && e.target.closest?.(EDITABLE)) e.preventDefault();
  }, true);
  // A burst of typing is one undo step.
  addEventListener('beforeinput', e => {
    if (!editing || !e.target.closest?.(EDITABLE)) return;
    if (performance.now() - lastTypeT > 800) snapshotNote();
    lastTypeT = performance.now();
  }, true);
  // Cmd/Ctrl+Z, ahead of the browser's own undo (which can't see the marks or the sheet).
  addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
    if (e.target.closest?.('input, textarea, select')) return;
    e.preventDefault();
    if (e.shiftKey || (editing && undoStack.length <= editFloor)) return;
    undo();
  }, true);
  addEventListener('paste', e => {
    if (!editing || !e.target.closest?.(EDITABLE)) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' '));
  }, true);

  /* ---------- Letter font ----------
     The faces installed on this Mac (style.css loads them by PostScript name, nothing is
     downloaded): the bianzhidai pixel styles, the signature's Pearl among them, and the SF and
     New York families. Mono faces are set a little tighter, as SF Mono was. */

  const FONTS = [
    ...['Pearl', 'Base', 'Bubble', 'Cloud', 'Cube', 'Messy', 'Ring', 'Stitches'].map(s =>
      ({ group: 'bianzhidai', name: `bianzhidai ${s}`, family: `'bianzhidai ${s}', 'SF Mono', monospace`, track: '0em' })),
    { group: 'SF', name: 'SF Mono', family: "'SF Mono', ui-monospace, Menlo, monospace", track: '-.05em' },
    ...['SF Pro Text', 'SF Pro Display', 'SF Pro Rounded', 'SF Compact Text', 'SF Compact Display', 'SF Compact Rounded']
      .map(name => ({ group: 'SF', name, family: `'${name}', system-ui, sans-serif`, track: '-.01em' })),
    ...['New York Small', 'New York Medium', 'New York Large', 'New York Extra Large']
      .map(name => ({ group: 'New York', name, family: `'${name}', ui-serif, Georgia, serif`, track: '-.01em' })),
  ];
  const fontSelect = $('fontSelect');
  let letterFont;
  function useFont(name) {
    const f = FONTS.find(f => f.name === name) || FONTS.find(f => f.name === DEFAULT_FONT);
    letterFont = f.name;
    root.style.setProperty('--letter-font', f.family);
    root.style.setProperty('--letter-track', f.track);
    if (fontSelect) fontSelect.value = f.name;
    try { localStorage.setItem('letterFont', f.name); } catch {}
  }
  for (const f of FONTS) {
    let g = [...(fontSelect?.children || [])].find(g => g.label === f.group);
    if (!g) { g = document.createElement('optgroup'); g.label = f.group; fontSelect?.append(g); }
    const o = document.createElement('option');
    o.value = o.textContent = f.name;
    g.append(o);
  }
  // Default: SF Mono, the letter's original face.
  const DEFAULT_FONT = 'SF Mono';
  { let saved; try { saved = localStorage.getItem('letterFont'); } catch {} useFont(saved); }
  // A face for part of the letter: a span carrying the font's name (data-font) and its style.
  function setFontSpan(span, name) {
    const f = FONTS.find(f => f.name === name);
    if (!f) return;
    span.dataset.font = f.name;
    span.style.fontFamily = f.family;
    span.style.letterSpacing = f.track;
  }
  // With words selected on the letter, the font menu sets the face of just those words.
  // The selection is taken as the menu is pressed, before focus moves to it.
  let fontRange = null;
  function noteSelection() {
    const sel = getSelection(), note = liveNote();
    return sel.rangeCount && !sel.isCollapsed && note?.contains(sel.anchorNode) && note.contains(sel.focusNode)
      ? sel.getRangeAt(0).cloneRange() : null;
  }
  fontSelect?.addEventListener('pointerdown', () => { fontRange = noteSelection(); });
  fontSelect?.addEventListener('focus', () => { fontRange ||= noteSelection(); });
  fontSelect?.addEventListener('blur', () => { fontRange = null; });
  function fontSelection(range, name) {
    const note = liveNote();
    const before = tplEditables().map(el => el.innerHTML);
    if (editing) snapshotNote();
    for (const t of selectedRuns(range, note)) {
      const parent = t.parentElement;
      if (parent.dataset.font && parent.childNodes.length === 1) { setFontSpan(parent, name); continue; }
      const span = document.createElement('span');
      setFontSpan(span, name);
      t.replaceWith(span); span.append(t);
    }
    getSelection().removeAllRanges();
    if (!editing) { commitLetter(note); remember(() => restoreLetter(before)); }
  }

  fontSelect?.addEventListener('change', () => {
    if (!replaying && fontRange && liveNote()?.contains(fontRange.startContainer)) {
      const range = fontRange;
      fontRange = null;
      fontSelection(range, fontSelect.value);
      fontSelect.value = letterFont;            // the menu goes on showing the letter's own face
      return;
    }
    if (editing) setEditing(false);
    const prev = letterFont;
    useFont(fontSelect.value);
    relayout();
    remember(() => { fontSelect.value = prev; fontSelect.dispatchEvent(new Event('change')); });
  });

  // The colored blocks under the highlighted words, on or off.
  $('blocksToggle')?.addEventListener('click', e => {
    const on = !document.body.classList.toggle('no-blocks');
    e.currentTarget.setAttribute('aria-checked', String(on));
  });
  // Thick: the paper's edge band, edge lighting, folded-flap rim and deeper shadow.
  let thick = false;
  $('thickToggle')?.addEventListener('click', e => {
    thick = !document.body.classList.toggle('thin');
    e.currentTarget.setAttribute('aria-checked', String(thick));
  });
  document.body.classList.add('thin');
  $('resizeToggle')?.addEventListener('click', e => {
    resizing = e.currentTarget.getAttribute('aria-checked') !== 'true';
    e.currentTarget.setAttribute('aria-checked', String(resizing));
    hover = null; setCursor('');
  });
  $('resetSize')?.addEventListener('click', e => {
    slot.style.width = slot.style.height = ''; fixedH = 0;
    document.body.classList.remove('sized');
    e.currentTarget.hidden = true;
    restart();
  });
  // Indent: a tab before each paragraph. The letter reflows, so the sheet is rebuilt to match.
  $('indentToggle')?.addEventListener('click', e => {
    const on = document.body.classList.toggle('indent');
    e.currentTarget.setAttribute('aria-checked', String(on));
    restart();
  });
  // Light / dark. The theme is set before first paint (index.html); this keeps the switch in step.
  // The corner button shows the current mode (sun or moon) and flips it.
  const themeBtn = $('themeBtn');
  function showTheme() {
    const dark = root.dataset.theme === 'dark';
    themeBtn?.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
  function flipTheme() {
    const t = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = t;
    showTheme();
    try { localStorage.setItem('theme', t); } catch {}
  }
  showTheme();
  themeBtn?.addEventListener('click', flipTheme);
  // Undo for the switches and the theme button: click it again.
  for (const b of [themeBtn, ...document.querySelectorAll('.switches .toggle')])
    if (b && b !== editToggle) b.addEventListener('click', () => remember(() => b.click()));
  // Binder holes, on or off. The margin and width change, so the sheet is rebuilt to match.
  $('binderToggle')?.addEventListener('click', e => {
    const on = document.body.classList.toggle('binder');
    e.currentTarget.setAttribute('aria-checked', String(on));
    restart();
  });
  // Link tabs: the perforated strip of links at the bottom of the letter, on or off.
  $('linksToggle')?.addEventListener('click', e => {
    const on = !document.body.classList.toggle('no-links');
    e.currentTarget.setAttribute('aria-checked', String(on));
    restart();
  });

  /* ---------- Intro ----------
     The letter rises from below the screen into place. A: the words are already punched out on
     the way up, so the color blocks flicker through the holes until it lands. B: it rises plain,
     and on landing the words punch out and drift away like leaves. ?intro=a|b picks the one that
     plays on load; the buttons in the corner replay either. */

  let introVariant = new URLSearchParams(location.search).get('intro') === 'b' ? 'b' : 'a';
  let introPending = true;          // the first build plays it; rebuilds on resize don't
  const introBtns = document.querySelectorAll('[data-intro]');

  function startIntro(p, t0 = 0) {
    const b = p.body;
    p.intro = { t0, dur: 1600, x: b.x, y: b.y, y0: innerHeight + p.H / 2 + 40, a0: .05, lift: 1 };
    b.y = p.intro.y0; b.a = p.intro.a0; b.lift = 1;
  }
  function tickIntro(p) {
    const it = p.intro, b = p.body;
    if (!texReady) return;          // hold below the screen until the paper is drawn
    it.t0 ||= performance.now();
    // Ease-out expo: it shoots up fast, then glides the last stretch into place.
    const u = clamp((performance.now() - it.t0) / it.dur, 0, 1), e = u >= 1 ? 1 : 1 - Math.pow(2, -10 * u);
    b.x = it.x; b.y = it.y0 + (it.y - it.y0) * e; b.a = it.a0 * (1 - e);
    b.vx = b.vy = b.va = 0;
    const v = clamp((1 - u) / .5, 0, 1);
    it.lift = v * v * (3 - 2 * v);          // floats up high, then settles onto the table
    if (u >= 1) endIntro(p);
  }
  function endIntro(p) {
    if (!p.intro) return;
    p.intro = null;
    if (introVariant === 'b' && !cutout) setCutout(true);
  }
  function playIntro(v) {
    setEditing(false);
    introVariant = v;
    introBtns.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.intro === v)));
    cutout = v === 'a';
    showEffects();
    introPending = true;
    build();
  }
  introBtns.forEach(btn => btn.addEventListener('click', () => playIntro(btn.dataset.intro)));
  introBtns.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.intro === introVariant)));
  cutout = introVariant === 'a';
  showEffects();

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

  // Perspective for the sheet's 3D turn (Spin).
  const TILT = { perspective: 1400 };
  // Spin: dragging on the page around the sheet turns it, up to SPIN.max degrees (past that the
  // frosted paper stops drawing reliably), and it springs back when let go.
  const SPIN = { drag: .25, max: 40 };
  const spinOff = { x: 0, y: 0 };
  let spin = false;          // no switch for it any more; true brings the drag-to-turn back

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

    if (drag?.type !== 'spin') { spinOff.x *= .9; spinOff.y *= .9; }     // let go: it springs back
    for (const p of [...pieces]) {     // a copy: tearing through reorders pieces
      if (p.gone) continue;
      const b = p.body, pe = p.peel;
      if (p.joined && pe.on && (pe.off || (drag?.type === 'peel' && drag.piece === p))) foldTear(p);
      if (p.intro) {
        tickIntro(p);
        b.lift = p.intro ? p.intro.lift : 0; b.liftV = 0;    // eased, no spring: the shadow just tightens
      } else if (!p.joined) {
        if (!(drag?.piece === p && (drag.type === 'move' || drag.type === 'rotate'))) {
          b.x += b.vx; b.y += b.vy; b.a += b.va;
          b.vx *= .92; b.vy *= .92; b.va *= .9;
        }
        if (p.rest) {
          // Turned only by a Spin drag; otherwise it eases back to lying flat.
          const tx = spinOff.x, ty = spinOff.y;
          p.tilt ||= { x: 0, y: 0 };
          const k = drag?.type === 'spin' ? .3 : .08;
          p.tilt.x += (tx - p.tilt.x) * k; p.tilt.y += (ty - p.tilt.y) * k;
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
        if (!pe.off) {         // springing back, it mustn't overshoot out past the corner
          const q = keepIn(p, { ...pe.P });
          if (q.x !== pe.P.x) pe.V.x = 0;
          if (q.y !== pe.P.y) pe.V.y = 0;
          pe.P = q;
        }
        if (pe.off === 1 && pe.offFrames > 90) pe.off = 2;
        if (pe.off === 2) {
          pe.liftOff += 1 / 48;
          if (pe.liftOff >= 1) {
            p.gone = true; p.el.style.display = 'none'; updateHint();
            if (pieces.every(q => q.gone)) setTimeout(() => {         // a fresh letter fades back in
              stage.classList.remove('ready');
              build();
              setTimeout(() => stage.classList.add('ready'), 30);
            }, 900);
            continue;
          }
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

  // Where the fold's clip-path goes. Chrome drops a layer's mask (the punched holes) when that
  // layer also has a clip-path, so it clips a wrapper instead; Firefox ignores a wrapper's clip
  // on a frosted (backdrop-filter) layer, so there the layer clips itself.
  const CLIP_SELF = CSS.supports('-moz-appearance', 'none');
  const sheetClipEl = p => CLIP_SELF ? p.sheet : p.sheetW;
  const flapClipEl = p => CLIP_SELF ? p.flap : p.flapW;

  // How far the paper's edge shows below and right of the sheet, in screen px.
  const THICK = { x: .8, y: 2.4 };
  // Bands along the polygon's edges that face the offset `o`: each edge swept by `o`, drawn as
  // one filled path. Edges with both ends on `skip` (the fold) get none.
  function edgePath(poly, o, skip) {
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i], p1 = poly[(i + 1) % poly.length];
      area += p0.x * p1.y - p1.x * p0.y;
    }
    const s = area > 0 ? 1 : -1;     // outward normal of edge d is s * (d.y, -d.x)
    let d = '';
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i], p1 = poly[(i + 1) % poly.length];
      if (skip && skip(p0) && skip(p1)) continue;
      const nx = s * (p1.y - p0.y), ny = -s * (p1.x - p0.x);
      if (nx * o.x + ny * o.y <= 0) continue;
      d += `M${p0.x},${p0.y}L${p1.x},${p1.y}L${p1.x + o.x},${p1.y + o.y}L${p0.x + o.x},${p0.y + o.y}Z`;
    }
    return d && `<path class="edge" d="${d}"/>`;
  }
  // The lifted flap is seen at an angle, so all of its cut edges show a rim, not just the low ones.
  function rimPath(poly, skip) {
    let d = '';
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i], p1 = poly[(i + 1) % poly.length];
      if (!(skip(p0) && skip(p1))) d += `M${p0.x},${p0.y}L${p1.x},${p1.y}`;
    }
    return `<path class="rim" d="${d}"/>`;
  }

  function render(p) {
    const f = frame(p), l = p.joined ? pair.lift : p.body.lift, pe = p.peel, lo = pe.liftOff;
    // Turn about the sheet's center: rotateY for a sideways spin, rotateX for an up/down one.
    const tl = p.tilt || { x: 0, y: 0 };
    const tilt = tl.x || tl.y ? ` translate(${p.W / 2}px,${p.H / 2}px) perspective(${TILT.perspective}px)`
      + ` rotateY(${tl.x}deg) rotateX(${-tl.y}deg) translate(${-p.W / 2}px,${-p.H / 2}px)` : '';
    p.el.style.transform = `translate(${f.ox}px,${f.oy - 40 * lo * lo}px) rotate(${f.a}rad)${tilt}`;
    p.el.style.setProperty('--ang', (115 - f.a * 57.3 + tl.x * 3) + 'deg');
    // No hover (touch screens): the shine follows the sheet instead, as it's dragged or tossed.
    if (noHover.matches && p === pieces[0]) setGlint((f.ox + rot(p.W / 2, p.H / 2, f.a).x) / innerWidth);

    // Light comes from above, so shadow offsets are fixed in screen space.
    // Thick paper casts a deeper, softer shadow. Turned, the shadow swings the other way.
    const so = thick ? rot(1 + 3 * l - tl.x * .5, 4 + 14 * l - tl.y * .5, -f.a) : rot(.5 + 3 * l - tl.x * .5, 1.5 + 14 * l - tl.y * .5, -f.a);
    p.sw.style.filter = `blur(${Math.max(0, (thick ? 5 : 1.5) + 16 * l)}px)`;
    p.ss.style.transform = `translate(${so.x}px,${so.y}px)`;
    p.ss.style.background = `rgb(52 40 20 / ${thick ? .16 + .06 * l : .09 + .07 * l})`;

    // The paper's thickness shows along the edges that face down and right (light is above).
    const eo = rot(THICK.x, THICK.y, -f.a);

    const stripClip = renderStrips(p, so);
    const baseClip = stripClip ?? (p.base.length > 4 ? polyCss(p.base) : 'none');     // torn or shaped corners
    const dx = pe.C.x - pe.P.x, dy = pe.C.y - pe.P.y, dist = hypot(dx, dy);
    const flat = () => {
      p.sheet.style.display = p.sw.style.display = 'block';
      sheetClipEl(p).style.clipPath = p.ss.style.clipPath = baseClip;
      p.flap.style.display = p.fsw.style.display = 'none';
      p.tmain.innerHTML = stripClip ? '' : edgePath(p.base, eo);
      p.tflap.innerHTML = '';
    };
    if (!pe.on || dist < .5 || stripClip) return flat();

    const n = { x: dx / dist, y: dy / dist };
    const M = { x: (pe.C.x + pe.P.x) / 2, y: (pe.C.y + pe.P.y) / 2 };
    const main = clipHalf(p.base, M, n, -1), part = clipHalf(p.base, M, n, 1);
    if (part.length < 3 || (main.length < 3 && !pe.off)) return flat();     // only peeling off folds it all

    if (main.length < 3) {
      // Folded all the way over: nothing left lying on the table.
      p.sheet.style.display = p.sw.style.display = 'none';
      p.tmain.innerHTML = '';
      if (pe.off === 1) pe.off = 2;
    } else {
      p.sheet.style.display = p.sw.style.display = 'block';
      sheetClipEl(p).style.clipPath = p.ss.style.clipPath = polyCss(main);
    }
    const onCrease = q => Math.abs((q.x - M.x) * n.x + (q.y - M.y) * n.y) < .01;
    const crease = part.filter(onCrease);

    // Reflect the folded part across the crease line.
    const ux = -n.y, uy = n.x;
    const a = ux * ux - uy * uy, b = 2 * ux * uy, dd = uy * uy - ux * ux;
    const e = M.x - (a * M.x + b * M.y), g = M.y - (b * M.x + dd * M.y);
    const mtx = `matrix(${a},${b},${b},${dd},${e},${g})`;

    p.flap.style.display = 'block';
    flapClipEl(p).style.clipPath = polyCss(part);
    p.flapW.style.transform = mtx;
    p.flap.style.opacity = 1 - lo;

    // Thickness on both halves. The fold isn't a cut edge, so it gets no edge band: on the lying
    // part it casts a thin shadow, and the flap's bend catches the light like a rounded spine.
    const folded = part.map(q => ({ x: a * q.x + b * q.y + e, y: b * q.x + dd * q.y + g }));
    let creaseSvg = '';
    if (crease.length === 2) {
      const [c0, c1] = crease, off = (k, d) => `${k.x - n.x * d},${k.y - n.y * d}`;
      creaseSvg = `<path class="crease-shade" d="M${off(c0, 1.6)}L${off(c1, 1.6)}"/>`;
      p.tflap.innerHTML = edgePath(folded, eo, onCrease) + rimPath(folded, onCrease)
        + `<path class="crease-light" d="M${c0.x},${c0.y}L${c1.x},${c1.y}"/>`;
    } else p.tflap.innerHTML = edgePath(folded, eo, onCrease) + rimPath(folded, onCrease);
    p.tflap.style.opacity = 1 - lo;
    if (main.length >= 3) p.tmain.innerHTML = edgePath(main, eo, onCrease) + creaseSvg;

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

  $('punch')?.addEventListener('click', () => setPunching(!punching));
  $('perf')?.addEventListener('click', e => {
    variant = variant === 'plain' ? 'perf' : 'plain';
    e.currentTarget.classList.toggle('on', variant === 'perf');
    build();
  });
  $('toggleUnder')?.addEventListener('click', e => {
    const on = document.body.classList.toggle('under');
    e.currentTarget.textContent = on ? 'Hide underlay' : 'Show underlay';
  });
  $('reset')?.addEventListener('click', build);
  $('text')?.addEventListener('click', () => setTyping(!typing));
  addEventListener('keydown', e => {
    if (e.target.isContentEditable) { if (e.key === 'Escape') { setTyping(false); setEditing(false); } return; }
    if (!CONFIG.keys) return;
    if (e.key === 'h' || e.key === 'H') setPunching(!punching);
    else if (e.key === 't' || e.key === 'T') setTyping(!typing);
    else if (e.key === 'Escape') { setPunching(false); setTyping(false); }
  });

  // The letter is laid out in web fonts, so measure once they've loaded (and again on resize).
  // Rebuild whenever the letter's layout changes (web fonts arriving, breakpoints) or the window resizes.
  // Today's date in the letter's top right corner, e.g. "October 21, 2026", from the viewer's
  // clock. It turns over at local midnight on every copy of the letter (template, slot, sheets).
  function writeDate() {
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const text = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    for (const t of [...letterTpl.content.querySelectorAll('.date'), ...document.querySelectorAll('.note .date')]) {
      t.dateTime = iso; t.textContent = text;
    }
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    setTimeout(writeDate, midnight - d + 1000);
  }
  writeDate();
  slot.append(letterTpl.content.cloneNode(true));
  slot.inert = true;
  // Nothing is built until the web fonts are in (so the intro never restarts mid-flight), and
  // later layout events rebuild only if the letter actually moved or reflowed.
  let fontsReady = false, layoutSig = '';
  const start = () => {
    if (!fontsReady) return;
    if (editing) { setEditing(false); return; }      // keep the edits; it comes back around
    measure(); placeBlocks();
    const r = slot.getBoundingClientRect();
    const sig = `${W}x${H}@${Math.round(r.left)},${Math.round(r.top)}|${blocksEl.innerHTML}`;
    if (sig === layoutSig) return;
    layoutSig = sig;
    if (!texStarted) startTexture();
    else if (growTile()) scheduleTexture();
    cutCache = null; setPunchCursor(); build();
  };
  let startT;
  const restart = () => { clearTimeout(startT); startT = setTimeout(start, 120); };
  // The letter's text or font changed: rebuild even if the sheet came out the same size.
  const relayout = () => { layoutSig = ''; cutCache = null; restart(); };
  new ResizeObserver(restart).observe(slot);
  document.fonts.ready.then(() => { fontsReady = true; restart(); });
  document.fonts.addEventListener('loadingdone', restart);
  addEventListener('resize', restart);
  let texStarted = false;
  function startTexture() {
    texStarted = true;
    useTexture().then(() => {
      texReady = true;
      // No fade on first show: the sheet rises in from off-screen, fully opaque.
      stage.style.transition = 'none';
      stage.classList.add('ready');
      stage.offsetWidth;
      stage.style.transition = '';
    });
  }
  requestAnimationFrame(tick);

  // The paper texture for the current stock, as a style rule. A real rule, not a custom property:
  // Firefox (and Zen) won't paint an image URL that arrives through var() set from script.
  const texCss = document.createElement('style'), texUrls = new Map();
  document.head.append(texCss);
  // One tile covers the whole sheet; a sheet resized past it gets a bigger tile, never a seam.
  // Until the bigger tile is drawn, the old one stretches to fit.
  function growTile() {
    if (!(S > TEXS)) return false;
    const N = Math.ceil(S * TEX_DENSITY);
    TEXS = N / TEX_DENSITY;
    root.style.setProperty('--s', TEXS + 'px');
    return true;
  }
  // Shader tiles are drawn at the screen's pixel ratio (2x at least, for clean grain; 3x at
  // most), but never wider than TEX_CAP pixels. A 2048px tile is 16MB once decoded, and 2048 is
  // the largest texture every WebGL2 GPU must support. Phones get 1536 (9MB): that still covers
  // a phone-sized sheet at better than 2x, and only a sheet resized past ~770px gets softer.
  const TEX_CAP = matchMedia('(max-width: 640px), (pointer: coarse)').matches ? 1536 : 2048;
  const shaderPx = () => Math.min(TEX_CAP, Math.ceil(TEXS * clamp(devicePixelRatio || 1, 2, 3)));
  // The shader's settings for the current stock and color. Its grain is laid out across the
  // canvas, so the scale keeps it the same size in CSS px however big the tile is.
  const SHADER_REF = 527;
  function shaderOpts() {
    const st = STOCK[stock], [r, g, b] = paint.rgb.split(' ').map(Number), k = st.shader.shade;
    return { ...st.shader, scale: SHADER_REF / TEXS, shadow: [r * k, g * k, b * k, st.shader.shadowA] };
  }
  // Texture source: the Paper Shaders paper-texture (shader), the original generator, or both
  // (split: shader on the left half of the sheet, generator on the right). Without WebGL2, or
  // once the shader has failed, it's the generator.
  let shaderOk = paperShaderSupported(), texMode = shaderOk ? 'shader' : 'generator';
  const generated = () => drawParchment(Math.round(TEXS * TEX_DENSITY), STOCK[stock].tex);
  async function paperCanvas(mode) {
    if (mode === 'generator' || !shaderOk) return generated();
    let cv;
    try { cv = await renderPaperShader(shaderPx(), shaderOpts()); }
    catch (err) {
      console.warn('Paper shader failed, using the generator:', err);
      shaderBroke();
      return generated();
    }
    if (mode === 'split') {
      const g = generated(), N = cv.width, f = W / 2 / TEXS;
      const ctx = cv.getContext('2d');
      ctx.clearRect(N * f, 0, N, N);
      ctx.drawImage(g, g.width * f, 0, g.width * (1 - f), g.height, N * f, 0, N * (1 - f), N);
    }
    return cv;
  }
  // A few recent tiles stay cached (switching back is instant); older ones are let go.
  const TEX_KEEP = 4;
  let texReq = 0, texT;
  function useTexture() {
    clearTimeout(texT);
    growTile();
    const mode = shaderOk ? texMode : 'generator';
    const key = mode === 'generator' ? `gen|${stock}|${TEXS}`
      : `${mode}|${stock}|${paint.name}|${TEXS}|${shaderPx()}${mode === 'split' ? '|' + W : ''}`;
    let url = texUrls.get(key);
    texUrls.delete(key);
    url ||= paperCanvas(mode).then(textureUrl);
    texUrls.set(key, url);
    for (const [k, old] of texUrls) {
      if (texUrls.size <= TEX_KEEP) break;
      texUrls.delete(k);
      old.then(u => u.startsWith('blob:') && URL.revokeObjectURL(u));
    }
    const req = ++texReq;
    return url.then(u => { if (req === texReq) texCss.textContent = `.tex, .chad { background-image:url("${u}"); }`; });
  }
  // Resizing redraws once things settle, not on every frame of a drag.
  function scheduleTexture() {
    clearTimeout(texT);
    texT = setTimeout(useTexture, 250);
  }
  // A move to a screen with a different pixel ratio (or a zoom) redraws the shader tile.
  (function watchRatio() {
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => {
      watchRatio();
      if (texStarted && shaderOk && texMode !== 'generator') scheduleTexture();
    }, { once: true });
  })();

  /* ---------- Paper stock and color ----------
     Vellum is smoother and more see-through than parchment; construction paper isn't see-through. The colors tint the paper's body;
     the first is the original. On any other the near-white texture is blended in (soft-light)
     so the color holds, and dark papers print in light ink. */

  // `tex` is for the generator (drawParchment), `shader` for the paper-texture shader: its own
  // params, plus the near-white `paper` it draws on and how dark (`shade`, a share of the paper
  // color) and how strong (`shadowA`) its grain is.
  const STOCK = {
    parchment: { tex: {}, frost: 5, alpha: 1,
      shader: { paper: [242, 239, 231, .5], shade: .5, shadowA: .55, roughness: .45, roughnessSize: .35, fiber: .5, fiberSize: .25, drops: .12, seed: 7 } },
    vellum: { tex: { cloud: .3, fibers: 450, specks: 30 }, frost: 2.5, alpha: .65,
      shader: { paper: [244, 242, 236, .42], shade: .55, shadowA: .3, roughness: .2, roughnessSize: .2, fiber: .25, fiberSize: .15, seed: 7 } },
    // Construction paper: opaque, evenly colored, coarse grain, lots of short fibers and flecks.
    construction: { tex: { cloud: .25, tooth: 7, fibers: 22000, fiberLen: 12, specks: 3000, fuzz: .8 }, frost: 0, opaque: true,
      shader: { paper: [240, 237, 230, .55], shade: .45, shadowA: .8, roughness: .8, roughnessSize: .6, fiber: .6, fiberSize: .5, drops: .35, seed: 7 } },
    // Metallic foil paper: opaque and smooth, brushed in long fine streaks along one direction,
    // with a bright shine that slides across it as the pointer moves. It has colors of its own.
    // In the shader the brushing is the grain lined up in rows, lit from low down (grazing) so
    // the streaks and a faint dimpling catch the light.
    metallic: { tex: { cloud: .12, tooth: .5, fibers: 14000, fiberLen: 220, spread: .03, specks: 0 }, frost: 0, opaque: true, metal: true,
      shader: { paper: [244, 244, 244, .5], shade: .45, shadowA: .7, roughness: .7, roughnessSize: .15, roughnessRows: 1, angle: 97, grazing: 1.25, wrinkles: .12, wrinkleSize: .8, seed: 7 } },
  };
  const COLORS = [
    { name: 'Parchment', rgb: '204 197 185', a: .62, lightRim: true },
    { name: 'Ivory', rgb: '243 239 228', a: .85 }, { name: 'Blush', rgb: '228 190 182', a: .85 },
    { name: 'Sage', rgb: '220 227 211', a: .85 }, { name: 'Mist', rgb: '216 224 232', a: .85 },
    { name: 'Kraft', rgb: '168 138 100', a: .85, lightRim: true },
    { name: 'Slate', rgb: '75 81 90', a: .9, dark: true }, { name: 'Forest', rgb: '47 62 52', a: .9, dark: true },
    { name: 'Ink', rgb: '38 38 44', a: .92, dark: true },
  ];
  const METALS = [
    { name: 'Silver', rgb: '190 193 198', lightRim: true, swatch: 'linear-gradient(135deg, #8E9298, #EEF0F2 45%, #A4A8AE 60%, #D8DBDF)' },
    { name: 'Gold', rgb: '205 168 92', lightRim: true, swatch: 'linear-gradient(135deg, #9A7432, #F4DC9C 45%, #B48A3E 60%, #E2C27A)' },
  ];
  const palette = st => st.metal ? METALS : COLORS;
  let stock = 'parchment', paint = COLORS[0];
  function applyPaper() {
    const st = STOCK[stock];
    root.style.setProperty('--tone', `rgb(${paint.rgb} / ${st.opaque ? 1 : paint.a * st.alpha})`);
    root.style.setProperty('--tone-blend', paint === COLORS[0] && !st.opaque ? 'normal' : 'soft-light');
    root.style.setProperty('--frost', st.frost + 'px');
    document.body.classList.toggle('paper-dark', !!paint.dark);
    // Cut edges and punched holes: a pale rim where the paper is dark or mid-tone (and on the
    // see-through stocks, over the table); a soft shadow on the pale opaque papers.
    const lightRim = paint.dark || paint.lightRim || !st.opaque && paint === COLORS[0];
    root.style.setProperty('--cut-rim', lightRim ? 'rgb(255 252 244 / .6)' : 'rgb(70 55 30 / .45)');
    document.body.classList.toggle('matte', !!st.opaque && !st.metal);
    document.body.classList.toggle('metal', !!st.metal);
    if (texStarted) useTexture();
  }
  applyPaper();
  const stockBtns = document.querySelectorAll('[data-stock]'), swatches = $('swatches');
  // Undo for the paper stock and color: press the one that was pressed before.
  document.querySelector('.paperbar')?.addEventListener('click', e => {
    const b = e.target.closest('[data-stock], .swatch');
    if (!b) return;
    const set = document.querySelectorAll(b.matches('[data-stock]') ? '[data-stock]' : '.swatch');
    const prev = [...set].find(o => o.getAttribute('aria-pressed') === 'true');
    if (prev && prev !== b) remember(() => prev.click());
  }, true);
  // Each stock shows its own palette; switching between palettes goes back to the color last
  // picked in that one (its first, the first time).
  const lastPaint = new Map();
  stockBtns.forEach(b => b.addEventListener('click', () => {
    const was = palette(STOCK[stock]);
    lastPaint.set(was, paint);
    stock = b.dataset.stock;
    stockBtns.forEach(o => o.setAttribute('aria-pressed', String(o === b)));
    const now = palette(STOCK[stock]);
    if (now !== was) { paint = lastPaint.get(now) || now[0]; showSwatches(); }
    applyPaper();
  }));
  // Corner shape. Only the outline changes, so the sheet keeps its place and any punches.
  const cornerBtns = document.querySelectorAll('[data-corner]');
  cornerBtns.forEach(b => b.addEventListener('click', () => {
    const prev = [...cornerBtns].find(o => o.getAttribute('aria-pressed') === 'true');
    if (prev && prev !== b) remember(() => prev.click());
    corner = b.dataset.corner;
    cornerBtns.forEach(o => o.setAttribute('aria-pressed', String(o === b)));
    for (const p of pieces) p.base = basePoly(p);
  }));
  // Texture source, for comparing the shader with the generator. The undo works as for corners.
  const texBtns = document.querySelectorAll('[data-tex]');
  const showTexMode = () => texBtns.forEach(o => o.setAttribute('aria-pressed', String(o.dataset.tex === texMode)));
  texBtns.forEach(b => b.addEventListener('click', () => {
    if (b.disabled || b.dataset.tex === texMode) return;
    const prev = [...texBtns].find(o => o.dataset.tex === texMode);
    remember(() => prev.click());
    texMode = b.dataset.tex;
    showTexMode();
    if (texStarted) useTexture();
  }));
  // No WebGL2, or the shader failed: the generator from here on, and the other two are greyed.
  function shaderBroke() {
    shaderOk = false; texMode = 'generator';
    showTexMode();
    texBtns.forEach(o => { if (o.dataset.tex !== 'generator') { o.disabled = true; o.title = 'Needs WebGL2 (and the page served over http)'; } });
  }
  if (!shaderOk) shaderBroke();
  else showTexMode();
  // Border shape. Like corners, only the outline changes.
  const borderBtns = document.querySelectorAll('[data-border]');
  borderBtns.forEach(o => o.setAttribute('aria-pressed', String(o.dataset.border === border)));
  borderBtns.forEach(b => b.addEventListener('click', () => {
    const prev = [...borderBtns].find(o => o.getAttribute('aria-pressed') === 'true');
    if (prev && prev !== b) remember(() => prev.click());
    border = b.dataset.border;
    borderBtns.forEach(o => o.setAttribute('aria-pressed', String(o === b)));
    for (const p of pieces) p.base = basePoly(p);
  }));
  function showSwatches() {
    swatches?.replaceChildren();
    for (const c of palette(STOCK[stock])) {
      const b = document.createElement('button');
      b.className = 'swatch'; b.style.background = c.swatch || `rgb(${c.rgb})`;
      b.title = c.name; b.setAttribute('aria-label', c.name);
      b.setAttribute('aria-pressed', String(c === paint));
      b.addEventListener('click', () => {
        paint = c;
        swatches.querySelectorAll('.swatch').forEach(o => o.setAttribute('aria-pressed', String(o === b)));
        applyPaper();
      });
      swatches?.append(b);
    }
  }
  showSwatches();

  /* ---------- Resize ----------
     With the Resize switch on, the sheet's sides and corners can be dragged. The sheet stays
     centered, so it grows on both sides at once and the grabbed edge stays under the cursor.
     The letter reflows to the new width; it can't get shorter than the letter needs. */

  const GRAB = 12;          // px either side of an edge that grab it
  const MIN_W = 320;        // the pixel name and the four link tabs still fit
  const EDGE_CURSOR = { l: 'ew-resize', r: 'ew-resize', t: 'ns-resize', b: 'ns-resize',
    lt: 'nwse-resize', rb: 'nwse-resize', rt: 'nesw-resize', lb: 'nesw-resize' };
  let resizing = false, fixedH = 0, sizeFrame = 0;      // fixedH: a dragged-out height (0: what the letter needs)

  // Which edges of the sheet are under a screen point: 'l', 'r', 't', 'b' or a corner like 'rb'.
  function edgesAt(x, y) {
    const r = slot.getBoundingClientRect();
    if (x < r.left - GRAB || x > r.right + GRAB || y < r.top - GRAB || y > r.bottom + GRAB) return '';
    const h = Math.abs(x - r.left) < GRAB ? 'l' : Math.abs(x - r.right) < GRAB ? 'r' : '';
    const v = Math.abs(y - r.top) < GRAB ? 't' : Math.abs(y - r.bottom) < GRAB ? 'b' : '';
    return h + v;
  }
  function resizeTo(x, y) {
    const { edges, x0, y0, w0, h0 } = drag;
    const sx = edges.includes('l') ? -1 : edges.includes('r') ? 1 : 0;
    const sy = edges.includes('t') ? -1 : edges.includes('b') ? 1 : 0;
    if (sx) slot.style.width = clamp(w0 + 2 * sx * (x - x0), MIN_W, innerWidth - 32) + 'px';
    if (sy) fixedH = h0 + 2 * sy * (y - y0);
    // Never shorter than the letter needs at this width, nor taller than the space it's centered in.
    document.body.classList.remove('sized');
    slot.style.height = '';
    const need = slot.getBoundingClientRect().height;
    const main = slot.parentElement, pad = parseFloat(getComputedStyle(main).paddingTop);
    slot.style.height = Math.max(need, Math.min(fixedH, main.clientHeight - 2 * pad)) + 'px';
    document.body.classList.add('sized');
    $('resetSize').hidden = false;
    cancelAnimationFrame(sizeFrame);
    sizeFrame = requestAnimationFrame(start);
  }

  /* ---------- Nav ----------
     Clicking a link makes its pill the current page. For now the links don't navigate. */
  const nav = document.querySelector('.nav');
  nav?.addEventListener('click', e => {
    const a = e.target.closest?.('.pill');
    if (!a) return;
    e.preventDefault();
    nav.querySelector('[aria-current]')?.removeAttribute('aria-current');
    a.setAttribute('aria-current', 'page');
  });
})();
