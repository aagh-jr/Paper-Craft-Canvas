/* Paper texture from Paper Shaders' paper-texture (@paper-design/shaders, pinned in package.json),
   rendered once with WebGL2 into a plain 2D canvas that main.js uses just like drawParchment's.
   Nothing animates: one frame is drawn, copied out, and the WebGL context is thrown away.

   paperShaderSupported() is a quick WebGL2 check. renderPaperShader(N, opts) resolves to an
   N x N canvas, or rejects (no WebGL2, the module didn't load, the shader didn't compile, the
   context was lost), and main.js falls back to drawParchment. Opened from disk (file://), the
   browser won't load the module, so it always falls back there.

   opts: the shader's own params (roughness, fiber, drops, ...; see paper-texture.d.ts), plus
   `paper` and `shadow` colors as [r, g, b, a] in 0-255 / 0-1, `scale` (how many tile widths
   of pattern fit across the canvas, so grain stays the same size in CSS px on any sheet) and
   `grazing` (how low the light sits, radians from straight above; the shader's own is .7). */
(() => {
  // Where the package's dist folder is served: node_modules next to this folder, unless the page
  // says otherwise (window.PAPER_SHADERS_DIST, e.g. a vendored copy).
  const DIST = window.PAPER_SHADERS_DIST
    || new URL('../node_modules/@paper-design/shaders/dist/', document.currentScript.src).href;

  let supported;
  window.paperShaderSupported = () => {
    if (supported !== undefined) return supported;
    try {
      const cv = document.createElement('canvas');
      const gl = typeof WebGL2RenderingContext !== 'undefined' && cv.getContext('webgl2');
      supported = !!gl;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { supported = false; }
    return supported;
  };

  // The module and the noise image it samples, loaded once.
  let lib;
  const load = () => lib ||= Promise.all([
    import(DIST + 'shaders/paper-texture.js'),
    import(DIST + 'vertex-shader.js'),
    import(DIST + 'get-shader-noise-texture.js'),
  ]).then(async ([{ paperTextureFragmentShader }, { vertexShaderSource }, { getShaderNoiseTexture }]) => {
    const noise = getShaderNoiseTexture();
    await noise.decode();
    // The light's height above the paper is fixed in the shader; make it a uniform so metallic
    // paper can be lit from low down. Pinned version, so these lines are known to be there.
    const GRAZE = 'float grazing = 0.7;', ANGLE = 'uniform float u_angle;';
    if (!paperTextureFragmentShader.includes(GRAZE) || !paperTextureFragmentShader.includes(ANGLE))
      throw new Error('paper-texture shader changed; can\'t set the light height');
    const frag = paperTextureFragmentShader
      .replace(ANGLE, ANGLE + '\nuniform float u_grazing;')
      .replace(GRAZE, 'float grazing = u_grazing;');
    return { frag, vert: vertexShaderSource, noise };
  }).catch(err => { lib = null; throw err; });

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error(gl.isContextLost() ? 'WebGL2 context lost' : 'paper-texture: ' + gl.getShaderInfoLog(sh));
    return sh;
  }

  const DEFAULTS = {
    angle: 0, seed: 0, grazing: .7, scale: 1,
    roughness: 0, roughnessSize: .5, roughnessRows: 0, fiber: 0, fiberSize: .5,
    folds: 0, foldSizeX: .5, foldSizeY: .5, foldOffsetX: 0, foldOffsetY: 0,
    wrinkles: 0, wrinkleSize: .5, crumples: 0, crumpleCount: 5, drops: 0,
  };
  const rgba = ([r, g, b, a = 1]) => [r / 255, g / 255, b / 255, a];

  window.renderPaperShader = async (N, opts = {}) => {
    if (!paperShaderSupported()) throw new Error('no WebGL2');
    const { frag, vert, noise } = await load();
    const o = { ...DEFAULTS, ...opts };

    const glc = document.createElement('canvas');
    glc.width = glc.height = N;
    const gl = glc.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 context failed to create');
    try {
      const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
      if (N > max) throw new Error(`texture ${N}px is past this GPU's ${max}px`);

      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vert));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('paper-texture: ' + gl.getProgramInfoLog(prog));
      gl.useProgram(prog);

      // One quad over the whole canvas, as ShaderMount draws it.
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const pos = gl.getAttribLocation(prog, 'a_position');
      gl.enableVertexAttribArray(pos);
      gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, noise);

      const loc = n => gl.getUniformLocation(prog, n);
      const f = (n, v) => gl.uniform1f(loc(n), v);
      gl.uniform1i(loc('u_noiseTexture'), 0);
      gl.uniform2f(loc('u_resolution'), N, N);
      // Square canvas, fit "cover": the image UV runs 0-1 across it, the pattern hangs off that.
      f('u_pixelRatio', 1); f('u_imageAspectRatio', 1); f('u_fit', 2);
      f('u_originX', .5); f('u_originY', .5); f('u_worldWidth', 0); f('u_worldHeight', 0);
      f('u_rotation', 0); f('u_offsetX', 0); f('u_offsetY', 0); f('u_scale', o.scale);
      gl.uniform1i(loc('u_isImage'), 0); gl.uniform1i(loc('u_clip'), 0);
      f('u_blending', 0); f('u_distortion', 0);
      gl.uniform4fv(loc('u_colorBack'), [0, 0, 0, 0]);
      gl.uniform4fv(loc('u_colorPaper'), rgba(o.paper));
      gl.uniform4fv(loc('u_colorShadow'), rgba(o.shadow));
      f('u_grazing', o.grazing);
      for (const k of ['angle', 'seed', 'roughness', 'roughnessSize', 'roughnessRows', 'fiber', 'fiberSize',
        'folds', 'foldSizeX', 'foldSizeY', 'foldOffsetX', 'foldOffsetY', 'wrinkles', 'wrinkleSize',
        'crumples', 'crumpleCount', 'drops']) f('u_' + k, o[k]);

      gl.viewport(0, 0, N, N);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (gl.isContextLost()) throw new Error('WebGL2 context lost');
      const err = gl.getError();
      if (err !== gl.NO_ERROR) throw new Error('WebGL error ' + err);

      // Copy out to a 2D canvas so the GPU side can go right away.
      const cv = document.createElement('canvas');
      cv.width = cv.height = N;
      cv.getContext('2d').drawImage(glc, 0, 0);
      return cv;
    } finally {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      glc.width = glc.height = 0;
    }
  };
})();
