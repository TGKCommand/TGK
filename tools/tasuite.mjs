// TGK Time Attack regression suite (v5.9).
// Usage (from the repo folder that holds TGK_TimeAttack_GL.html and models/):
//   npm i playwright three@0.128.0 && npx playwright install chromium
//   node tasuite.mjs            -> all checks
//   node tasuite.mjs models     -> GLB rig checks only (no browser, ~1 s)
// Exit code 0 = all pass, 1 = something failed.
import fs from 'fs'; import path from 'path'; import http from 'http';
const ROOT = process.cwd(), ONLY = process.argv[2] || 'all';
const CARS = ['s6', 'cc', 'tiguan', 'x5'];
let fails = 0; const row = (ok, name, info) => { if (!ok) fails++; console.log((ok ? ' PASS ' : ' FAIL ') + name.padEnd(42) + (info || '')); };

// ---- 1. model rig: four hub pivots per car, no SketchUp edge lines -------
console.log('\n[models]');
for (const c of CARS) {
  const f = path.join(ROOT, 'models', c + '.glb');
  if (!fs.existsSync(f)) { row(false, c + '.glb present'); continue; }
  const b = fs.readFileSync(f), len = b.readUInt32LE(12), j = JSON.parse(b.slice(20, 20 + len).toString());
  const wheels = j.nodes.filter(n => /^TGK_WHEEL_[NP]{2}$/.test(n.name || '')).length;
  const brakes = j.nodes.filter(n => /^TGK_BRAKE_/.test(n.name || '')).length;
  let lines = 0; for (const m of j.meshes) for (const p of m.primitives) if (p.mode === 0 || p.mode === 1 || p.mode === 3) lines++;
  row(wheels === 4, c + ': 4 TGK_WHEEL hub pivots', 'found ' + wheels + ', calipers ' + brakes);
  row(lines === 0, c + ': no line/point primitives', lines ? lines + ' found' : '');
}
if (ONLY === 'models') { console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS'); process.exit(fails ? 1 : 0); }

// ---- tiny static server + browser ----------------------------------------
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.glb': 'model/gltf-binary' };
const srv = http.createServer((q, r) => {
  const p = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r);
}).listen(0);
const port = srv.address().port;
const { chromium } = await import('playwright');
const three = path.join(ROOT, 'node_modules/three/build/three.min.js');
const gltf = path.join(ROOT, 'node_modules/three/examples/js/loaders/GLTFLoader.js');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function open(file) {
  const pg = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  if (fs.existsSync(three)) await pg.route(/three\.min\.js/, r => r.fulfill({ path: three }));
  if (fs.existsSync(gltf)) await pg.route(/GLTFLoader\.js/, r => r.fulfill({ path: gltf }));
  await pg.route(/supabase\.co/, r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await pg.goto(`http://localhost:${port}/${file}?post=0`); await pg.waitForTimeout(5000);
  return { pg, errs };
}

// ---- 2. boot both builds ---------------------------------------------------
console.log('\n[boot]');
for (const f of ['TGK_TimeAttack_GL.html', 'TGK_TimeAttack.html']) {
  if (!fs.existsSync(path.join(ROOT, f))) { row(false, f + ' present'); continue; }
  const { pg, errs } = await open(f);
  const v = await pg.evaluate(() => typeof TA_BUILD !== 'undefined' ? TA_BUILD.version : null);
  row(!!v && errs.length === 0, f + ' boots clean', 'v' + v + (errs.length ? '  ERR: ' + errs[0] : ''));
  await pg.close();
}

// ---- 3. GL wheel rig at runtime: 4 pivots, each holding spinning geometry --
const GL = 'TGK_TimeAttack_GL.html';
console.log('\n[wheels in game]');
for (const c of CARS) {
  const { pg, errs } = await open(GL);
  const r = await pg.evaluate(async (k) => {
    opts.car = k; taBuildCar(CAR_SPEC[k]);
    for (let i = 0; i < 60 && wheelPivots.length < 4; i++) await new Promise(z => setTimeout(z, 500));
    let tris = 0; wheelPivots.forEach(p => p.userData.spin.traverse(o => { if (o.isMesh) tris++; }));
    return { n: wheelPivots.length, parts: tris };
  }, c);
  row(r.n === 4 && r.parts >= 4 && errs.length === 0, c + ': 4 spinning wheel pivots', r.n + ' pivots, ' + r.parts + ' meshes');
  await pg.close();
}

// ---- 3b. course: the racing line must be drivable through every element ---
console.log('\n[course]');
{
  const { pg } = await open(GL);
  const R = await pg.evaluate(() => {
    const C = course; let badG = 0, badS = 0, offset = 0;
    for (const g of C.gates) { const l = C.segs[g.seg].line, c = (g.L.lat + g.R.lat) / 2; if (Math.abs(c) > 1) offset++; if (Math.abs(l - c) > g.half - 0.9) badG++; }
    for (const c of C.cones) if (c.kind === 'slalom' && (C.segs[c.seg].line - c.lat) * c.slalomSide < 1.0) badS++;
    return { gates: C.gates.length, badG, badS, offset, len: C.segs.length * SEG_LEN };
  });
  row(R.badG === 0, 'racing line clears every gate', R.gates + ' gates, ' + R.offset + ' offset');
  row(R.badS === 0, 'racing line takes every slalom cone on its side');
  row(R.len > 900 && R.len < 1600, 'course length in autocross range', R.len + ' m');
  await pg.close();
}

// ---- 4. physics vs real-world envelopes ------------------------------------
// Envelopes are deliberately a little wider than the published figures so the
// suite catches regressions, not noise.
const ENV = {
  s6:     { t60: [3.9, 4.8], brk: [95, 125], skid: [0.85, 1.00] },
  cc:     { t60: [6.6, 8.6], brk: [95, 130], skid: [0.82, 0.98] },
  tiguan: { t60: [5.2, 6.6], brk: [95, 130], skid: [0.80, 0.96] },
  x5:     { t60: [3.6, 4.6], brk: [95, 125], skid: [0.84, 0.98] },
};
console.log('\n[physics, street tyres, dry pavement]');
{
  const { pg } = await open(GL);
  const R = await pg.evaluate(() => {
    const out = {};
    /* the daily course carries its own weather; rain cuts grip to 80%.
       Benchmarks always run on a DRY lot so the envelopes mean something. */
    if (typeof taApplySun === 'function') taApplySun(1001);
    WX_GRIP = 1; out.wx = TA_WX;
    const pin = () => { const s0 = course.segs[0]; car.x = s0.x; car.z = s0.z; car.offTime = 0; };
    for (const k of ['s6', 'cc', 'tiguan', 'x5']) {
      const o = Object.assign({}, opts, { car: k, tyre: 'street', esc: 'on', box: 'auto', abs: 'on' });
      taCarReset(o); let t = 0, t60 = null;
      for (let i = 0; i < 240 * 15; i++) { car.thr = 1; car.brk = 0; car.steer = 0; pin(); taStep(PHYS_DT); t += PHYS_DT; if (car.v * 2.23694 >= 60) { t60 = t; break; } }
      taCarReset(o); for (let i = 0; i < 240 * 15; i++) { car.thr = 1; car.steer = 0; pin(); taStep(PHYS_DT); if (car.v * 2.23694 >= 61) break; }
      let d = 0, on = false; for (let i = 0; i < 240 * 10; i++) { car.thr = 0; car.brk = 1; car.steer = 0; if (!on && car.v * 2.23694 <= 60) on = true; pin(); taStep(PHYS_DT); if (on) d += Math.max(0, car.v) * PHYS_DT; if (car.v < 0.05) break; }
      taCarReset(o); for (let i = 0; i < 240 * 12; i++) { car.thr = 1; car.steer = 0; pin(); taStep(PHYS_DT); if (car.v >= 17) break; }
      let ay = 0; for (let i = 0; i < 240 * 8; i++) { car.steer = Math.min(1, i / (240 * 6)); car.brk = 0; car.thr = clamp((17 - car.v) * 0.6 + 0.25, 0, 1); pin(); taStep(PHYS_DT); if (i > 240) ay = Math.max(ay, Math.abs(car.ay) / 9.81); }
      out[k] = { t60, brk: d * 3.28084, skid: ay };
    }
    return out;
  });
  for (const k of CARS) {
    const e = ENV[k], m = R[k], inR = (v, a) => v != null && v >= a[0] && v <= a[1];
    row(inR(m.t60, e.t60), k + ': 0-60 mph', (m.t60 ? m.t60.toFixed(2) : 'never') + ' s  (want ' + e.t60.join('-') + ')');
    row(inR(m.brk, e.brk), k + ': 60-0 mph', m.brk.toFixed(0) + ' ft  (want ' + e.brk.join('-') + ')');
    row(inR(m.skid, e.skid), k + ': steady-state lateral grip', m.skid.toFixed(2) + ' g  (want ' + e.skid.join('-') + ')');
  }
  await pg.close();
}
await browser.close(); srv.close();
console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS'); process.exit(fails ? 1 : 0);
