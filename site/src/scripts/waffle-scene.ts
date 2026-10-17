// @ts-nocheck -- The owner-provided procedural scene is preserved verbatim apart from its ES module import.
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Clock,
  Color,
  ConeGeometry,
  CustomBlending,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  ExtrudeGeometry,
  Float32BufferAttribute,
  FrontSide,
  Group,
  HalfFloatType,
  HemisphereLight,
  LatheGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  NoToneMapping,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  PCFSoftShadowMap,
  Path,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RedFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  Shape,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer
} from 'three';

/*
 * Waffle scene v2 — a blueprint of connected programs that turns out to be a waffle town.
 * Cartoon city-builder look: toon shading + ink outline post-pass.
 * Uses the matching three.js r158 module build.
 * API: WaffleScene.mount(canvas, opts) -> { setProgress(p, now), setLayout(l), setLabels(b), getProgress(), destroy() } | null
 * opts: { progress, layout: 'split'|'stack'|'center', labels, interactive, quality: 'high'|'low', background: true }
 */
(function () {
  'use strict';

  var DEG = Math.PI / 180;
  var FONT = '"Fredoka", "Arial Rounded MT Bold", "Trebuchet MS", system-ui, sans-serif';
  var MONO = '"Martian Mono", ui-monospace, Menlo, monospace';

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function sstep(a, b, x) { var t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function backOut(t) { if (t <= 0) return 0; if (t >= 1) return 1; var c1 = 2.0, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function bounceOut(x) {
    var n1 = 7.5625, d1 = 2.75;
    if (x < 1 / d1) return n1 * x * x;
    if (x < 2 / d1) { x -= 1.5 / d1; return n1 * x * x + 0.75; }
    if (x < 2.5 / d1) { x -= 2.25 / d1; return n1 * x * x + 0.9375; }
    x -= 2.625 / d1; return n1 * x * x + 0.984375;
  }
  function hash(x, z) { var s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }

  var PITCH = 2.5, HW = 0.56, RIDGE_H = 0.72, SLAB = 0.5, LINE = 5.0, EDGE = 5.4, CORNER = 0.8;
  var DOM = 5.625, SEG = 180;
  var AZ_FINAL = -34 * DEG, EL_FINAL = 37 * DEG, EL_START = 88.5 * DEG;
  function cellX(c) { return -3.75 + c * PITCH; }
  function cellZ(r) { return -3.75 + r * PITCH; }

  function phases(p) {
    return {
      cam: sstep(0.06, 0.62, p), fit: sstep(0.28, 0.78, p), ridge: sstep(0.2, 0.6, p),
      lit: sstep(0.22, 0.56, p), color: sstep(0.22, 0.5, p), lines: 1 - sstep(0.18, 0.42, p),
      slab: sstep(0.26, 0.6, p), world: sstep(0.5, 0.78, p), labels: sstep(0.88, 0.97, p),
      syrup: sstep(0.82, 0.96, p)
    };
  }
  var SKY_TOP_A = [0x23, 0x50, 0xC7], SKY_BOT_A = [0x23, 0x50, 0xC7];
  var SKY_TOP_B = [0x86, 0xCC, 0xFF], SKY_BOT_B = [0xE9, 0xF6, 0xFF];
  function mixRGB(a, b, t) { return 'rgb(' + Math.round(lerp(a[0], b[0], t)) + ',' + Math.round(lerp(a[1], b[1], t)) + ',' + Math.round(lerp(a[2], b[2], t)) + ')'; }

  function mount(canvas, opts) {
    opts = opts || {};
    var renderer;
    try {
      renderer = new WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    } catch (e) { return null; }
    if (!renderer || !renderer.getContext()) return null;
    var isGL2 = renderer.capabilities.isWebGL2;
    var low = opts.quality === 'low' || window.innerWidth < 700;
    var small = window.innerWidth * window.innerHeight < 700000;
    var DPR = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(DPR);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;

    var scene = new Scene();
    var overlay = new Scene();
    var camera = new PerspectiveCamera(30, 1, 0.5, 400);
    var U = { uFlat: { value: 1 }, uEdge: { value: 0.02 } };
    var disposables = [];
    var REG_INIT = null;
    var hideInNormals = [];

    // ---------- materials ----------
    var gradMap = new DataTexture(new Uint8Array([105, 182, 255]), 3, 1, RedFormat);
    gradMap.minFilter = gradMap.magFilter = NearestFilter; gradMap.generateMipmaps = false; gradMap.needsUpdate = true;
    disposables.push(gradMap);

    function patch(m, waffle) {
      m.onBeforeCompile = function (s) {
        s.uniforms.uFlat = U.uFlat;
        if (waffle) {
          s.uniforms.uEdge = U.uEdge;
          s.vertexShader = s.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float aOut;\nvarying float vOut;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOut = aOut;');
        }
        s.fragmentShader = s.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uFlat;' + (waffle ? '\nuniform float uEdge;\nvarying float vOut;' : ''))
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + (waffle ? '\nif (vOut > uEdge) discard;' : ''))
          .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, diffuseColor.rgb + totalEmissiveRadiance, uFlat);');
      };
      m.customProgramCacheKey = function () { return waffle ? 'toon-waffle' : 'toon-flat'; };
      disposables.push(m);
      return m;
    }
    var MC = {};
    function toon(hex, o) {
      o = o || {};
      var key = hex + '|' + (o.e || 0) + '|' + (o.ei || 0) + '|' + (o.t ? 1 : 0) + '|' + (o.map ? o.map.uuid : '') + '|' + (o.uniq ? Math.random() : '');
      if (MC[key]) return MC[key];
      var m = patch(new MeshToonMaterial({
        color: hex, gradientMap: gradMap, emissive: o.e != null ? o.e : 0x000000, emissiveIntensity: o.ei != null ? o.ei : 1,
        transparent: !!o.t, opacity: o.o != null ? o.o : 1, map: o.map || null, side: o.side || FrontSide
      }));
      MC[key] = m;
      return m;
    }
    function basic(hex, o) {
      o = o || {};
      var m = new MeshBasicMaterial({ color: hex, transparent: o.t !== false, opacity: o.o != null ? o.o : 1, map: o.map || null, depthWrite: o.dw !== false, side: o.side || FrontSide });
      disposables.push(m);
      return m;
    }

    // ---------- geometry ----------
    var geoCache = {};
    function rboxGeo(w, h, d, r, taper) {
      r = Math.max(0.004, Math.min(r == null ? 0.05 : r, w / 2 - 0.002, h / 2 - 0.002, d / 2 - 0.002));
      taper = taper || 1;
      var key = [w, h, d, r, taper].join('|');
      if (geoCache[key]) return geoCache[key];
      var k = 2, S = 2 * k + 1;
      var g = new BoxGeometry(1, 1, 1, S, S, S);
      var pos = g.attributes.position, nor = g.attributes.normal;
      var H = [w / 2, h / 2, d / 2], v = [0, 0, 0], inn = [0, 0, 0], dv = [0, 0, 0];
      for (var i = 0; i < pos.count; i++) {
        var src = [pos.getX(i), pos.getY(i), pos.getZ(i)];
        for (var a = 0; a < 3; a++) {
          var idx = Math.round((src[a] + 0.5) * S);
          var t = idx <= k ? -H[a] + r * idx / k : H[a] - r * (S - idx) / k;
          inn[a] = Math.max(-(H[a] - r), Math.min(H[a] - r, t));
          dv[a] = t - inn[a];
        }
        var L = Math.sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]) || 1;
        for (var b = 0; b < 3; b++) v[b] = inn[b] + dv[b] / L * r;
        nor.setXYZ(i, dv[0] / L, dv[1] / L, dv[2] / L);
        var s = 1 + (taper - 1) * ((v[1] + H[1]) / (2 * H[1]));
        pos.setXYZ(i, v[0] * s, v[1] + H[1], v[2] * s);
      }
      g.deleteAttribute('uv');
      g.computeBoundingSphere();
      geoCache[key] = g; disposables.push(g);
      return g;
    }
    function boxUV(w, h, d) { var g = new BoxGeometry(w, h, d, 1, 1, 1); g.translate(0, h / 2, 0); disposables.push(g); return g; }
    function mesh(geo, m) { var x = new Mesh(geo, m); x.castShadow = true; x.receiveShadow = true; return x; }
    function rb(w, h, d, m, r, taper) { return mesh(rboxGeo(w, h, d, r, taper), m); }
    function tb(w, h, d, m) { return mesh(boxUV(w, h, d), m); }
    function cyl(rt, rbt, h, seg, m) { var k = 'c' + [rt, rbt, h, seg].join('|'); var g = geoCache[k]; if (!g) { g = new CylinderGeometry(rt, rbt, h, seg || 20); g.translate(0, h / 2, 0); g.deleteAttribute('uv'); geoCache[k] = g; disposables.push(g); } return mesh(g, m); }
    function sph(r, m, half) { var k = 's' + r + (half ? 'h' : ''); var g = geoCache[k]; if (!g) { g = new SphereGeometry(r, 22, half ? 10 : 16, 0, Math.PI * 2, 0, half ? Math.PI / 2 : Math.PI); g.deleteAttribute('uv'); geoCache[k] = g; disposables.push(g); } return mesh(g, m); }
    function cone(r, h, seg, m) { var k = 'k' + [r, h, seg].join('|'); var g = geoCache[k]; if (!g) { g = new ConeGeometry(r, h, seg || 16); g.translate(0, h / 2, 0); g.deleteAttribute('uv'); geoCache[k] = g; disposables.push(g); } return mesh(g, m); }
    function at(parent, m, x, y, z, ry) { m.position.set(x || 0, y || 0, z || 0); if (ry) m.rotation.y = ry; parent.add(m); return m; }
    function G() { return new Group(); }
    function dyn(o) { o.userData.dyn = true; return o; }

    // merge static meshes of a building by material to save draw calls
    function bake(root) {
      root.updateMatrixWorld(true);
      var inv = new Matrix4().copy(root.matrixWorld).invert();
      var buckets = {}, victims = [];
      (function walk(o, isDyn) {
        var d = isDyn || !!o.userData.dyn;
        if (o !== root && o.isMesh && !d && !o.material.map && !o.material.transparent && o.geometry.attributes.normal) {
          var key = o.material.uuid;
          (buckets[key] = buckets[key] || { mat: o.material, parts: [] }).parts.push(o);
          victims.push(o);
        }
        for (var i = 0; i < o.children.length; i++) walk(o.children[i], d);
      })(root, false);
      Object.keys(buckets).forEach(function (k) {
        var bk = buckets[k], posArr = [], norArr = [], m4 = new Matrix4(), n3 = new Matrix3();
        bk.parts.forEach(function (o) {
          var g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
          m4.multiplyMatrices(inv, o.matrixWorld); n3.getNormalMatrix(m4);
          var p = g.attributes.position, n = g.attributes.normal, v = new Vector3();
          for (var i = 0; i < p.count; i++) {
            v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(m4); posArr.push(v.x, v.y, v.z);
            v.set(n.getX(i), n.getY(i), n.getZ(i)).applyMatrix3(n3).normalize(); norArr.push(v.x, v.y, v.z);
          }
          if (g !== o.geometry) g.dispose();
        });
        var mg = new BufferGeometry();
        mg.setAttribute('position', new Float32BufferAttribute(posArr, 3));
        mg.setAttribute('normal', new Float32BufferAttribute(norArr, 3));
        mg.computeBoundingSphere(); disposables.push(mg);
        root.add(mesh(mg, bk.mat));
      });
      victims.forEach(function (o) { o.parent.remove(o); });
    }

    // ink shell: a back-face copy pushed out along the normals
    var hullU = { uThick: { value: 0.0 }, uCol: { value: new Color(0x2A1F33) } };
    var hullMat = new ShaderMaterial({
      uniforms: hullU, side: BackSide,
      vertexShader: 'uniform float uThick; void main(){ vec3 p = position + normalize(normal) * uThick; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }',
      fragmentShader: 'uniform vec3 uCol; void main(){ gl_FragColor = vec4(uCol, 1.0);\n#include <colorspace_fragment>\n}'
    });
    disposables.push(hullMat);
    function outline(root) {
      var list = [];
      root.traverse(function (x) { if (x.isMesh && x.material && !x.material.map && !x.material.transparent && !x.isSprite && x.material.type !== 'MeshBasicMaterial' && x.material !== hullMat && x.geometry.attributes.normal) list.push(x); });
      list.forEach(function (x) { var h = new Mesh(x.geometry, hullMat); h.castShadow = false; h.receiveShadow = false; h.userData.hull = true; x.add(h); });
    }

    // ---------- canvas textures ----------
    var textures = [];
    function tex(w, h, draw, repeat) {
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var ctx = c.getContext('2d');
      var t = new CanvasTexture(c);
      t.colorSpace = SRGBColorSpace;
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      if (repeat) { t.wrapS = t.wrapT = RepeatWrapping; }
      var api = { tex: t, ctx: ctx, redraw: function () { draw(ctx, w, h); t.needsUpdate = true; } };
      api.redraw(); textures.push(api); disposables.push(t);
      return api;
    }
    function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
    function stripes(c1, c2, n, vertical) {
      return tex(128, 128, function (ctx, w, h) { for (var i = 0; i < n; i++) { ctx.fillStyle = i % 2 ? c2 : c1; if (vertical) ctx.fillRect(i * w / n, 0, w / n + 1, h); else ctx.fillRect(0, i * h / n, w, h / n + 1); } });
    }
    function signPlane(text, w, h, bg, fg, opt) {
      opt = opt || {};
      var pw = 512, ph = Math.round(512 * h / w);
      var t = tex(pw, ph, function (ctx, W, H) {
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = bg; rr(ctx, 4, 4, W - 8, H - 8, Math.min(H * 0.3, 40)); ctx.fill();
        ctx.lineWidth = 8; ctx.strokeStyle = '#2A1F33'; ctx.stroke();
        var fs = Math.floor(H * (opt.scale || 0.62));
        ctx.font = '700 ' + fs + 'px ' + FONT;
        while (ctx.measureText(text).width > W * 0.86 && fs > 10) { fs -= 2; ctx.font = '700 ' + fs + 'px ' + FONT; }
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        if (opt.outline) { ctx.lineWidth = fs * 0.16; ctx.strokeStyle = opt.outline; ctx.lineJoin = 'round'; ctx.strokeText(text, W / 2, H / 2 + fs * 0.06); }
        ctx.fillStyle = fg; ctx.fillText(text, W / 2, H / 2 + fs * 0.06);
      });
      var g = new PlaneGeometry(w, h); disposables.push(g);
      return new Mesh(g, basic(0xffffff, { map: t.tex, t: true }));
    }

    // ---------- lights ----------
    var hemi = new HemisphereLight(0xF3F7FF, 0xB98A5A, 1.45); scene.add(hemi);
    var sun = new DirectionalLight(0xFFF3E0, 1.85);
    sun.position.set(-6, 15, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(low ? 1024 : 2048, low ? 1024 : 2048);
    var sc = sun.shadow.camera; sc.left = -10; sc.right = 10; sc.top = 10; sc.bottom = -10; sc.near = 2; sc.far = 40;
    sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.03;
    scene.add(sun); scene.add(sun.target);

    // ---------- ground: blueprint paper, then just a soft shadow on the sky ----------
    var GROUND_Y = -SLAB - 0.004;
    var bpTex = tex(512, 512, function (ctx, w, h) {
      ctx.fillStyle = '#2350C7'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 1.5;
      for (var i = 0; i < 16; i++) { var q = i * 32 + 0.5; ctx.beginPath(); ctx.moveTo(q, 0); ctx.lineTo(q, h); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, q); ctx.lineTo(w, q); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 2.5;
      for (var j = 0; j < 4; j++) { var k = j * 128 + 1; ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k, h); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, k); ctx.lineTo(w, k); ctx.stroke(); }
    }, true);
    bpTex.tex.repeat.set(20, 20);
    var groundGeo = new PlaneGeometry(200, 200); groundGeo.rotateX(-Math.PI / 2); disposables.push(groundGeo);
    var bpMat = new ShaderMaterial({
      transparent: true, depthWrite: false, extensions: { derivatives: true },
      uniforms: { opacity: { value: 1 }, uBg: { value: new Color(0x2350C7) } },
      vertexShader: 'varying vec2 vP; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: [
        'uniform float opacity; uniform vec3 uBg; varying vec2 vP;',
        'float grid(vec2 p, float s, float px){ vec2 d = abs(fract(p / s - 0.5) - 0.5) * s; vec2 fw = max(fwidth(p), vec2(1e-5)); vec2 l = 1.0 - smoothstep(fw * (px * 0.5 - 0.5), fw * (px * 0.5 + 0.5), d); return max(l.x, l.y); }',
        'void main(){',
        '  vec3 c = mix(uBg, vec3(1.0), grid(vP, 0.625, 1.2) * 0.1);',
        '  c = mix(c, vec3(1.0), grid(vP, 2.5, 2.2) * 0.2);',
        '  gl_FragColor = vec4(c, opacity);',
        '#include <colorspace_fragment>',
        '}'
      ].join('\n')
    });
    disposables.push(bpMat);
    var blueprint = new Mesh(groundGeo, bpMat); blueprint.position.y = GROUND_Y; blueprint.renderOrder = -2; scene.add(blueprint);
    hideInNormals.push(blueprint);
    var shadowMat = new ShadowMaterial({ color: 0x1B2A6B, opacity: 0.0, depthWrite: false }); disposables.push(shadowMat);
    var shadowCatcher = new Mesh(groundGeo, shadowMat); shadowCatcher.position.y = GROUND_Y; shadowCatcher.receiveShadow = true; shadowCatcher.renderOrder = -1; scene.add(shadowCatcher);
    hideInNormals.push(shadowCatcher);
    var blobTex = tex(128, 128, function (ctx, w, h) { var gr = ctx.createRadialGradient(64, 64, 10, 64, 64, 64); gr.addColorStop(0, 'rgba(20,30,90,0.55)'); gr.addColorStop(0.6, 'rgba(20,30,90,0.22)'); gr.addColorStop(1, 'rgba(20,30,90,0)'); ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h); });
    var blobGeo = new PlaneGeometry(17, 17); blobGeo.rotateX(-Math.PI / 2); disposables.push(blobGeo);
    var blobMat = basic(0xffffff, { map: blobTex.tex, dw: false, o: 0 });
    var blob = new Mesh(blobGeo, blobMat); blob.position.y = GROUND_Y + 0.002; blob.renderOrder = -1; scene.add(blob); hideInNormals.push(blob);

    // ---------- the waffle: crisp interior grid inside a rounded rim ----------
    var SEGI = 160;
    var wGeo = new PlaneGeometry(LINE * 2, LINE * 2, SEGI, SEGI); wGeo.rotateX(-Math.PI / 2); wGeo.deleteAttribute('uv'); disposables.push(wGeo);
    var wPos = wGeo.attributes.position, nV = wPos.count;
    var vR = new Float32Array(nV);
    var colFlat = new Float32Array(nV * 3), colWaffle = new Float32Array(nV * 3), colors = new Float32Array(nV * 3);
    var cT = new Color(), cA = new Color(), cB = new Color();
    var SHEET = 0x2C5AD4, FLOOR = 0xFFDC92, FLOOR_AO = 0xEDA142, WALL = 0xF4AC48, TOP = 0xD07A28, TOP_HI = 0xFFCF6A, CRUST = 0xB86826;
    function prof(d) { var u = d / HW; return u >= 1 ? 0 : 1 - sstep(0.5, 0.86, u); }
    function nearLine(v) { var k = Math.round((v + LINE) / PITCH); k = Math.max(0, Math.min(4, k)); return Math.abs(v - (k * PITCH - LINE)); }
    function paint(out, r, ao, lip, n) {
      out.setHex(FLOOR).lerp(cB.setHex(FLOOR_AO), ao * 0.75);
      out.lerp(cB.setHex(WALL), sstep(0.02, 0.45, r));
      var top = sstep(0.86, 0.995, r);
      out.lerp(cB.setHex(TOP), top * 0.85);
      out.lerp(cB.setHex(TOP_HI), top * lip * 0.85);
      out.r = clamp01(out.r * (1 + n)); out.g = clamp01(out.g * (1 + n)); out.b = clamp01(out.b * (1 + n));
      return out;
    }
    for (var i = 0; i < nV; i++) {
      var x = wPos.getX(i), z = wPos.getZ(i);
      var dx = nearLine(x), dz = nearLine(z), px = prof(dx), pz = prof(dz);
      var r = Math.max(px, pz), dDom = px >= pz ? dx : dz, dmin = Math.min(dx, dz);
      vR[i] = r;
      cT.setHex(SHEET).toArray(colFlat, i * 3);
      var ao = 1 - sstep(HW * 0.86, HW + 0.5, dmin);
      paint(cA, r, ao, sstep(0.14, 0.24, dDom), (hash(Math.round(x * 5), Math.round(z * 5)) - 0.5) * 0.05).toArray(colWaffle, i * 3);
    }
    wGeo.setAttribute('color', new BufferAttribute(colors, 3));
    wGeo.setAttribute('aOut', new BufferAttribute(new Float32Array(nV), 1));
    var wMat = patch(new MeshToonMaterial({ vertexColors: true, gradientMap: gradMap }), true);
    var waffle = new Mesh(wGeo, wMat); waffle.castShadow = true; waffle.receiveShadow = true; scene.add(waffle);

    // rim: an extruded rounded-square ring with a soft bevel
    function rrShape(w, h, r, path) {
      var s = path || new Shape(), x = -w / 2, y = -h / 2;
      s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
      s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
      s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
      return s;
    }
    var BV = 0.16, RIM_H = RIDGE_H + SLAB;
    var rimShape = rrShape(2 * (EDGE - BV), 2 * (EDGE - BV), CORNER - BV);
    rimShape.holes.push(rrShape(2 * LINE - 0.02, 2 * LINE - 0.02, 0.3, new Path()));
    var rimGeo = new ExtrudeGeometry(rimShape, { depth: RIM_H - 2 * BV, bevelEnabled: true, bevelThickness: BV, bevelSize: BV, bevelSegments: 4, curveSegments: 12 });
    rimGeo.rotateX(-Math.PI / 2); rimGeo.translate(0, BV, 0); rimGeo.deleteAttribute('uv');
    rimGeo.computeVertexNormals(); disposables.push(rimGeo);
    var rp = rimGeo.attributes.position, nR = rp.count;
    var rimFlat = new Float32Array(nR * 3), rimWaffle = new Float32Array(nR * 3), rimCol = new Float32Array(nR * 3);
    for (var ri = 0; ri < nR; ri++) {
      var fy = rp.getY(ri) / RIM_H, ax = Math.max(Math.abs(rp.getX(ri)), Math.abs(rp.getZ(ri)));
      cT.setHex(SHEET).toArray(rimFlat, ri * 3);
      var topK = sstep(0.9, 0.995, fy);
      cA.setHex(CRUST).lerp(cB.setHex(WALL), sstep(0.1, 0.8, fy)).lerp(cB.setHex(TOP), topK * 0.8);
      cA.lerp(cB.setHex(TOP_HI), topK * sstep(LINE + 0.05, LINE + 0.2, ax) * (1 - sstep(EDGE - 0.12, EDGE, ax)) * 0.8);
      cA.toArray(rimWaffle, ri * 3);
    }
    rimGeo.setAttribute('color', new BufferAttribute(rimCol, 3));
    var rim = new Mesh(rimGeo, patch(new MeshToonMaterial({ vertexColors: true, gradientMap: gradMap }))); rim.castShadow = true; rim.receiveShadow = true; scene.add(rim);
    function smoothCopy(geo) {
      var p = geo.attributes.position, nn = geo.attributes.normal, map = {}, keys = [], out = new Float32Array(p.count * 3), v = new Vector3();
      for (var i = 0; i < p.count; i++) {
        var k = Math.round(p.getX(i) * 400) + ',' + Math.round(p.getY(i) * 400) + ',' + Math.round(p.getZ(i) * 400); keys.push(k);
        var e = map[k] || (map[k] = [0, 0, 0]); e[0] += nn.getX(i); e[1] += nn.getY(i); e[2] += nn.getZ(i);
      }
      for (var j = 0; j < p.count; j++) { var m = map[keys[j]]; v.set(m[0], m[1], m[2]).normalize(); out[j * 3] = v.x; out[j * 3 + 1] = v.y; out[j * 3 + 2] = v.z; }
      var g = new BufferGeometry(); g.setAttribute('position', p); g.setAttribute('normal', new BufferAttribute(out, 3)); disposables.push(g);
      return g;
    }
    var rimHull = new Mesh(smoothCopy(rimGeo), hullMat); rim.add(rimHull);
    var waffleHull = new Mesh(wGeo, hullMat); waffle.add(waffleHull);

    var lastShape = '';
    function shapeWaffle(ph) {
      var key = Math.round(ph.ridge * 800) + '|' + Math.round(ph.slab * 800) + '|' + Math.round(ph.color * 800);
      if (key === lastShape) return;
      lastShape = key;
      var H = RIDGE_H * ph.ridge, c = ph.color;
      for (var i = 0; i < nV; i++) {
        wPos.setY(i, H * vR[i]);
        var j = i * 3;
        colors[j] = lerp(colFlat[j], colWaffle[j], c); colors[j + 1] = lerp(colFlat[j + 1], colWaffle[j + 1], c); colors[j + 2] = lerp(colFlat[j + 2], colWaffle[j + 2], c);
      }
      for (var k = 0; k < nR * 3; k++) rimCol[k] = lerp(rimFlat[k], rimWaffle[k], c);
      wPos.needsUpdate = true; wGeo.attributes.color.needsUpdate = true; rimGeo.attributes.color.needsUpdate = true;
      wGeo.computeVertexNormals(); wGeo.computeBoundingSphere();
      var tall = H + SLAB * ph.slab + 0.03 * ph.ridge;
      rim.position.y = -SLAB * ph.slab;
      rim.scale.y = Math.max(0.002, tall / RIM_H);
    }

    // diagram wiring that becomes ridges
    var lineMat = basic(0xEEF3FF, { o: 1 });
    var lines = G(); scene.add(lines); hideInNormals.push(lines);
    for (var k0 = 0; k0 < 5; k0++) {
      var off = k0 * PITCH - LINE;
      var g1 = new PlaneGeometry(0.075, EDGE * 2 - 0.55); g1.rotateX(-Math.PI / 2); disposables.push(g1);
      at(lines, new Mesh(g1, lineMat), off, 0, 0);
      var g2 = new PlaneGeometry(EDGE * 2 - 0.55, 0.075); g2.rotateX(-Math.PI / 2); disposables.push(g2);
      at(lines, new Mesh(g2, lineMat), 0, 0, off);
    }

    // ---------- shared building parts ----------
    var C = {
      dark: toon(0x2E2840), trim: toon(0xFFF8EC), glass: toon(0xBEEBFF, { e: 0x6FB8E6, ei: 0.15 }),
      concrete: toon(0xD6D0C6), asphalt: toon(0x9198AA), grass: toon(0x7BD36A), leaf: toon(0x5CC25A), leaf2: toon(0x86DA6A), trunk: toon(0x9A6B45),
      gold: toon(0xFFC94D), red: toon(0xF2584C), metal: toon(0xBFC8D8), wood: toon(0xC48A57), white: toon(0xFFFFFF), cream: toon(0xF4EBDC)
    };
    function bush(g, x, z, s) {
      var b = G(); b.position.set(x, 0, z);
      at(b, sph(0.17 * s, C.leaf), 0, 0.12 * s, 0); at(b, sph(0.13 * s, C.leaf2), 0.12 * s, 0.1 * s, 0.05 * s); at(b, sph(0.12 * s, C.leaf), -0.11 * s, 0.08 * s, 0.06 * s);
      g.add(b); return b;
    }
    function tree(g, x, z, s) {
      var t = G(); t.position.set(x, 0, z);
      at(t, cyl(0.045 * s, 0.06 * s, 0.4 * s, 10, C.trunk), 0, 0, 0);
      at(t, sph(0.24 * s, C.leaf), 0, 0.5 * s, 0); at(t, sph(0.18 * s, C.leaf2), 0.12 * s, 0.62 * s, 0.06 * s); at(t, sph(0.17 * s, C.leaf), -0.13 * s, 0.42 * s, 0.08 * s);
      g.add(t); return t;
    }
    function windowAt(g, x, y, z, w, h) {
      at(g, rb(w + 0.07, h + 0.07, 0.05, C.trim, 0.02), x, y - 0.035, z);
      at(g, rb(w, h, 0.05, C.glass, 0.015), x, y, z + 0.012);
      at(g, rb(0.025, h, 0.055, C.trim, 0.008), x, y, z + 0.016);
    }
    function puffSet(g, n, color, x, y, z) {
      var arr = [];
      for (var i = 0; i < n; i++) { var m = toon(color, { t: true, uniq: true }); var p = sph(0.13, m); p.castShadow = false; p.userData.dyn = true; at(g, p, x, y, z); arr.push({ m: p, mat: m, o: i / n }); }
      return { update: function (t, rate) { for (var i = 0; i < arr.length; i++) { var q = (t * rate + arr[i].o) % 1; arr[i].m.position.set(x + Math.sin(q * 5 + i) * 0.06 - q * 0.18, y + q * 0.9, z + q * 0.08); var s = 0.55 + q * 1.15; arr[i].m.scale.set(s, s, s); arr[i].mat.opacity = (1 - q) * sstep(0, 0.12, q); arr[i].m.visible = arr[i].mat.opacity > 0.25; } } };
    }
    var blockHex = ['#FF8A7A', '#7FB6FF', '#FFD86B', '#8EE3C4', '#C3A8FF'];
    var blockMats = blockHex.map(function (h) { return toon(parseInt(h.slice(1), 16)); });
    var shared = { tower: 0 };

    // ---------- buildings ----------
    function mkBash() {
      var g = G();
      var wall = toon(0x8EE3C4), wallD = toon(0x5DBF9E), roofM = toon(0xB9C2D2), door = toon(0x2D7F74);
      at(g, rb(1.58, 0.12, 1.2, wallD, 0.04), 0, 0, -0.12);
      at(g, rb(1.5, 0.8, 1.12, wall, 0.06, 0.98), 0, 0.08, -0.12);
      at(g, rb(1.6, 0.1, 1.22, C.trim, 0.04), 0, 0.86, -0.12);
      at(g, rb(1.42, 0.04, 1.04, roofM, 0.015), 0, 0.93, -0.12);
      windowAt(g, -0.27, 0.2, 0.44, 0.62, 0.3);
      at(g, rb(0.36, 0.52, 0.05, C.trim, 0.02), 0.43, 0.08, 0.44);
      at(g, rb(0.28, 0.46, 0.05, door, 0.02), 0.43, 0.1, 0.456);
      at(g, sph(0.025, C.gold), 0.51, 0.33, 0.49);
      var aw = tb(0.78, 0.04, 0.3, toon(0xffffff, { map: stripes('#3FBF8F', '#FFF8EC', 8, true).tex })); aw.position.set(-0.27, 0.56, 0.58); aw.rotation.x = 0.42; g.add(aw);
      var sign = signPlane('BASH WEB', 0.98, 0.2, '#FFC94D', '#2A1F33'); sign.position.set(0, 0.76, 0.465); g.add(sign);
      var mon = G(); mon.position.set(-0.05, 0.95, -0.3); g.add(mon);
      at(mon, rb(0.4, 0.08, 0.32, C.dark, 0.03), 0, 0, 0);
      at(mon, rb(0.16, 0.12, 0.12, C.dark, 0.03), 0, 0.07, 0);
      at(mon, rb(1.14, 0.82, 0.62, C.cream, 0.14, 0.94), 0, 0.17, -0.02);
      at(mon, rb(0.96, 0.64, 0.04, C.dark, 0.07), 0, 0.26, 0.28);
      at(mon, rb(0.3, 0.06, 0.04, toon(0xD9CDB8), 0.02), 0.28, 0.2, 0.3);
      at(mon, sph(0.025, toon(0x3FD69A, { e: 0x3FD69A, ei: 0.8 })), 0.42, 0.23, 0.3);
      var script = [['$ ', 'ls'], ['', 'app/  tests/  todo.md'], ['$ ', 'bun run dev'], ['', 'listening on :3000'], ['$ ', 'grep -c TODO app.ts'], ['', '3'], ['$ ', 'cat todo.md | wc -l'], ['', '7']];
      var st = { line: 0, ch: 0, acc: 0, rows: [], flash: 0, blink: 0 };
      var scr = tex(320, 224, function (ctx, w, h) {
        ctx.fillStyle = '#123A2E'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(63,214,154,' + (0.08 + st.flash * 0.3) + ')'; ctx.fillRect(0, 0, w, h);
        ctx.font = '600 19px ' + MONO; ctx.textBaseline = 'top';
        var rows = st.rows.slice(-6);
        for (var i = 0; i < rows.length; i++) { ctx.fillStyle = rows[i].out ? '#B4F5D6' : '#5CF0B0'; ctx.fillText(rows[i].text, 16, 16 + i * 32); }
        if (st.blink < 0.5) { var last = rows[rows.length - 1]; var tw = last ? ctx.measureText(last.text).width : 0; ctx.fillStyle = '#5CF0B0'; ctx.fillRect(18 + tw, 16 + Math.max(0, rows.length - 1) * 32, 11, 22); }
        var gr = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, w * 0.7); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.35)'); ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
      });
      var sg = new PlaneGeometry(0.86, 0.54); disposables.push(sg);
      var sp = new Mesh(sg, basic(0xffffff, { map: scr.tex, t: false })); sp.position.set(0, 0.58, 0.302); mon.add(sp);
      at(g, rb(0.3, 0.18, 0.24, C.metal, 0.03), 0.55, 0.95, -0.5);
      at(g, cyl(0.08, 0.08, 0.02, 16, C.dark), 0.55, 1.13, -0.5);
      at(g, cyl(0.012, 0.012, 0.5, 6, C.dark), -0.62, 0.95, -0.55);
      at(g, sph(0.035, C.red), -0.62, 1.46, -0.55);
      bush(g, -0.72, 0.52, 1); bush(g, 0.74, 0.5, 0.8);
      return {
        g: g, h: 1.95,
        update: function (t, dt) {
          st.acc += dt; st.blink = (t * 1.6) % 1; st.flash = Math.max(0, st.flash - dt * 2);
          var cur = script[st.line % script.length];
          if (st.rows.length === 0 || st.rows[st.rows.length - 1].done) st.rows.push({ text: cur[0], out: !cur[0], done: false });
          var row = st.rows[st.rows.length - 1];
          if (row.out) { if (st.acc > 0.55) { row.text = cur[1]; row.done = true; st.line++; st.acc = 0; } }
          else if (st.acc > 0.075) { st.acc = 0; if (st.ch < cur[1].length) { st.ch++; row.text = cur[0] + cur[1].slice(0, st.ch); } else { row.done = true; st.ch = 0; st.line++; } }
          if (st.rows.length > 12) st.rows.splice(0, 6);
          scr.redraw();
        },
        pulse: function () { st.flash = 1; }
      };
    }

    function mkBun() {
      var g = G();
      var wall = toon(0xFFB3C6), dome = toon(0xE8A658), glaze = toon(0xF7CB82), brick = toon(0xCF5B43), seed = toon(0xFFF3D6);
      at(g, rb(1.38, 0.1, 1.16, C.concrete, 0.04), 0, 0, -0.12);
      at(g, rb(1.28, 0.64, 1.06, wall, 0.06, 0.97), 0, 0.08, -0.12);
      at(g, rb(1.34, 0.1, 1.12, C.trim, 0.04), 0, 0.7, -0.12);
      var dm = sph(1, dome, true); dm.scale.set(0.66, 0.44, 0.56); at(g, dm, 0, 0.78, -0.12);
      var gz = sph(1, glaze, true); gz.scale.set(0.4, 0.1, 0.3); at(g, gz, -0.12, 1.12, -0.18);
      for (var i = 0; i < 9; i++) {
        var a = i / 9 * Math.PI * 2 + 0.3, el = 0.55 + hash(i, 2) * 0.3;
        var sx = Math.cos(a) * Math.cos(el), sy = Math.sin(el), sz = Math.sin(a) * Math.cos(el);
        var sd = sph(0.03, seed); sd.scale.set(1.4, 0.6, 0.8); sd.position.set(sx * 0.66, 0.78 + sy * 0.44, -0.12 + sz * 0.56); sd.rotation.y = a; g.add(sd);
      }
      at(g, rb(0.22, 0.66, 0.22, brick, 0.03), 0.45, 0.6, -0.45);
      at(g, rb(0.28, 0.08, 0.28, C.dark, 0.03), 0.45, 1.26, -0.45);
      var ring = cyl(0.24, 0.24, 0.05, 24, C.dark); ring.rotation.x = Math.PI / 2; at(g, ring, -0.24, 0.36, 0.43);
      var glow = toon(0xFF9F43, { e: 0xFFB13B, ei: 0.7, uniq: true });
      var gl = cyl(0.18, 0.18, 0.06, 24, glow); gl.rotation.x = Math.PI / 2; gl.userData.dyn = true; at(g, gl, -0.24, 0.36, 0.44);
      at(g, rb(0.36, 0.52, 0.05, C.trim, 0.02), 0.34, 0.08, 0.42);
      at(g, rb(0.28, 0.46, 0.05, toon(0x8A4B2F), 0.02), 0.34, 0.1, 0.436);
      var sign = signPlane('bun', 0.5, 0.17, '#FFF3E0', '#8A4B2F', { scale: 0.7 }); sign.position.set(0.0, 0.745, 0.47); g.add(sign);
      at(g, rb(0.22, 0.18, 0.22, C.wood, 0.03), -0.62, 0, 0.52); at(g, rb(0.2, 0.16, 0.2, C.wood, 0.03), -0.4, 0, 0.62, 0.3);
      bush(g, 0.72, 0.5, 0.85);
      var puffs = puffSet(g, 4, 0xFFFFFF, 0.45, 1.36, -0.45);
      var heat = 0;
      return {
        g: g, h: 1.4,
        update: function (t, dt) { heat = Math.max(0, heat - dt * 1.5); glow.emissiveIntensity = 0.55 + 0.25 * Math.sin(t * 7) + heat; puffs.update(t, 0.45 + heat * 0.5); },
        pulse: function () { heat = 1; }
      };
    }

    function mkAgent() {
      var g = G();
      var latTex = tex(64, 256, function (ctx, w, h) { ctx.fillStyle = '#FFC93D'; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = '#B9861A'; ctx.lineWidth = 5; for (var y = 0; y < h; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y + 64); ctx.moveTo(w, y); ctx.lineTo(0, y + 64); ctx.stroke(); } ctx.strokeRect(2, 0, w - 4, h); }, true);
      var lattice = toon(0xffffff, { map: latTex.tex });
      at(g, rb(1.68, 0.05, 1.68, toon(0xD9B58A), 0.03), 0, 0, 0);
      var P = new Vector3(0.3, 0, 0.02), S = new Vector3(-0.58, 0, 0.5), Cc = new Vector3(-0.58, 0, -0.58);
      at(g, rb(0.9, 0.1, 0.8, C.concrete, 0.03), P.x, 0.05, P.z);
      for (var i = 0; i < 4; i++) { var sx = i % 2 ? 0.42 : -0.42, sz = i < 2 ? 0.37 : -0.37; at(g, cyl(0.018, 0.018, 1.3, 6, C.metal), P.x + sx, 0.1, P.z + sz); }
      var floors = [];
      for (var f = 0; f < 4; f++) {
        var fl = dyn(G()); fl.position.set(P.x, 0.15 + f * 0.27, P.z); g.add(fl);
        at(fl, rb(0.8, 0.27, 0.7, blockMats[f], 0.03), 0, 0, 0);
        at(fl, rb(0.82, 0.08, 0.72, C.glass, 0.02), 0, 0.12, 0);
        at(fl, rb(0.84, 0.03, 0.74, C.trim, 0.01), 0, 0.245, 0);
        fl.visible = false; floors.push(fl);
      }
      at(g, rb(0.36, 0.1, 0.36, C.concrete, 0.03), Cc.x, 0.05, Cc.z);
      var mast = tb(0.15, 2.0, 0.15, lattice); mast.position.set(Cc.x, 0.15, Cc.z); g.add(mast);
      var jib = dyn(G()); jib.position.set(Cc.x, 2.15, Cc.z); g.add(jib);
      var jb = tb(0.12, 0.12, 1.5, lattice); jb.position.set(0, 0, 0.5); jib.add(jb);
      at(jib, rb(0.3, 0.22, 0.26, C.concrete, 0.04), 0, -0.04, -0.32);
      at(jib, rb(0.26, 0.24, 0.26, C.white, 0.05), 0.0, -0.3, 0.08);
      at(jib, rb(0.2, 0.1, 0.03, C.glass, 0.01), 0, -0.2, 0.215);
      at(jib, cone(0.1, 0.3, 4, C.gold), 0, 0.06, 0);
      var trolley = G(); jib.add(trolley);
      at(trolley, rb(0.16, 0.06, 0.16, C.dark, 0.02), 0, -0.1, 0);
      var cg = new CylinderGeometry(0.012, 0.012, 1, 6); cg.translate(0, -0.5, 0); disposables.push(cg);
      var cable = new Mesh(cg, C.dark); cable.position.y = -0.1; trolley.add(cable);
      var hook = G(); trolley.add(hook);
      at(hook, rb(0.12, 0.08, 0.12, toon(0xFF6B57), 0.03), 0, -0.04, 0);
      var carried = rb(0.8, 0.27, 0.7, blockMats[0], 0.03); hook.add(carried); carried.position.y = -0.33;
      at(g, rb(0.5, 0.06, 0.44, C.wood, 0.02), S.x, 0, S.z);
      at(g, rb(0.42, 0.16, 0.36, blockMats[4], 0.03), S.x, 0.06, S.z);
      var coneM = toon(0xFF8A3D);
      [[0.72, 0.68], [-0.05, 0.72]].forEach(function (q) { at(g, cone(0.07, 0.2, 14, coneM), q[0], 0.02, q[1]); at(g, cyl(0.055, 0.06, 0.03, 14, C.white), q[0], 0.09, q[1]); at(g, rb(0.18, 0.025, 0.18, coneM, 0.01), q[0], 0, q[1]); });
      var period = 3.0, lastCycle = -1, n = 0, ship = 0, placed = false, ac = 0, aSpeed = 1;
      function aim(v) { var dx = v.x - Cc.x, dz = v.z - Cc.z; return { a: Math.atan2(dx, dz), d: Math.sqrt(dx * dx + dz * dz) }; }
      var aS = aim(S), aP = aim(P);
      function angLerp(a, b, t) { var d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; }
      return {
        g: g, h: 2.3,
        update: function (t0, dt) {
          aSpeed = lerp(aSpeed, 1, dt * 0.5); ac += dt * aSpeed; var t = ac;
          var cyc = Math.floor(t / period), ph = (t / period) % 1;
          if (cyc !== lastCycle) { lastCycle = cyc; if (n >= 4) { ship = 1; n = 0; shared.tower = 0; } }
          ship = Math.max(0, ship - dt * 1.4);
          var m = sstep(0.1, 0.42, ph) * (1 - sstep(0.58, 0.92, ph));
          jib.rotation.y = angLerp(aS.a, aP.a, m);
          trolley.position.z = lerp(aS.d, aP.d, m);
          var topY = 0.15 + n * 0.27 + 0.27, hiY = 1.85, pickY = 0.49, hy;
          if (ph < 0.1) hy = lerp(hiY, pickY + 0.33, Math.sin(ph / 0.1 * Math.PI));
          else if (ph > 0.42 && ph < 0.58) hy = lerp(hiY, topY + 0.33, Math.sin((ph - 0.42) / 0.16 * Math.PI));
          else hy = hiY;
          var len = 2.05 - hy;
          cable.scale.y = Math.max(0.05, len);
          hook.position.y = -0.1 - len;
          carried.material = blockMats[n % 5];
          if (ph >= 0.5 && !placed && n < 4) { n++; placed = true; shared.tower = n; }
          if (ph < 0.5) placed = false;
          carried.visible = ph > 0.06 && ph < 0.5 && n < 4;
          for (var i = 0; i < floors.length; i++) { var vis = i < n; floors[i].visible = vis || ship > 0; var s = vis ? 1 : ship; floors[i].scale.set(s, s, s); }
        },
        pulse: function () { aSpeed = 3.5; }
      };
    }

    function mkPreview() {
      var g = G();
      at(g, rb(1.6, 0.05, 0.9, C.grass, 0.03), 0, 0, -0.2);
      at(g, rb(0.11, 1.05, 0.11, C.wood, 0.02), -0.55, 0, -0.22); at(g, rb(0.11, 1.05, 0.11, C.wood, 0.02), 0.55, 0, -0.22);
      at(g, rb(1.24, 0.07, 0.07, C.wood, 0.02), 0, 0.5, -0.22);
      at(g, rb(1.76, 1.12, 0.13, C.trim, 0.05), 0, 0.95, -0.22);
      at(g, rb(1.84, 0.08, 0.2, toon(0xFF8A7A), 0.03), 0, 2.06, -0.22);
      [-0.55, 0.55].forEach(function (x) { at(g, rb(0.04, 0.2, 0.04, C.dark, 0.01), x, 2.12, -0.15); var hd = cyl(0.07, 0.05, 0.12, 14, C.dark); hd.rotation.x = 1.0; at(g, hd, x, 2.3, -0.08); });
      var shown = -1, flash = 0;
      var scr = tex(384, 252, function (ctx, w, h) {
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#2E2840'; ctx.fillRect(0, 0, w, 34);
        ['#FF6B57', '#FFD23F', '#3FD69A'].forEach(function (c, i) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(18 + i * 18, 17, 5.5, 0, 7); ctx.fill(); });
        ctx.fillStyle = '#4A4466'; rr(ctx, 84, 8, 200, 18, 9); ctx.fill();
        ctx.fillStyle = '#E2DEFF'; ctx.font = '500 11px ' + MONO; ctx.textBaseline = 'middle'; ctx.fillText('localhost:3000', 96, 17.5);
        ctx.fillStyle = '#2A1F33'; ctx.font = '700 26px ' + FONT; ctx.textBaseline = 'alphabetic'; ctx.fillText('my-app', 20, 74);
        ctx.fillStyle = '#B5B0CC'; ctx.fillRect(20, 86, 140, 7); ctx.fillRect(20, 100, 96, 7);
        var n = Math.max(0, shown);
        for (var j = 0; j < 4; j++) {
          var x = 20 + j * 88, y = 124;
          if (j < n) { ctx.fillStyle = blockHex[j]; rr(ctx, x, y, 76, 104, 12); ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = '#2A1F33'; ctx.stroke(); ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillRect(x + 12, y + 76, 40, 7); }
          else { ctx.strokeStyle = '#D5D2E6'; ctx.lineWidth = 3; ctx.setLineDash([7, 6]); rr(ctx, x + 1.5, y + 1.5, 73, 101, 12); ctx.stroke(); ctx.setLineDash([]); }
        }
        if (flash > 0) { ctx.fillStyle = 'rgba(63,214,154,' + (flash * 0.35) + ')'; ctx.fillRect(0, 34, w, h - 34); }
        ctx.fillStyle = '#3FD69A'; ctx.beginPath(); ctx.arc(w - 20, 17, 5, 0, 7); ctx.fill();
      });
      var sg = new PlaneGeometry(1.62, 1.0); disposables.push(sg);
      var sp = new Mesh(sg, basic(0xffffff, { map: scr.tex, t: false })); sp.position.set(0, 1.51, -0.152); g.add(sp);
      bush(g, -0.7, 0.2, 1); bush(g, 0.1, 0.25, 0.8); bush(g, 0.72, 0.15, 0.9);
      return {
        g: g, h: 2.35,
        update: function (t, dt) { var f0 = flash; flash = Math.max(0, flash - dt * 2.5); if (shared.tower !== shown) { shown = shared.tower; flash = 1; } if (flash > 0 || f0 > 0) scr.redraw(); },
        pulse: function () { flash = 1; }
      };
    }

    function mkGame() {
      var g = G();
      var wall = toon(0x9C7DFF), pink = toon(0xFF7DB5), board = toon(0x34275A);
      at(g, rb(1.52, 0.1, 1.16, toon(0x6E5BB0), 0.04), 0, 0, -0.12);
      at(g, rb(1.44, 0.86, 1.08, wall, 0.06, 0.97), 0, 0.08, -0.12);
      at(g, rb(1.5, 0.1, 1.14, pink, 0.04), 0, 0.92, -0.12);
      at(g, rb(1.24, 0.36, 0.08, board, 0.04), 0, 0.5, 0.46);
      var sign = signPlane('ARCADE', 1.08, 0.26, '#34275A', '#FFE14D', { scale: 0.7, outline: '#FF4FA0' }); sign.position.set(0, 0.68, 0.505); g.add(sign);
      var bulbA = toon(0xFFF2A8, { e: 0xFFE14D, ei: 0.9, uniq: true }), bulbB = toon(0xFFF2A8, { e: 0xFFE14D, ei: 0.1, uniq: true });
      for (var i = 0; i < 14; i++) { var b = sph(0.028, i % 2 ? bulbA : bulbB); b.userData.dyn = true; at(g, b, -0.58 + i / 13 * 1.16, 0.86, 0.51); }
      for (var j = 0; j < 14; j++) { var b2 = sph(0.028, j % 2 ? bulbB : bulbA); b2.userData.dyn = true; at(g, b2, -0.58 + j / 13 * 1.16, 0.53, 0.51); }
      var neon = toon(0x5CF2FF, { e: 0x5CF2FF, ei: 0.7 });
      at(g, rb(0.44, 0.44, 0.04, neon, 0.03), 0, 0.06, 0.44);
      at(g, rb(0.36, 0.38, 0.05, C.dark, 0.02), 0, 0.08, 0.455);
      [-0.5, 0.5].forEach(function (x) { var w = cyl(0.1, 0.1, 0.04, 20, C.trim); w.rotation.x = Math.PI / 2; at(g, w, x, 0.3, 0.44); var w2 = cyl(0.075, 0.075, 0.05, 20, toon(0xFF9AD0, { e: 0xFF7DB5, ei: 0.4 })); w2.rotation.x = Math.PI / 2; at(g, w2, x, 0.3, 0.445); });
      at(g, rb(0.56, 0.14, 0.46, C.dark, 0.05), -0.18, 1.02, -0.28);
      var stick = dyn(G()); stick.position.set(-0.18, 1.14, -0.28); g.add(stick);
      at(stick, cyl(0.035, 0.035, 0.42, 10, C.metal), 0, 0, 0);
      at(stick, sph(0.14, toon(0xFF4A4A)), 0, 0.46, 0);
      at(g, cyl(0.085, 0.085, 0.07, 18, toon(0x5CF2FF)), 0.32, 1.02, -0.12);
      at(g, cyl(0.085, 0.085, 0.07, 18, toon(0xFFE14D)), 0.42, 1.02, -0.4);
      bush(g, -0.74, 0.5, 0.8);
      var speed = 1;
      return {
        g: g, h: 1.75,
        update: function (t, dt) { speed = lerp(speed, 1, dt); stick.rotation.z = Math.sin(t * 3 * speed) * 0.35; stick.rotation.x = Math.cos(t * 2.3 * speed) * 0.25; var on = Math.floor(t * 4 * speed) % 2; bulbA.emissiveIntensity = on ? 0.9 : 0.1; bulbB.emissiveIntensity = on ? 0.1 : 0.9; },
        pulse: function () { speed = 2.5; }
      };
    }

    function mkDb() {
      var g = G();
      var blue = toon(0x5B8CFF), blueL = toon(0x93B4FF), blueD = toon(0x3E63C9);
      at(g, rb(1.56, 0.06, 1.56, C.concrete, 0.03), 0, 0, 0);
      var cx = -0.18, cz = -0.2;
      at(g, cyl(0.58, 0.6, 0.12, 28, blueD), cx, 0.06, cz);
      var rings = [];
      for (var i = 0; i < 3; i++) {
        at(g, cyl(0.52, 0.52, 0.34, 28, blue), cx, 0.18 + i * 0.4, cz);
        if (i < 2) { var rm = toon(0x2E2840, { e: 0x3FD69A, ei: 0, uniq: true }); var rg = cyl(0.55, 0.55, 0.06, 28, rm); rg.userData.dyn = true; at(g, rg, cx, 0.52 + i * 0.4, cz); rings.push(rm); }
      }
      var cap = sph(0.52, blueL, true); cap.scale.set(1, 0.45, 1); at(g, cap, cx, 1.36, cz);
      at(g, cyl(0.06, 0.08, 0.16, 12, C.metal), cx, 1.55, cz);
      at(g, cyl(0.012, 0.012, 0.35, 6, C.dark), cx + 0.2, 1.48, cz);
      at(g, rb(0.18, 0.11, 0.015, C.gold, 0.01), cx + 0.29, 1.7, cz);
      var lx = cx - 0.12, lz = cz + 0.53;
      at(g, rb(0.025, 1.3, 0.025, C.trim, 0.008), lx - 0.09, 0.1, lz); at(g, rb(0.025, 1.3, 0.025, C.trim, 0.008), lx + 0.09, 0.1, lz);
      for (var k = 0; k < 9; k++) at(g, rb(0.18, 0.018, 0.02, C.trim, 0.006), lx, 0.2 + k * 0.13, lz);
      at(g, rb(0.48, 0.42, 0.42, C.white, 0.04), 0.5, 0.06, 0.38);
      at(g, rb(0.56, 0.09, 0.5, C.red, 0.03), 0.5, 0.48, 0.38);
      windowAt(g, 0.5, 0.18, 0.6, 0.18, 0.16);
      var pipe = cyl(0.045, 0.045, 0.42, 12, C.metal); pipe.rotation.z = Math.PI / 2; at(g, pipe, 0.47, 0.3, 0.12);
      bush(g, -0.72, 0.62, 0.8);
      var hit = 0;
      return {
        g: g, h: 1.85,
        update: function (t, dt) { hit = Math.max(0, hit - dt * 1.3); for (var i = 0; i < rings.length; i++) { var kk = clamp01(hit * 1.6 - i * 0.35); rings[i].emissiveIntensity = kk * 1.1 + 0.12 * (0.5 + 0.5 * Math.sin(t * 3 + i)); } },
        pulse: function () { hit = 1; }
      };
    }

    function mkTests() {
      var g = G();
      at(g, rb(1.66, 0.05, 1.5, C.asphalt, 0.03), 0, 0, 0);
      for (var d = 0; d < 3; d++) at(g, rb(0.22, 0.01, 0.05, C.trim, 0.004), -0.5 + d * 0.42, 0.05, 0.55);
      var bx = -0.42, bz = -0.28;
      at(g, rb(0.66, 0.74, 0.62, C.cream, 0.05, 0.97), bx, 0.05, bz);
      at(g, rb(0.8, 0.09, 0.76, toon(0x4C7DFF), 0.03), bx, 0.79, bz);
      windowAt(g, bx, 0.38, bz + 0.31, 0.38, 0.22);
      at(g, rb(0.78, 0.48, 0.09, C.dark, 0.04), bx, 0.88, bz - 0.08);
      var lamps = [], off = new Color(0x58607E), pass = new Color(0x3FD69A), fail = new Color(0xFF6B57);
      for (var r = 0; r < 2; r++) for (var c = 0; c < 3; c++) { var lm = toon(0x58607E, { e: 0x000000, uniq: true }); var l = cyl(0.075, 0.075, 0.04, 18, lm); l.rotation.x = Math.PI / 2; l.userData.dyn = true; at(g, l, bx - 0.22 + c * 0.22, 1.21 - r * 0.2, bz - 0.03); lamps.push(lm); }
      var tlx = 0.32, tlz = -0.42;
      at(g, cyl(0.035, 0.035, 1.05, 10, C.metal), tlx, 0.05, tlz);
      at(g, rb(0.22, 0.56, 0.2, C.dark, 0.05), tlx, 1.0, tlz);
      var tl = [0xFF5A4E, 0xFFC94D, 0x3FD69A].map(function (hx, i) { var m = toon(hx, { e: hx, ei: 0, uniq: true }); var l = cyl(0.07, 0.07, 0.04, 18, m); l.rotation.x = Math.PI / 2; l.userData.dyn = true; at(g, l, tlx, 1.44 - i * 0.17, tlz + 0.1); return m; });
      at(g, rb(0.14, 0.38, 0.14, C.gold, 0.03), 0.06, 0.05, 0.3);
      var arm = dyn(G()); arm.position.set(0.06, 0.36, 0.3); g.add(arm);
      var armM = tb(0.96, 0.07, 0.07, toon(0xffffff, { map: stripes('#FF5A4E', '#FFFFFF', 8, true).tex })); armM.position.set(0.5, -0.035, 0); arm.add(armM);
      var st = { i: 0, acc: 0, failed: false, hold: 0, states: [0, 0, 0, 0, 0, 0] };
      var armA = 0;
      return {
        g: g, h: 1.5,
        update: function (t, dt) {
          st.acc += dt;
          if (st.hold > 0) { st.hold -= dt; if (st.hold <= 0) { st.states = [0, 0, 0, 0, 0, 0]; st.i = 0; } }
          else if (st.acc > 0.32) {
            st.acc = 0;
            if (st.i < 6) { st.states[st.i] = (st.i === 4 && !st.failed) ? 2 : 1; if (st.states[st.i] === 2) { st.failed = true; st.hold = 0.9; } st.i++; }
            else { st.hold = 1.8; st.failed = false; }
          }
          var anyFail = st.states.indexOf(2) >= 0, allPass = st.i >= 6 && !anyFail;
          for (var i = 0; i < lamps.length; i++) { var s = st.states[i]; var col = s === 1 ? pass : s === 2 ? fail : off; lamps[i].color.copy(col); lamps[i].emissive.copy(col); lamps[i].emissiveIntensity = s ? 0.5 : 0; }
          tl[0].emissiveIntensity = (!allPass && !anyFail) ? 0.8 : 0; tl[1].emissiveIntensity = anyFail ? 0.9 : 0; tl[2].emissiveIntensity = allPass ? 0.9 : 0;
          armA = lerp(armA, allPass ? 1.25 : 0, dt * 4); arm.rotation.z = armA;
        },
        pulse: function () { st.states = [0, 0, 0, 0, 0, 0]; st.i = 0; st.hold = 0; st.failed = false; st.acc = 0; }
      };
    }

    function mkVideo() {
      var g = G();
      var wall = toon(0xF0645A);
      at(g, rb(1.52, 0.1, 1.14, toon(0xC9B9A6), 0.04), 0, 0, -0.12);
      at(g, rb(1.44, 1.0, 1.06, wall, 0.06, 0.97), 0, 0.08, -0.12);
      at(g, rb(1.5, 0.1, 1.12, C.cream, 0.04), 0, 1.07, -0.12);
      at(g, rb(1.32, 0.08, 0.42, C.gold, 0.03), 0, 0.6, 0.55);
      at(g, rb(1.12, 0.24, 0.06, C.cream, 0.03), 0, 0.68, 0.67);
      var sign = signPlane('NOW SHOWING', 1.04, 0.2, '#FFF6E0', '#C2362C', { scale: 0.62 }); sign.position.set(0, 0.8, 0.703); g.add(sign);
      var bA = toon(0xFFF2A8, { e: 0xFFE14D, ei: 0.9, uniq: true }), bB = toon(0xFFF2A8, { e: 0xFFE14D, ei: 0.1, uniq: true });
      for (var i = 0; i < 10; i++) { var b = sph(0.026, i % 2 ? bA : bB); b.userData.dyn = true; at(g, b, -0.6 + i * (1.2 / 9), 0.63, 0.77); }
      at(g, rb(0.48, 0.5, 0.05, C.gold, 0.02), 0, 0.08, 0.42);
      at(g, rb(0.4, 0.46, 0.05, C.dark, 0.02), 0, 0.08, 0.436);
      [[0x7FB6FF, -0.48], [0x8EE3C4, 0.48]].forEach(function (q) { at(g, rb(0.26, 0.36, 0.04, C.trim, 0.015), q[1], 0.14, 0.42); at(g, rb(0.2, 0.3, 0.04, toon(q[0]), 0.01), q[1], 0.17, 0.432); });
      at(g, rb(0.12, 0.34, 0.12, C.dark, 0.03), 0, 1.17, -0.32);
      var reel = dyn(G()); reel.position.set(0, 1.72, -0.28); g.add(reel);
      var disc = cyl(0.42, 0.42, 0.1, 30, toon(0x3A3550)); disc.rotation.x = Math.PI / 2; disc.position.z = -0.05; reel.add(disc);
      for (var h = 0; h < 5; h++) { var a = h / 5 * Math.PI * 2; var ho = cyl(0.09, 0.09, 0.11, 16, C.metal); ho.rotation.x = Math.PI / 2; ho.position.set(Math.cos(a) * 0.23, Math.sin(a) * 0.23, -0.055); reel.add(ho); }
      var hub = cyl(0.06, 0.06, 0.13, 12, C.gold); hub.rotation.x = Math.PI / 2; hub.position.z = -0.065; reel.add(hub);
      var spin = 1;
      return {
        g: g, h: 2.2,
        update: function (t, dt) { spin = lerp(spin, 1, dt); reel.rotation.z -= dt * 1.8 * spin; var on = Math.floor(t * 3.5) % 2; bA.emissiveIntensity = on ? 0.9 : 0.1; bB.emissiveIntensity = on ? 0.1 : 0.9; },
        pulse: function () { spin = 3.5; }
      };
    }

    function mkChart() {
      var g = G();
      var blue = toon(0x4C7DFF);
      at(g, rb(1.46, 0.1, 1.12, toon(0xD3D9E4), 0.04), 0, 0, -0.12);
      at(g, rb(1.38, 0.66, 1.04, toon(0xFAF6EE), 0.06, 0.98), 0, 0.08, -0.12);
      at(g, rb(1.44, 0.09, 1.1, blue, 0.04), 0, 0.72, -0.12);
      windowAt(g, -0.42, 0.3, 0.41, 0.3, 0.24); windowAt(g, 0.42, 0.3, 0.41, 0.3, 0.24);
      at(g, rb(0.3, 0.46, 0.05, blue, 0.02), 0, 0.08, 0.41);
      at(g, rb(1.2, 0.05, 0.4, C.metal, 0.02), 0, 0.81, -0.2);
      var bars = [], cols = [toon(0x7FB6FF), toon(0x8EE3C4), toon(0xFFD86B), toon(0xFF8A7A)];
      for (var i = 0; i < 4; i++) { var b = rb(0.2, 1, 0.2, cols[i], 0.04); b.userData.dyn = true; at(g, b, -0.42 + i * 0.28, 0.86, -0.2); bars.push(b); }
      var dish = sph(0.2, C.white, true); dish.rotation.x = Math.PI * 0.75; dish.scale.set(1, 0.45, 1); at(g, dish, 0.5, 1.02, 0.18);
      at(g, cyl(0.025, 0.03, 0.2, 8, C.metal), 0.5, 0.81, 0.18);
      bush(g, -0.72, 0.52, 0.85); tree(g, 0.74, 0.55, 0.9);
      var kick = 0;
      return {
        g: g, h: 1.85,
        update: function (t, dt) { kick = Math.max(0, kick - dt); for (var i = 0; i < 4; i++) { bars[i].scale.y = 0.25 + 0.42 * (0.5 + 0.5 * Math.sin(t * (0.7 + i * 0.23) + i * 1.7)) + 0.25 * (0.5 + 0.5 * Math.sin(t * 0.31 + i)) + kick * 0.2; } },
        pulse: function () { kick = 1; }
      };
    }

    function gearGeo(teeth, rOut, rIn, depth, hole) {
      var s = new Shape(), n = teeth * 4;
      for (var i = 0; i <= n; i++) { var a = i / n * Math.PI * 2, q = i % 4, r = (q === 1 || q === 2) ? rOut : rIn; if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      var hp = new Path(); hp.absarc(0, 0, hole, 0, Math.PI * 2, true); s.holes.push(hp);
      var g = new ExtrudeGeometry(s, { depth: depth, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2, curveSegments: 12 });
      g.translate(0, 0, -depth / 2); g.computeVertexNormals(); disposables.push(g);
      return g;
    }
    function mkBuild() {
      var g = G();
      var brickTex = tex(256, 128, function (ctx, w, h) { ctx.fillStyle = '#E2704A'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#C95A38'; for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) { if (hash(x, y) > 0.55) { rr(ctx, x * 32 + (y % 2) * 16 + 3, y * 16 + 3, 26, 10, 3); ctx.fill(); } } }, true);
      brickTex.tex.repeat.set(2, 2);
      at(g, rb(1.58, 0.1, 1.18, toon(0xA9A39A), 0.04), 0, 0, -0.14);
      var body = tb(1.48, 0.64, 1.08, toon(0xffffff, { map: brickTex.tex })); body.position.set(0, 0.08, -0.14); g.add(body);
      at(g, rb(1.52, 0.07, 1.12, C.trim, 0.03), 0, 0.72, -0.14);
      var tri = new Shape(); tri.moveTo(0, 0); tri.lineTo(0.47, 0); tri.lineTo(0, 0.34); tri.lineTo(0, 0);
      var tg = new ExtrudeGeometry(tri, { depth: 1.0, bevelEnabled: false }); tg.translate(0, 0, -0.5); tg.computeVertexNormals(); disposables.push(tg);
      var slate = toon(0x7088B0);
      for (var i = 0; i < 3; i++) { var tm = mesh(tg, slate); tm.position.set(-0.72 + i * 0.48, 0.79, -0.14); g.add(tm); at(g, rb(0.03, 0.28, 0.96, C.glass, 0.01), -0.73 + i * 0.48, 0.79, -0.14); }
      at(g, cyl(0.12, 0.15, 1.15, 18, toon(0xB44E32)), 0.55, 0.72, -0.5);
      at(g, cyl(0.155, 0.155, 0.06, 18, C.white), 0.55, 1.5, -0.5); at(g, cyl(0.135, 0.135, 0.06, 18, C.white), 0.55, 1.72, -0.5);
      var big = mesh(gearGeo(10, 0.32, 0.26, 0.08, 0.06), C.gold); big.userData.dyn = true; at(g, big, -0.32, 0.4, 0.46);
      var small = mesh(gearGeo(7, 0.22, 0.17, 0.08, 0.045), toon(0xFF9F43)); small.userData.dyn = true; at(g, small, 0.12, 0.3, 0.47);
      var door = tb(0.36, 0.44, 0.04, toon(0xffffff, { map: stripes('#9AA5BD', '#7E8AA6', 10, false).tex })); door.position.set(0.5, 0.08, 0.41); g.add(door);
      var puffs = puffSet(g, 4, 0xD9DEE8, 0.55, 1.9, -0.5);
      bush(g, -0.74, 0.58, 0.8);
      var sp = 1;
      return {
        g: g, h: 1.85,
        update: function (t, dt) { sp = lerp(sp, 1, dt); big.rotation.z += dt * 0.9 * sp; small.rotation.z = -big.rotation.z * (10 / 7) + 0.2; puffs.update(t, 0.35 * sp); },
        pulse: function () { sp = 3; }
      };
    }

    function mkPackages() {
      var g = G();
      var tan = toon(0xF1C98E), card = toon(0xD9A567), tape = toon(0xF6E3BC);
      at(g, rb(1.54, 0.1, 1.16, C.concrete, 0.04), 0, 0, -0.16);
      at(g, rb(1.42, 0.62, 1.04, tan, 0.06), 0, 0.08, -0.16);
      var arcG = new CylinderGeometry(0.53, 0.53, 1.46, 26, 1, false, -Math.PI / 2, Math.PI); arcG.rotateZ(Math.PI / 2); arcG.deleteAttribute('uv'); disposables.push(arcG);
      at(g, mesh(arcG, toon(0xA7B7CF)), 0, 0.68, -0.16);
      var door = tb(0.62, 0.48, 0.04, toon(0xffffff, { map: stripes('#B9C3D6', '#98A4BC', 12, false).tex })); door.position.set(-0.22, 0.08, 0.37); g.add(door);
      var sign = signPlane('PACKAGES', 0.66, 0.15, '#2E2840', '#FFD86B'); sign.position.set(-0.22, 0.62, 0.385); g.add(sign);
      function crate(w, h, d) { var c = G(); at(c, rb(w, h, d, card, 0.03), 0, 0, 0); at(c, rb(w * 0.24, 0.015, d + 0.012, tape, 0.005), 0, h - 0.008, 0); return c; }
      at(g, rb(0.5, 0.05, 0.42, C.wood, 0.015), 0.5, 0, 0.52);
      at(g, crate(0.26, 0.22, 0.24), 0.38, 0.05, 0.52, 0.1);
      at(g, crate(0.22, 0.2, 0.22), 0.62, 0.05, 0.5, -0.2);
      var c3 = dyn(crate(0.2, 0.18, 0.2)); at(g, c3, 0.48, 0.27, 0.52, 0.3);
      bush(g, -0.76, 0.55, 0.8);
      var hop = 0;
      return {
        g: g, h: 1.3,
        update: function (t, dt) { hop = Math.max(0, hop - dt * 2); c3.position.y = 0.27 + (hop > 0 ? Math.sin((1 - hop) * Math.PI) * 0.35 : 0); c3.rotation.y = 0.3 + (hop > 0 ? (1 - hop) * Math.PI : 0); },
        pulse: function () { hop = 1; }
      };
    }

    // food
    function mkSyrup() {
      var g = G();
      // glossy maple syrup: amber gradient, darker at the walls, a painted shine arc + glint,
      // a slow light sweep, and ripple rings when poked
      var su = { uT: { value: 0 }, uWob: { value: 0 }, uDeep: { value: new Color(0x8F3405) }, uMid: { value: new Color(0xCF5F10) }, uLight: { value: new Color(0xF29A33) }, uShine: { value: new Color(0xFFF2D6) } };
      var sm = new ShaderMaterial({
        uniforms: su,
        vertexShader: 'varying vec3 vL; varying vec3 vW; varying vec3 vN; void main(){ vL = position; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: [
          'uniform float uT; uniform float uWob; uniform vec3 uDeep; uniform vec3 uMid; uniform vec3 uLight; uniform vec3 uShine;',
          'varying vec3 vL; varying vec3 vW; varying vec3 vN;',
          'void main(){',
          '  vec2 p = vL.xz;',
          '  float edge = max(abs(p.x), abs(p.y));',
          '  vec3 col = mix(uLight, uMid, smoothstep(0.05, 0.8, length(p)));',
          '  col = mix(col, uDeep, smoothstep(0.62, 0.97, edge));',
          '  vec3 V = normalize(cameraPosition - vW);',
          '  col += pow(1.0 - max(dot(normalize(vN), V), 0.0), 4.0) * 0.1;',
          '  float top = step(0.5, vN.y);',
          '  if (top < 0.5) col = uDeep;',
          '  vec2 q = p - vec2(0.1, 0.08) + vec2(sin(uT * 0.7), cos(uT * 0.5)) * 0.03;',
          '  float r = length(q); float ang = atan(q.y, q.x);',
          '  float arc = smoothstep(0.07, 0.025, abs(r - 0.52)) * smoothstep(0.35, 0.75, sin(ang + 2.4));',
          '  float glint = smoothstep(0.1, 0.065, length(p - vec2(-0.42, -0.5))) + smoothstep(0.055, 0.035, length(p - vec2(-0.26, -0.6)));',
          '  float ring = smoothstep(0.05, 0.0, abs(length(p) - (1.0 - uWob) * 1.25)) * uWob;',
          '  float sh = max(max(arc, glint), ring * 0.8);',
          '  col = mix(col, uShine, clamp(sh, 0.0, 1.0) * top);',
          '  gl_FragColor = vec4(col, 1.0);',
          '#include <colorspace_fragment>',
          '}'
        ].join('\n')
      });
      disposables.push(sm);
      var pool = dyn(rb(2.0, 0.4, 2.0, sm, 0.14)); g.add(pool);
      var drop = dyn(sph(0.1, toon(0xCF5F10))); drop.visible = false; g.add(drop);
      var wob = 0, base = 0;
      return {
        g: g, h: 0, food: 'syrup',
        set: function (lvl) {
          base = -0.41 + lvl * 0.4;
          pool.position.y = base + Math.sin((1 - wob) * 14) * 0.03 * wob;
          drop.visible = wob > 0.02; drop.position.set(0.1, base + 0.4 + Math.sin((1 - wob) * Math.PI) * 0.7, 0.1);
        },
        update: function (t, dt) { wob = Math.max(0, wob - dt * 1.1); su.uT.value = t; su.uWob.value = wob; },
        pulse: function () { wob = 1; }
      };
    }
    function mkBerries() {
      var g = G(), bm = toon(0x4656C4), bd = toon(0x26306E), bs = [], hop = 0;
      [[-0.4, 0.24, -0.3], [0.32, 0.24, -0.36], [0.0, 0.24, 0.16], [-0.1, 0.64, -0.14], [0.4, 0.24, 0.3]].forEach(function (q, i) {
        var b = dyn(G()); b.position.set(q[0], q[1], q[2]); b.userData.y0 = q[1]; bs.push(b);
        at(b, sph(0.26, bm), 0, 0, 0);
        for (var k = 0; k < 5; k++) { var a = k / 5 * Math.PI * 2; var pt = cone(0.035, 0.08, 4, bd); pt.position.set(Math.cos(a) * 0.05, 0.22, Math.sin(a) * 0.05); pt.rotation.set(Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8); b.add(pt); }
        b.rotation.set(hash(i, 1) * 0.6, hash(i, 2) * 3, hash(i, 4) * 0.5);
        g.add(b);
      });
      return { g: g, h: 0.9, food: 'berries', update: function (t, dt) { hop = Math.max(0, hop - dt * 1.1); for (var k = 0; k < bs.length; k++) { var u = clamp01((1 - hop) * 1.7 - k * 0.14); bs[k].position.y = bs[k].userData.y0 + (hop > 0 ? Math.sin(u * Math.PI) * 0.55 : 0); bs[k].rotation.z = hop > 0 ? u * Math.PI * 2 : bs[k].rotation.z; } }, pulse: function () { hop = 1; } };
    }
    function mkStrawberry() {
      var g = G();
      var pts = [[0.01, 0], [0.12, 0.06], [0.28, 0.3], [0.42, 0.66], [0.43, 0.86], [0.34, 1.0], [0.18, 1.07], [0.01, 1.08]].map(function (q) { return new Vector2(q[0], q[1]); });
      var lg = new LatheGeometry(pts, 24); lg.computeVertexNormals(); disposables.push(lg);
      var berry = dyn(G()); berry.position.set(0, 0.16, -0.05); berry.rotation.set(0.3, 0.4, -0.5); g.add(berry); var spin = 0;
      at(berry, mesh(lg, toon(0xF2405A)), 0, 0, 0);
      var seedM = toon(0xFFE58A);
      for (var i = 0; i < 22; i++) {
        var hy = 0.16 + hash(i, 7) * 0.78, a = hash(i, 9) * Math.PI * 2;
        var rad = hy < 0.3 ? lerp(0.12, 0.28, (hy - 0.06) / 0.24) : hy < 0.66 ? lerp(0.28, 0.42, (hy - 0.3) / 0.36) : lerp(0.43, 0.34, (hy - 0.66) / 0.34);
        var sd = sph(0.022, seedM); sd.scale.set(1, 1.5, 1); sd.position.set(Math.cos(a) * rad, hy, Math.sin(a) * rad); sd.castShadow = false; berry.add(sd);
      }
      var lf = toon(0x4DB25A);
      for (var j = 0; j < 6; j++) { var a2 = j / 6 * Math.PI * 2; var l = sph(0.14, lf); l.scale.set(1.3, 0.25, 0.55); l.position.set(Math.cos(a2) * 0.18, 1.06, Math.sin(a2) * 0.18); l.rotation.y = -a2; berry.add(l); }
      at(berry, cyl(0.03, 0.04, 0.16, 8, lf), 0, 1.06, 0);
      return { g: g, h: 1.1, food: 'strawberry', update: function (t, dt) { spin = Math.max(0, spin - dt * 1.2); berry.rotation.y = 0.4 + (1 - spin) * Math.PI * 2 * (spin > 0 ? 1 : 0); berry.position.y = 0.16 + Math.sin((1 - spin) * Math.PI) * 0.6 * (spin > 0 ? 1 : 0); }, pulse: function () { spin = 1; } };
    }

    var LAYOUT = [
      ['video', 'db', 'game', 'syrup'],
      ['chart', 'build', 'agent', 'preview'],
      ['tests', 'bun', 'bash', 'berries'],
      ['syrup', 'packages', 'strawberry', 'syrup']
    ];
    var INFO = {
      bash: { make: mkBash, card: 'bash-web', label: 'Bash Web', real: true, icon: 'term' },
      bun: { make: mkBun, card: 'bun', label: 'Bun', real: true, icon: 'run' },
      agent: { make: mkAgent, card: 'agent', label: 'coding agent', icon: 'spark' },
      preview: { make: mkPreview, card: 'preview', label: 'live preview', icon: 'window' },
      game: { make: mkGame, card: 'game-server', label: 'game server', icon: 'pad' },
      db: { make: mkDb, card: 'database', label: 'database', icon: 'db' },
      tests: { make: mkTests, card: 'tests', label: 'tests', icon: 'check' },
      video: { make: mkVideo, card: 'transcode', label: 'video job', icon: 'play' },
      chart: { make: mkChart, card: 'notebook', label: 'notebook', icon: 'bars' },
      build: { make: mkBuild, card: 'build', label: 'build', icon: 'gear' },
      packages: { make: mkPackages, card: 'packages', label: 'packages', icon: 'box' },
      syrup: { make: mkSyrup }, berries: { make: mkBerries }, strawberry: { make: mkStrawberry }
    };
    function drawIcon(ctx, kind, cx, cy, s) {
      ctx.save(); ctx.translate(cx, cy); ctx.strokeStyle = '#FFFFFF'; ctx.fillStyle = '#FFFFFF'; ctx.lineWidth = 7; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      var u = s / 2;
      if (kind === 'term') { rr(ctx, -u, -u * 0.75, 2 * u, 1.5 * u, 10); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-u * 0.55, -u * 0.25); ctx.lineTo(-u * 0.2, 0.05 * u); ctx.lineTo(-u * 0.55, u * 0.35); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, u * 0.35); ctx.lineTo(u * 0.5, u * 0.35); ctx.stroke(); }
      else if (kind === 'run') { ctx.beginPath(); ctx.moveTo(-u * 0.55, -u * 0.7); ctx.lineTo(u * 0.75, 0); ctx.lineTo(-u * 0.55, u * 0.7); ctx.closePath(); ctx.stroke(); }
      else if (kind === 'spark') { ctx.beginPath(); for (var i = 0; i < 8; i++) { var a = i / 8 * Math.PI * 2 - Math.PI / 2, r = i % 2 ? u * 0.32 : u; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.stroke(); }
      else if (kind === 'window') { rr(ctx, -u, -u * 0.75, 2 * u, 1.5 * u, 10); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-u, -u * 0.32); ctx.lineTo(u, -u * 0.32); ctx.stroke(); }
      else if (kind === 'pad') { rr(ctx, -u, -u * 0.5, 2 * u, u, u * 0.5); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-u * 0.55, 0); ctx.lineTo(-u * 0.15, 0); ctx.moveTo(-u * 0.35, -u * 0.2); ctx.lineTo(-u * 0.35, u * 0.2); ctx.stroke(); ctx.beginPath(); ctx.arc(u * 0.45, 0, 6, 0, 7); ctx.fill(); }
      else if (kind === 'db') { ctx.beginPath(); ctx.ellipse(0, -u * 0.6, u * 0.8, u * 0.28, 0, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-u * 0.8, -u * 0.6); ctx.lineTo(-u * 0.8, u * 0.6); ctx.ellipse(0, u * 0.6, u * 0.8, u * 0.28, 0, Math.PI, 0, true); ctx.lineTo(u * 0.8, -u * 0.6); ctx.stroke(); ctx.beginPath(); ctx.ellipse(0, 0, u * 0.8, u * 0.28, 0, 0, Math.PI); ctx.stroke(); }
      else if (kind === 'check') { ctx.beginPath(); ctx.moveTo(-u * 0.7, 0); ctx.lineTo(-u * 0.15, u * 0.55); ctx.lineTo(u * 0.75, -u * 0.55); ctx.stroke(); }
      else if (kind === 'play') { rr(ctx, -u, -u * 0.75, 2 * u, 1.5 * u, 10); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-u * 0.25, -u * 0.35); ctx.lineTo(u * 0.4, 0); ctx.lineTo(-u * 0.25, u * 0.35); ctx.closePath(); ctx.fill(); }
      else if (kind === 'bars') { ctx.beginPath(); ctx.moveTo(-u * 0.6, u * 0.7); ctx.lineTo(-u * 0.6, 0); ctx.moveTo(0, u * 0.7); ctx.lineTo(0, -u * 0.7); ctx.moveTo(u * 0.6, u * 0.7); ctx.lineTo(u * 0.6, -u * 0.25); ctx.stroke(); }
      else if (kind === 'gear') { ctx.beginPath(); for (var k = 0; k <= 32; k++) { var b = k / 32 * Math.PI * 2, rad = (k % 4 < 2) ? u : u * 0.72; ctx.lineTo(Math.cos(b) * rad, Math.sin(b) * rad); } ctx.closePath(); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, u * 0.28, 0, 7); ctx.stroke(); }
      else if (kind === 'box') { ctx.beginPath(); ctx.moveTo(0, -u); ctx.lineTo(u * 0.85, -u * 0.5); ctx.lineTo(u * 0.85, u * 0.5); ctx.lineTo(0, u); ctx.lineTo(-u * 0.85, u * 0.5); ctx.lineTo(-u * 0.85, -u * 0.5); ctx.closePath(); ctx.moveTo(-u * 0.85, -u * 0.5); ctx.lineTo(0, 0); ctx.lineTo(u * 0.85, -u * 0.5); ctx.moveTo(0, 0); ctx.lineTo(0, u); ctx.stroke(); }
      ctx.restore();
    }

    var cells = [], byKind = {};
    var cardGeo = new PlaneGeometry(1.84, 1.84); cardGeo.rotateX(-Math.PI / 2); disposables.push(cardGeo);
    var order = [];
    for (var r0 = 0; r0 < 4; r0++) for (var c0 = 0; c0 < 4; c0++) order.push({ r: r0, c: c0, d: Math.hypot(r0 - 1.7, c0 - 1.5) + hash(r0, c0) * 0.6 });
    order.sort(function (a, b) { return a.d - b.d; });
    var rank = {}; order.forEach(function (o, i) { rank[o.r + ',' + o.c] = i; });

    for (var rr0 = 0; rr0 < 4; rr0++) for (var cc0 = 0; cc0 < 4; cc0++) {
      (function (r, c) {
        var kind = LAYOUT[r][c], info = INFO[kind];
        var o = info.make();
        bake(o.g); outline(o.g);
        o.kind = kind; o.r = r; o.c = c; o.info = info; o.pulseV = 0; o.a = 0; o.dir = 1;
        o.g.position.set(cellX(c), 0, cellZ(r));
        o.g.rotation.y = o.food === 'syrup' ? 0 : AZ_FINAL + (hash(r, c) - 0.5) * 0.22;
        o.g.scale.setScalar(0.0001); o.g.visible = false;
        scene.add(o.g);
        o.start = 0.4 + 0.15 * rank[r + ',' + c] / 15;
        var program = !!info.card;
        var ct = tex(512, 512, function (ctx, W, H) {
          ctx.setTransform(2, 0, 0, 2, 0, 0); var w = 256, h = 256;
          ctx.clearRect(0, 0, w, h);
          if (program) {
            ctx.fillStyle = info.real ? 'rgba(243,180,81,0.22)' : 'rgba(255,255,255,0.10)'; rr(ctx, 14, 14, w - 28, h - 28, 26); ctx.fill();
            ctx.strokeStyle = info.real ? '#F7C564' : 'rgba(255,255,255,0.92)'; ctx.lineWidth = opts.compact ? 7 : 5; rr(ctx, 14, 14, w - 28, h - 28, 26); ctx.stroke();
            var cmp = !!opts.compact;
            drawIcon(ctx, info.icon, w / 2, h / 2 - (cmp ? 24 : 22), cmp ? 92 : 70);
            ctx.fillStyle = '#FFFFFF'; ctx.font = (cmp ? '700 31px ' : '600 23px ') + MONO; ctx.textAlign = 'center';
            var lbl = info.card; if (cmp) { var fs = 31; while (ctx.measureText(lbl).width > w - 52 && fs > 18) { fs -= 1; ctx.font = '700 ' + fs + 'px ' + MONO; } }
            ctx.fillText(lbl, w / 2, h - (cmp ? 38 : 46));
          } else { ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 4; ctx.setLineDash([14, 12]); rr(ctx, 16, 16, w - 32, h - 32, 26); ctx.stroke(); ctx.setLineDash([]); }
        });
        var cm = basic(0xffffff, { map: ct.tex, dw: false });
        var card = new Mesh(cardGeo, cm); card.position.set(cellX(c), 0.03, cellZ(r)); card.renderOrder = 3; scene.add(card); hideInNormals.push(card);
        o.card = card; o.cardMat = cm;
        if (program) {
          var lt = tex(512, 128, function (ctx, w, h) {
            ctx.clearRect(0, 0, w, h);
            ctx.font = '600 44px ' + FONT;
            var tw = ctx.measureText(info.label).width + (info.real ? 70 : 44), x = (w - tw) / 2;
            ctx.fillStyle = info.real ? '#FFC94D' : '#FFFFFF'; rr(ctx, x, 18, tw, 80, 40); ctx.fill();
            ctx.strokeStyle = '#2A1F33'; ctx.lineWidth = 7; rr(ctx, x, 18, tw, 80, 40); ctx.stroke();
            ctx.fillStyle = '#2A1F33'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
            var tx = x + 22;
            if (info.real) { ctx.beginPath(); ctx.arc(x + 32, 58, 9, 0, 7); ctx.fill(); tx = x + 50; }
            ctx.fillText(info.label, tx, 60);
          });
          var sm = new SpriteMaterial({ map: lt.tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
          disposables.push(sm);
          var sp = new Sprite(sm); sp.scale.set(opts.compact ? 3.5 : 2.7, opts.compact ? 0.875 : 0.675, 1); sp.renderOrder = 20; overlay.add(sp);
          o.tag = sp; o.tagMat = sm;
        }
        cells.push(o); byKind[kind] = byKind[kind] || o;
      })(rr0, cc0);
    }

    // butter on the centre crossing
    var butterG = G(); scene.add(butterG);
    at(butterG, rb(0.96, 0.3, 0.96, toon(0xFFE27F), 0.1), 0, 0, 0);
    var bh = sph(0.12, toon(0xFFF6CF)); bh.scale.set(2, 0.2, 1.2); at(butterG, bh, -0.18, 0.3, -0.2);
    butterG.rotation.y = 0.35; outline(butterG);
    var meltGeo = new CylinderGeometry(1, 1, 0.025, 28); disposables.push(meltGeo);
    var melt = mesh(meltGeo, toon(0xFFEA9E)); scene.add(melt);
    var butterA = 0, meltT = 0;

    // ---------- traffic: data travelling along the ridge tops ----------
    var FLOWS = [
      ['agent', 'bash', 0x3FD69A], ['bash', 'bun', 0x3FD69A], ['packages', 'bun', 0xFFC94D],
      ['bun', 'preview', 0xFF6B57], ['build', 'bun', 0xFFC94D], ['bun', 'tests', 0x3FD69A],
      ['game', 'db', 0x7FB6FF], ['db', 'game', 0x7FB6FF], ['db', 'chart', 0xC3A8FF], ['video', 'db', 0xFF6B57]
    ];
    var haloTex = tex(64, 64, function (ctx, w, h) { var gr = ctx.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h); });
    var beadGeo = new SphereGeometry(0.11, 16, 10); disposables.push(beadGeo);
    var wheelGeo = new CylinderGeometry(0.05, 0.05, 0.04, 14); wheelGeo.rotateZ(Math.PI / 2); disposables.push(wheelGeo);
    function van(hex) {
      var v = G(), body = toon(hex);
      at(v, rb(0.2, 0.15, 0.36, body, 0.04), 0, 0.045, -0.02);
      at(v, rb(0.19, 0.08, 0.1, C.glass, 0.02), 0, 0.12, 0.11);
      at(v, rb(0.14, 0.1, 0.14, toon(0xD9A567), 0.02), 0, 0.195, -0.06);
      [[-0.1, 0.1], [0.1, 0.1], [-0.1, -0.12], [0.1, -0.12]].forEach(function (q) { var w = mesh(wheelGeo, C.dark); w.position.set(q[0], 0.05, q[1]); v.add(w); });
      bake(v); outline(v);
      return v;
    }
    var flows = FLOWS.map(function (f, i) {
      var A = byKind[f[0]], B = byKind[f[1]];
      var bead = new Mesh(beadGeo, basic(f[2], { t: false })); scene.add(bead); hideInNormals.push(bead);
      var hm = new SpriteMaterial({ map: haloTex.tex, color: f[2], transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, opacity: 0.85 });
      disposables.push(hm);
      var halo = new Sprite(hm); halo.scale.set(0.75, 0.75, 1); overlay.add(halo);
      var car = van(f[2]); car.visible = false; scene.add(car);
      var ax = cellX(A.c), az = cellZ(A.r), bx = cellX(B.c), bz = cellZ(B.r);
      var sx = bx > ax ? 1 : bx < ax ? -1 : 1, lx = ax + sx * 1.25;
      var sz = az > bz ? 1 : -1, lz = bz + sz * 1.25;
      return { A: A, B: B, bead: bead, halo: halo, car: car, route: [[ax, az, 0], [lx, az, 1], [lx, lz, 1], [bx, lz, 1], [bx, bz, 0]], gap: 0.6 + hash(i, 5) * 1.8, phase: hash(i, 8) * 4, lastArr: -1 };
    });
    var tmpV = new Vector3(), tmpW = new Vector3();
    function routePoint(route, s, ph, out, carMode) {
      var pocketY = 0.03 + (carMode ? 0.06 : 0.4) * ph.ridge, ridgeY = 0.05 + RIDGE_H * ph.ridge + (carMode ? -0.04 : 0.09) * ph.ridge;
      var pts = route.map(function (q) { return [q[0], q[2] ? ridgeY : pocketY, q[1]]; });
      if (carMode) { pts[0] = [lerp(pts[0][0], pts[1][0], 0.45), pocketY, pts[0][2]]; var L4 = pts.length - 1; pts[L4] = [pts[L4][0], pocketY, lerp(pts[L4][2], pts[L4 - 1][2], 0.45)]; }
      var lens = [], total = 0;
      for (var i = 1; i < pts.length; i++) { var l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]); lens.push(l); total += l; }
      var d = clamp01(s) * total;
      for (var j = 0; j < lens.length; j++) {
        if (d <= lens[j] || j === lens.length - 1) {
          var t = lens[j] ? Math.min(1, d / lens[j]) : 0, a = pts[j], b = pts[j + 1];
          out.set(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t));
          if (!carMode && (j === 0 || j === lens.length - 1) && ph.ridge > 0) out.y += Math.sin(t * Math.PI) * 0.35 * ph.ridge;
          return total;
        }
        d -= lens[j];
      }
      return total;
    }

    // ---------- outline post-process ----------
    // One MSAA'd buffer holds view normal (rgb) and view depth / far (a). Edges come from the Laplacian
    // of inverse depth (zero on any flat surface, however steep) plus normal creases, so sloped
    // waffle walls and thin moving parts no longer sparkle.
    var rtColor = null, rtNormal = null;
    var normalMat = new ShaderMaterial({
      uniforms: { uFar: { value: 100 } },
      vertexShader: 'varying vec3 vN; varying float vZ; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vZ = -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform float uFar; varying vec3 vN; varying float vZ; void main(){ vec3 n = normalize(vN); gl_FragColor = vec4(n * 0.5 + 0.5, clamp(vZ / uFar, 0.0, 0.998)); }'
    });
    disposables.push(normalMat);
    var maskMat = new ShaderMaterial({
      uniforms: normalMat.uniforms,
      vertexShader: normalMat.vertexShader,
      fragmentShader: 'uniform float uFar; varying vec3 vN; varying float vZ; void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(vZ / uFar, 0.0, 0.998)); }'
    });
    disposables.push(maskMat);
    var normScene = new Scene();
    var waffleN = new Mesh(wGeo, normalMat), rimN = new Mesh(rimGeo, normalMat);
    normScene.add(waffleN); normScene.add(rimN);
    var post = new ShaderMaterial({
      uniforms: { tColor: { value: null }, tN: { value: null }, res: { value: new Vector2(1, 1) }, uAmt: { value: 0 }, thick: { value: 1 }, lineCol: { value: new Color(0x2A1F33) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: [
        'uniform sampler2D tColor; uniform sampler2D tN; uniform vec2 res; uniform float uAmt; uniform float thick; uniform vec3 lineCol; varying vec2 vUv;',
        'vec3 toSRGB(vec3 c){ c = max(c, vec3(0.0)); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c)); }',
        'float W(vec4 s){ return 1.0 / max(s.a, 0.0005); }',
        'bool BG(vec4 s){ return s.a > 0.997; }',
        'bool MK(vec4 s){ return s.r + s.g + s.b < 0.03; }',
        'float crease(vec4 a, vec3 n0){ if (BG(a) || MK(a)) return 0.0; vec3 n = normalize(a.xyz * 2.0 - 1.0); return 1.0 - dot(n, n0); }',
        'void main(){',
        '  vec4 c = texture2D(tColor, vUv);',
        '  vec2 px = thick / res;',
        '  vec4 s0 = texture2D(tN, vUv);',
        '  vec4 sL = texture2D(tN, vUv - vec2(px.x, 0.0)); vec4 sR = texture2D(tN, vUv + vec2(px.x, 0.0));',
        '  vec4 sD = texture2D(tN, vUv - vec2(0.0, px.y)); vec4 sU = texture2D(tN, vUv + vec2(0.0, px.y));',
        '  float e = 0.0;',
        '  if (!BG(s0) && !MK(s0)) {',
        '    float w0 = W(s0);',
        '    float lap = max(2.0 * w0 - W(sL) - W(sR), 2.0 * w0 - W(sU) - W(sD)) / w0;',
        '    vec3 n0 = normalize(s0.xyz * 2.0 - 1.0);',
        '    float ne = max(max(crease(sL, n0), crease(sR, n0)), max(crease(sU, n0), crease(sD, n0)));',
        '    e = max(smoothstep(0.02, 0.045, lap), smoothstep(0.55, 0.85, ne));',
        '  }',
        '  e *= uAmt;',
        '  vec3 rgb = c.a > 0.0001 ? c.rgb / c.a : vec3(0.0);',
        '  rgb = toSRGB(rgb);',
        '  rgb = mix(rgb, lineCol, e);',
        '  float a = max(c.a, e);',
        '  gl_FragColor = vec4(rgb * a, a);',
        '}'
      ].join('\n'),
      depthTest: false, depthWrite: false, transparent: true, blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor
    });
    disposables.push(post);
    var quadGeo = new PlaneGeometry(2, 2); disposables.push(quadGeo);
    var quad = new Mesh(quadGeo, post); quad.frustumCulled = false;
    var postScene = new Scene(); postScene.add(quad);
    var postCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    function makeTargets(w, h) {
      if (rtColor) { rtColor.dispose(); rtNormal.dispose(); }
      var ms = isGL2 ? 4 : 0;
      rtColor = new WebGLRenderTarget(w, h, { samples: ms, type: HalfFloatType });
      rtNormal = new WebGLRenderTarget(w, h, { samples: ms, type: HalfFloatType });
      post.uniforms.tColor.value = rtColor.texture;
      post.uniforms.tN.value = rtNormal.texture;
      post.uniforms.res.value.set(w, h);
      post.uniforms.thick.value = Math.max(1, Math.round(DPR));
    }

    // ---------- camera & layout ----------
    if (opts.layout && typeof opts.layout === 'object') { REG_INIT = opts.layout; }
    var state = { target: clamp01(opts.progress || 0), p: clamp01(opts.progress || 0), layout: (opts.layout && typeof opts.layout === 'object') ? 'custom' : (opts.layout || 'split'), labels: opts.labels !== false, mx: 0, my: 0, smx: 0, smy: 0, w: 0, h: 0, visible: true, bgKey: -1 };
    var REG = { split: { cx: 0.665, cy: 0.54, wf: 0.6, hf: 0.86 }, stack: { cx: 0.5, cy: 0.73, wf: 0.98, hf: 0.5 }, center: { cx: 0.5, cy: 0.53, wf: 0.94, hf: 0.9 }, phone: { cx: 0.455, cy: 0.5, wf: 0.8, hf: 0.86 } };
    if (REG_INIT) REG.custom = { cx: REG_INIT.cx, cy: REG_INIT.cy, wf: REG_INIT.wf, hf: REG_INIT.hf };
    var reg = Object.assign({}, REG[state.layout] || REG.split);
    // pre-settle the time-based pops for a page that opens mid-way
    cells.forEach(function (o) { if (state.p > o.start) o.a = 1; });
    if (state.p > 0.82) { butterA = 1; }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var w = Math.max(2, Math.round(rect.width)), h = Math.max(2, Math.round(rect.height));
      if (w === state.w && h === state.h) return;
      state.w = w; state.h = h;
      renderer.setSize(w, h, false);
    }
    function placeCamera(ph, t) {
      var R = REG[state.layout] || REG.split;
      reg.cx = lerp(reg.cx, R.cx, 0.08); reg.cy = lerp(reg.cy, R.cy, 0.08); reg.wf = lerp(reg.wf, R.wf, 0.08); reg.hf = lerp(reg.hf, R.hf, 0.08);
      var aspect = state.w / state.h;
      camera.aspect = aspect; camera.fov = 30;
      var tv = Math.tan(15 * DEG);
      var fitR = lerp(6.1, 6.2, ph.fit) * (state.layout === 'stack' ? lerp(1, 1.06, ph.fit) : 1);
      if (state.layout === 'custom') fitR *= lerp(1, 1.2, ph.fit);
      var dist = fitR / Math.min(tv * reg.hf, tv * aspect * reg.wf);
      var live = ph.lit;
      var el = lerp(EL_START, EL_FINAL, ph.cam) + state.smy * 0.05 * live;
      var az = lerp(0, AZ_FINAL, ph.cam) + Math.sin(t * 0.22) * 0.03 * live + state.smx * 0.12 * live;
      var ty = lerp(0, 0.15, ph.cam);
      camera.position.set(Math.cos(el) * Math.sin(az) * dist, ty + Math.sin(el) * dist, Math.cos(el) * Math.cos(az) * dist);
      camera.lookAt(0, ty, 0);
      camera.near = dist * 0.4; camera.far = dist * 2.4;
      camera.setViewOffset(state.w, state.h, -(reg.cx + (state.layout === 'custom' ? 0.02 * reg.wf * ph.fit : 0) - 0.5) * state.w, -(reg.cy - 0.5) * state.h, state.w, state.h);
      camera.updateProjectionMatrix();
      normalMat.uniforms.uFar.value = camera.far;
    }

    // ---------- interaction: every thing in the scene reacts to a click ----------
    var ray = new Raycaster(), ndc = new Vector2();
    var pickables = [];
    function own(root, owner) { root.traverse(function (x) { if (x.isMesh) { x.userData.owner = owner; pickables.push(x); } }); }
    cells.forEach(function (o) { own(o.g, { type: 'cell', o: o }); o.card.userData.owner = { type: 'cell', o: o }; pickables.push(o.card); });
    flows.forEach(function (fl) { own(fl.car, { type: 'van', fl: fl }); fl.bead.userData.owner = { type: 'van', fl: fl }; pickables.push(fl.bead); });
    own(butterG, { type: 'butter' });
    waffle.userData.owner = { type: 'waffle' }; rim.userData.owner = { type: 'waffle' }; pickables.push(waffle, rim);
    function shown(x) { for (; x; x = x.parent) { if (!x.visible) return false; } return true; }
    function pick(ev) {
      var rect = canvas.getBoundingClientRect();
      ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      var hits = ray.intersectObjects(pickables, false);
      for (var i = 0; i < hits.length; i++) { if (shown(hits[i].object)) return { owner: hits[i].object.userData.owner, point: hits[i].point }; }
      return null;
    }
    function kick(o, amp) { var prev = (o.pulseV || 0) > 0.5 ? (o.pAmp || 0) : 0; o.pAmp = Math.max(amp, prev); o.pulseV = 1; if (o.pulse) o.pulse(); }
    var butterP = 0;
    function ripple(point, amp) {
      cells.forEach(function (o) { var d = Math.hypot(o.g.position.x - point.x, o.g.position.z - point.z); o.delay = d / 8; o.pending = amp; });
    }
    function poke(h) {
      var ow = h.owner;
      if (ow.type === 'cell') kick(ow.o, 1);
      else if (ow.type === 'van') ow.fl.hop = 1;
      else if (ow.type === 'butter') { butterP = 1; ripple(h.point, 0.55); }
      else if (ow.type === 'waffle') ripple(h.point, 0.8);
    }
    var lastMove = null, moveDirty = false, lastPickT = 0;
    function onMove(ev) {
      var rect = canvas.getBoundingClientRect();
      state.mx = ((ev.clientX - rect.left) / rect.width) * 2 - 1; state.my = ((ev.clientY - rect.top) / rect.height) * 2 - 1;
      lastMove = { clientX: ev.clientX, clientY: ev.clientY }; moveDirty = true;
    }
    function onLeave() { state.mx = 0; state.my = 0; canvas.style.cursor = ''; moveDirty = false; }
    function onDown(ev) { if (opts.interactive === false) return; var h = pick(ev); if (h) poke(h); }
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerdown', onDown);
    var io = null;
    if ('IntersectionObserver' in window) { io = new IntersectionObserver(function (es) { state.visible = es[0] ? es[0].isIntersecting : true; }, { threshold: 0 }); io.observe(canvas); }

    // ---------- frame ----------
    var clock = new Clock(), elapsed = 0, raf = 0;
    function frame() {
      raf = requestAnimationFrame(frame);
      var dt = Math.min(0.05, clock.getDelta());
      if (!state.visible) return;
      elapsed += dt; var t = elapsed;
      resize();
      state.p = lerp(state.p, state.target, 1 - Math.exp(-dt * 7));
      if (Math.abs(state.p - state.target) < 0.0005) state.p = state.target;
      state.smx = lerp(state.smx, state.mx, 1 - Math.exp(-dt * 3)); state.smy = lerp(state.smy, state.my, 1 - Math.exp(-dt * 3));
      var p = state.p, ph = phases(p);
      if (moveDirty && opts.interactive !== false && elapsed - lastPickT > 0.08) { lastPickT = elapsed; moveDirty = false; canvas.style.cursor = pick(lastMove) ? 'pointer' : ''; }

      if (opts.background !== false) {
        var bk = Math.round(ph.world * 200);
        if (bk !== state.bgKey) { state.bgKey = bk; canvas.style.background = 'linear-gradient(180deg,' + mixRGB(SKY_TOP_A, SKY_TOP_B, ph.world) + ' 0%,' + mixRGB(SKY_BOT_A, SKY_BOT_B, ph.world) + ' 100%)'; }
      }
      U.uFlat.value = 1 - ph.lit;
      U.uEdge.value = 1.0;
      shapeWaffle(ph);
      lineMat.opacity = ph.lines; lines.visible = ph.lines > 0.01; lines.position.y = RIDGE_H * ph.ridge + 0.012;
      bpMat.uniforms.opacity.value = 1 - ph.world; blueprint.visible = ph.world < 0.999;
      shadowMat.opacity = 0.2 * ph.world; shadowCatcher.visible = ph.world > 0.01;
      blobMat.opacity = 0.85 * ph.world; blob.visible = ph.world > 0.01;
      blob.position.y = -SLAB * ph.slab - 0.004; shadowCatcher.position.y = blob.position.y - 0.001;

      for (var i = 0; i < cells.length; i++) {
        var o = cells[i];
        o.a = clamp01((p - o.start) / 0.13);
        var s = backOut(o.a);
        if (o.pending > 0) { o.delay -= dt; if (o.delay <= 0) { kick(o, o.pending); o.pending = 0; } }
        o.pulseV = Math.max(0, (o.pulseV || 0) - dt * 2.2);
        var pv = o.pulseV, amp = o.pAmp || 0;
        var bump = pv > 0 ? Math.sin((1 - pv) * Math.PI) * amp : 0;
        var sq = pv > 0 ? Math.sin((1 - pv) * Math.PI * 2) * 0.14 * amp * pv : 0;
        if (o.food === 'syrup') { o.g.scale.setScalar(1); o.set(ph.syrup); o.g.visible = ph.syrup > 0.001; }
        else {
          o.g.visible = s > 0.002;
          o.g.position.y = bump * 0.4;
          s *= 1.02; o.g.scale.set(Math.max(0.0001, s * (1 - sq * 0.5)), Math.max(0.0001, s * (1 + sq)), Math.max(0.0001, s * (1 - sq * 0.5)));
        }
        o.card.scale.setScalar(1 + bump * 0.12);
        if (o.g.visible && o.update) o.update(t + i * 0.37, dt);
        var cardK = o.food === 'syrup' ? ph.syrup : o.a;
        o.cardMat.opacity = 1 - sstep(0, 0.7, cardK);
        o.card.visible = o.cardMat.opacity > 0.01;
        if (o.tag) {
          o.tagMat.opacity = state.labels ? ph.labels * Math.min(1, s) : 0;
          o.tag.visible = o.tagMat.opacity > 0.01;
          o.tag.position.set(o.g.position.x, (o.h + 0.35) * s + o.g.position.y + Math.sin(t * 1.4 + i) * 0.04, o.g.position.z);
        }
      }

      // butter: drops on its own clock once the waffle is done; shrinks away cleanly on the way back
      var wantB = p > 0.8;
      butterA = clamp01((p - 0.8) / 0.1);
      if (butterA >= 1) meltT = Math.min(1, meltT + dt * 0.06); else if (!wantB) meltT = Math.max(0, meltT - dt * 2);
      butterG.visible = butterA > 0.001;
      var top = RIDGE_H * ph.ridge - 0.03;
      butterP = Math.max(0, butterP - dt * 2); var bq = butterP > 0 ? Math.sin((1 - butterP) * Math.PI * 3) * 0.25 * butterP : 0;
      butterG.position.set(0, top + (1 - bounceOut(butterA)) * 5 + (butterP > 0 ? Math.sin((1 - butterP) * Math.PI) * 0.5 : 0), 0); butterG.scale.set((1 + meltT * 0.06) * (1 + bq), (1 - meltT * 0.22) * (1 - bq), (1 + meltT * 0.06) * (1 + bq));
      melt.visible = meltT > 0.01 && butterG.visible;
      melt.position.set(0, top + 0.02, 0); melt.scale.set(0.45 + meltT * 0.55, 1, 0.45 + meltT * 0.55);

      // traffic
      var carMode = p > 0.55;
      for (var f = 0; f < flows.length; f++) {
        var fl = flows[f];
        var ready = p < 0.35 || (fl.A.a > 0.95 && fl.B.a > 0.95);
        var total = routePoint(fl.route, 0, ph, tmpV, carMode);
        var travel = carMode ? total / 1.7 : 1.25;
        var period = travel + fl.gap;
        var ct = (t + fl.phase) % period, s2 = ct / travel;
        var active = s2 <= 1 && ready && !(p > 0.35 && p < 0.5);
        var e2 = carMode ? s2 : (s2 < 0.5 ? 2 * s2 * s2 : 1 - Math.pow(-2 * s2 + 2, 2) / 2);
        fl.bead.visible = active && !carMode; fl.halo.visible = fl.bead.visible;
        fl.car.visible = active && carMode;
        if (!active) continue;
        routePoint(fl.route, e2, ph, tmpV, carMode);
        if (carMode) {
          routePoint(fl.route, Math.min(1, e2 + 0.01), ph, tmpW, true);
          fl.car.position.copy(tmpV);
          if (tmpW.distanceToSquared(tmpV) > 1e-8) fl.car.lookAt(tmpW);
          var cs = Math.min(sstep(0, 0.06, e2), 1 - sstep(0.94, 1, e2)) * 1.3;
          fl.car.scale.setScalar(Math.max(0.0001, cs));
          if (fl.hop > 0) { fl.hop = Math.max(0, fl.hop - dt * 1.8); fl.car.position.y += Math.sin((1 - fl.hop) * Math.PI) * 0.55; fl.car.rotateY((1 - fl.hop) * Math.PI * 2); }
        } else { fl.bead.position.copy(tmpV); fl.halo.position.copy(tmpV); }
        var cyc = Math.floor((t + fl.phase) / period);
        if (s2 > 0.97 && fl.lastArr !== cyc) { fl.lastArr = cyc; if (p > 0.6) kick(fl.B, 0.3); }
      }

      placeCamera(ph, t);
      // pass 1: colour
      renderer.setRenderTarget(null); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
      // pass 2: normals + depth, for the ink outlines
      post.uniforms.uAmt.value = 0;
      hullU.uThick.value = 0.024 * ph.lit; hullMat.visible = ph.lit > 0.02;
      if (false) {
        var vis = hideInNormals.map(function (x) { var v = x.visible; x.visible = false; return v; });
        scene.overrideMaterial = maskMat; hullMat.visible = false;
        rimN.position.copy(rim.position); rimN.scale.copy(rim.scale);
        var sm0 = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false;
        renderer.setRenderTarget(rtNormal); renderer.setClearColor(0x8080ff, 1.0); renderer.clear(); renderer.render(scene, camera);
        renderer.autoClear = false; renderer.render(normScene, camera); renderer.autoClear = true;
        renderer.shadowMap.autoUpdate = sm0;
        scene.overrideMaterial = null; hullMat.visible = true;
        hideInNormals.forEach(function (x, k) { x.visible = vis[k]; });
      }
      // pass 3: composite, then name tags on top
      renderer.autoClear = false; renderer.clearDepth(); renderer.render(overlay, camera); renderer.autoClear = true;
    }

    if (document.fonts && document.fonts.load) {
      Promise.all([document.fonts.load('600 44px "Fredoka"'), document.fonts.load('700 40px "Fredoka"'), document.fonts.load('600 23px "Martian Mono"')]).then(function () { textures.forEach(function (x) { x.redraw(); }); }).catch(function () {});
    }
    resize();
    frame();

    return {
      setProgress: function (p, now) { state.target = clamp01(p); if (now) state.p = state.target; },
      setLayout: function (l) { if (l && typeof l === 'object') { REG.custom = { cx: l.cx, cy: l.cy, wf: l.wf, hf: l.hf }; state.layout = 'custom'; } else if (REG[l]) state.layout = l; },
      setLabels: function (b) { state.labels = !!b; },
      getProgress: function () { return state.p; },
      destroy: function () {
        cancelAnimationFrame(raf);
        canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('pointerdown', onDown);
        if (io) io.disconnect();
        disposables.forEach(function (d) { try { d.dispose(); } catch (e) {} });
        if (rtColor) { rtColor.dispose(); rtNormal.dispose(); }
        renderer.dispose();
      }
    };
  }

  window.WaffleScene = { mount: mount, phases: phases };
})();

export {};
