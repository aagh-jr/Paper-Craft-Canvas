/* Parchment paper texture for the sheet (main.js):
   cloudy formation + fine tooth + fibers, drawn to an N x N canvas with transparency.
   Options change the stock: `cloud` (how patchy), `tooth` (how grainy), `fibers` and `specks`
   (how many, per 1024px), `fiberLen` (longest fiber, px), `spread` (how far fibers stray from one
   direction, radians) and `fuzz` (how soft the fibers are, px). */
window.drawParchment = (() => {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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

  function drawParchment(N = 1024, { cloud = 1, tooth = 1, fibers = 2800, fiberLen = 42, spread = 2.4, specks = 260, fuzz = 0 } = {}) {
    const area = (N / 1024) ** 2;     // fibers and specks scale with area
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
        // Wider swings than the original study: there the cloudiness showed up against whatever
        // was underneath, but on a white page the alpha variation is all there is to see.
        const a = clamp(.5 + ((f - .5) * 1.25 + (m - .5) * .45) * cloud + (g - .5) * .12 * tooth, .28, .94);   // the thinnest, grayest spots kept a little lighter
        const lum = (g - .5) * 7 * tooth + (m - .5) * 10;
        const i = (y * N + x) * 4;
        px[i] = 242 + lum; px[i + 1] = 239 + lum; px[i + 2] = 231 + lum * .9;   // lighter than the study's pulp, so the body tone below can stay light too
        px[i + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Fibers: mostly light (denser pulp), a few darker, loosely aligned. With fuzz they're drawn
    // on their own layer and softened all at once, so they read as a nap rather than scratches.
    const base = ctx;
    let fl = ctx;
    if (fuzz) {
      const fc = document.createElement('canvas');
      fc.width = fc.height = N;
      fl = fc.getContext('2d');
    }
    {
    const ctx = fl;
    const machine = -0.12;
    for (let i = 0; i < fibers * area; i++) {
      const x = Math.random() * N, y = Math.random() * N;
      const len = 4 + Math.pow(Math.random(), 2) * fiberLen;
      const ang = machine + (Math.random() - .5) * spread;
      const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
      const bend = (Math.random() - .5) * len * .5;
      const cx = (x + ex) / 2 - Math.sin(ang) * bend, cy = (y + ey) / 2 + Math.cos(ang) * bend;
      const light = Math.random() < .72, a = Math.random();
      const stroke = (dx, dy) => { ctx.beginPath(); ctx.moveTo(x + dx, y + dy); ctx.quadraticCurveTo(cx + dx, cy + dy, ex + dx, ey + dy); ctx.stroke(); };
      ctx.lineWidth = .35 + Math.random() * .9;
      if (light) {
        // Light fibers are invisible on a white page on their own, so each gets a faint darker
        // edge beside it, like a fine scratch in the surface.
        ctx.strokeStyle = `rgba(120,98,66,${.05 + a * .1})`;
        stroke(.9, 1.1);
        ctx.strokeStyle = `rgba(255,253,246,${.14 + a * .3})`;
        stroke(0, 0);
      } else {
        ctx.strokeStyle = `rgba(150,128,92,${.03 + a * .07})`;
        stroke(0, 0);
      }
    }
    }
    if (fuzz) { base.filter = `blur(${fuzz}px)`; base.drawImage(fl.canvas, 0, 0); base.filter = 'none'; }
    // Specks
    for (let i = 0; i < specks * area; i++) {
      ctx.fillStyle = `rgba(120,98,66,${.05 + Math.random() * .1})`;
      ctx.beginPath();
      ctx.arc(Math.random() * N, Math.random() * N, .4 + Math.random() * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    return cv;
  }
  return drawParchment;
})();
