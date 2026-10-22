# Paper Craft Canvas

A paper editor (it started as a toy called Parchment).

A sheet of paper you can play with in the browser, and the workbench for designing new papers.
It's the full version of the letter on the portfolio home page (aagh.site): the same sheet,
plus every switch for trying out stocks, colors, edges and effects. When a combination looks
right, copy the files into the portfolio (see "Porting to the portfolio" below).

## The toolbar

| Control | What it changes |
| --- | --- |
| Font | The letter's typeface |
| Texture: Shader / Generator / Split | The paper texture: Paper Shaders' `paper-texture` (WebGL2), the original canvas generator (`drawParchment`), or shader on the left half and generator on the right |
| Border: None / Hills | A row of round bumps around the whole edge, one round hill per corner |
| Parchment / Vellum / Construction / Metallic | Paper stock, each with its own palette of colors |
| Square / Scalloped | Corner shape (a border takes its place) |
| Edit text, Binder holes, Link tabs, Resize, Thick, Color blocks, Show effects, Indent | The switches, bottom right |
| Intro A / B | Replays either entrance |
| Cmd/Ctrl+Z | Steps back through all of the above |

The letter itself: select words while editing to punch them out, press them in or raise them.
H toggles the hole punch, T the text tool.

## Porting to the portfolio

The portfolio home page runs these same scripts with the toolbar left out. It keeps its own
copies in `public/paper/` (`main.js`, `paper-texture.js`, `paper-shader.js`, and the paper
styles in `paper.css`), and sets `window.PAPER_CONFIG` for its starting choices (e.g.
`{ border: 'hills', keys: false, ignore: '#work' }`). To bring a change over, copy the
changed script; for styles, copy the paper rules (not the toolbar or page rules) into
`paper.css`.

## Run it

No build step. One dependency, `@paper-design/shaders` (pinned to 0.0.82), loaded straight
from `node_modules`, so install it once and serve the folder:

```sh
npm install
python3 -m http.server 8000   # then open http://localhost:8000
```

Opened from disk (`file://`) the browser won't load the shader module, so the paper falls
back to the generator; everything else works the same.

## Interactions

| Do this | What happens |
| --- | --- |
| Drag the sheet | Slides like paper on a table; the far side lags and swings. Flick to toss. |
| Grab just outside a corner (curved arrows) | Rotate around the center. |
| Hover / pull a corner or edge | Corner lifts; pulling folds it along a real crease. |
| Peel past halfway and let go | Fold completes, the sheet flips over and lifts off. Reset brings it back. |
| **Text** (T) → click the paper | Type printed text onto the sheet; click a line to edit it. |
| **Hole punch** (H) → click | Round hole; the disc falls off the screen with gravity. |
| Hole punch → click a line of text | Letters are die-cut out and tumble away one by one. |
| **Perforated** | Sheet with a perforation down the middle. Pull a half sideways to tear from the nearer end; tear from both ends and they meet in the middle. A fold that crosses the perforation tears it too, so peeling a half past halfway rips it off. |
| **Show underlay** | Puts a mock layout under the sheet to show the translucency. |

## How it works

Everything is DOM + CSS, no canvas or WebGL at runtime.

- **Texture**: generated once on load into a canvas (value-noise "formation" clouds,
  per-pixel tooth, ~2.8k fibers, specks) and used as a blob-URL background. The alpha
  varies, so the sheet is unevenly translucent like real parchment.
- **Translucency**: `backdrop-filter: blur() contrast() brightness()` on each paper layer.
  Avoid `opacity < 1`, `filter`, or `mask` on *ancestors* of a backdrop-filtered layer —
  they become a Backdrop Root and the frosting stops seeing the page behind.
- **Pieces** (`createPiece`): one physical sheet, or one half of the perforated sheet.
  Each piece has a shadow layer, a sheet layer, a flap shadow, a flap layer, and four
  rotate handles. Geometry is in piece-local px; `frame(p)` maps local → world.
- **Folding**: the crease is the perpendicular bisector of the grabbed point `C` and the
  pointer `P`. The outline is split with a half-plane clip (`clipHalf`); the folded part
  is drawn in the flap layer with a reflection `matrix()` across the crease.
- **Holes, perforation, cut-out text**: one SVG mask per piece (`updateMask`) applied to
  the sheet, flap, and both shadow layers, so light passes through holes onto the table.
- **Printed text**: SVG `<text>` in an `.ink` layer. The same markup (`textSvg`) is reused
  in the mask to die-cut it, so the holes match the glyphs exactly.
- **Perforated sheet**: two pieces share a `pair` body while joined. Each end has its own
  tear front (`pair.tears.top` / `.bottom`, length `L` in px). While pulled, the torn
  strip of the held half is drawn in a `.strip` layer, sheared about the front so it stays
  attached there; the untorn middle never moves. A peel fold that crosses the perforation
  extends the tear to the crease (`foldTear`). When the fronts meet, the pieces
  `separate()` into free bodies with a notched edge (half of every perforation slit).
- **Falling bits** (`chads`): discs and letters are simple particles with gravity,
  flutter, and spin, removed once they leave the screen.

## Files

```
index.html        markup + toolbar
src/style.css     all styles
src/main.js       texture, pieces, physics, folding, punch, text, tearing
src/paper-texture.js  drawParchment, the canvas texture generator (the fallback)
src/paper-shader.js   one frame of Paper Shaders' paper-texture, via WebGL2
scripts/shot.sh   headless Chrome screenshot helper for checking visual changes
```

## Checking changes visually

`scripts/shot.sh` takes a headless Chrome screenshot of `index.html` (macOS, Google Chrome):

```sh
scripts/shot.sh out.png                              # default 1100x850
scripts/shot.sh out.png 1400x900
scripts/shot.sh out.png 1100x850 index.html test.js  # run an interaction first
```

Gotchas, learned the hard way:

- Headless Chrome runs on virtual time and barely advances `requestAnimationFrame`, so the
  script renders a temporary copy that drives rAF with `setTimeout(…, 16)`. Without that,
  the sheet shows up as a blotchy half-faded square.
- The screenshot is taken when the virtual-time budget ends, **not** when your test
  finishes. Set `window.__freeze = true` at the moment you want to capture, or anything
  animated (falling chads, peel-off) will be long gone.
- Synthetic events are dispatched on `window`, so `e.target` is `window`. Handlers use
  `e.target.closest?.(…)` for that reason.
- Wait ~1.5s before interacting so the texture has finished generating.
