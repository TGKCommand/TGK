// Offline wheel rigger: splits every car's wheels into four TGK_WHEEL_<c> nodes
// (parts that rotate with the road) and TGK_BRAKE_<c> nodes (calipers: steer,
// travel, never spin), pivot = hub centre. Removes LINES/POINTS primitives.
import { io, prims, bbox } from './lib.mjs';
import { prune, dedup, meshopt, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
const CFG = {
  cc:     { tire: /tire/i, spin: /tire|rim|brakedisk/i, stat: null },
  s6:     { tire: /TypeR23_tire/i, spin: /tire|wheel|brakedisc|steelwheel|Type2017/i, stat: /caliper/i, keep: /swaybar|tierod|hub_|strut|halfshaft|arm_|shock|spring|subframe/i,
            /* the donor wheel's centre cap carries a Honda 'H' - wrong on an Audi */
            drop: (L, off, ext, K) => /Type2017_mechanical/.test(L) && off < K.R * 0.10 && ext < K.R * 0.25 },
  tiguan: { tire: /Tire\.001|Tires/i, spin: /Rim|Tire\.001|shildik|brake_disk/i, stat: /^Brake\.001|Object_200/i },
  x5:     { tire: /_Tire|CSB_Tire/i, spin: /_Tire|_Rim|Rotor|Rims1/i, stat: /Caliper/i },
};
const key = process.argv[2], C = CFG[key];
const IO = await io();
const doc = await IO.read('/mnt/user-data/uploads/' + key + '.glb');
const root = doc.getRoot(), scene = root.getDefaultScene() || root.listScenes()[0];
let P = prims(doc);
// 1. drop non-triangle primitives (SketchUp edge outlines on the X5)
let dropped = 0;
for (const q of P) if (q.mode !== 4) { q.mesh.removePrimitive(q.p); dropped++; }
P = P.filter(q => q.mode === 4);
// whole-car bounds
let A = { mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] };
for (const q of P) { const b = bbox(q.W, q.I); for (let k = 0; k < 3; k++) { A.mn[k] = Math.min(A.mn[k], b.mn[k]); A.mx[k] = Math.max(A.mx[k], b.mx[k]); } }
const spanX = A.mx[0] - A.mn[0], spanZ = A.mx[2] - A.mn[2], H = A.mx[1] - A.mn[1];
const LAT = spanX < spanZ ? 0 : 2, LON = 2 - LAT;           // axle axis / length axis
const cLat = (A.mn[LAT] + A.mx[LAT]) / 2, cLon = (A.mn[LON] + A.mx[LON]) / 2;
const scale = Math.max(spanX, spanZ);
// 2. connected components (welded by position) per primitive
function comps(q) {
  const tol = scale * 2e-5, key = new Map(), canon = new Int32Array(q.W.length / 3);
  for (let i = 0; i < canon.length; i++) {
    const k = Math.round(q.W[i*3]/tol) + ',' + Math.round(q.W[i*3+1]/tol) + ',' + Math.round(q.W[i*3+2]/tol);
    if (!key.has(k)) key.set(k, i); canon[i] = key.get(k);
  }
  const par = new Int32Array(canon.length).map((_, i) => i);
  const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const T = q.I.length / 3;
  for (let t = 0; t < T; t++) { const a = f(canon[q.I[t*3]]), b = f(canon[q.I[t*3+1]]), c = f(canon[q.I[t*3+2]]); par[b] = a; par[f(c)] = a; }
  const g = new Map();
  for (let t = 0; t < T; t++) { const r = f(canon[q.I[t*3]]); if (!g.has(r)) g.set(r, []); g.get(r).push(t); }
  return [...g.values()].map(tris => {
    const vs = new Set(); for (const t of tris) for (let j = 0; j < 3; j++) vs.add(q.I[t*3+j]);
    const b = bbox(q.W, [...vs]); let m = [0, 0, 0]; for (const v of vs) for (let k = 0; k < 3; k++) m[k] += q.W[v*3+k];
    m = m.map(x => x / vs.size);
    return { q, tris, vs: [...vs], b, m };
  });
}
const label = q => { let n = q.node, s = q.mat; while (n) { s = n.getName() + '/' + s; n = n.listParents().find(p => p.propertyType === 'Node'); } return s; };
const ALL = []; for (const q of P) for (const c of comps(q)) ALL.push(c);
// 3. hubs from round, grounded tyre components
const corners = {};
for (const c of ALL) {
  if (!C.tire.test(label(c.q))) continue;
  const dia = c.b.s[1], lon = c.b.s[LON];
  if (dia < H * 0.25 || Math.abs(dia - lon) > dia * 0.08) continue;
  if (c.b.mn[1] - A.mn[1] > H * 0.06) continue;
  const id = (c.b.c[LON] > cLon ? 'P' : 'N') + (c.b.c[LAT] > cLat ? 'P' : 'N');
  const K = corners[id] || (corners[id] = { mn: [1e9,1e9,1e9], mx: [-1e9,-1e9,-1e9] });
  for (let k = 0; k < 3; k++) { K.mn[k] = Math.min(K.mn[k], c.b.mn[k]); K.mx[k] = Math.max(K.mx[k], c.b.mx[k]); }
}
const ids = Object.keys(corners).sort();
if (ids.length !== 4) throw new Error(key + ': found ' + ids.length + ' tyre corners');
for (const id of ids) { const K = corners[id]; K.hub = K.mn.map((a, k) => (a + K.mx[k]) / 2); K.R = (K.mx[1] - K.mn[1]) / 2;
  K.out = (K.hub[LAT] > cLat) ? 1 : -1; K.lo = K.mn[LAT]; K.hi = K.mx[LAT]; K.spin = []; K.stat = []; K.body = []; K.drop = []; }
// 4. membership + classification
function inCorner(c, K) {
  const inward = K.R * 0.55, lo = K.out > 0 ? K.lo - inward : K.lo - K.R * 0.04, hi = K.out > 0 ? K.hi + K.R * 0.04 : K.hi + inward;
  for (const v of c.vs) {
    const a = c.q.W[v*3+LAT]; if (a < lo || a > hi) return false;
    const dy = c.q.W[v*3+1] - K.hub[1], dl = c.q.W[v*3+LON] - K.hub[LON];
    if (dy*dy + dl*dl > (K.R * 1.02) ** 2) return false;
  }
  return true;
}
for (const id of ids) {
  const K = corners[id], mine = ALL.filter(c => inCorner(c, K));
  for (const c of mine) {
    const L = label(c.q), off = Math.hypot(c.m[1] - K.hub[1], c.m[LON] - K.hub[LON]);
    const ext = Math.max(c.b.s[1], c.b.s[LON]);
    let spin;
    if (C.drop && C.drop(L, off, ext, K)) { K.drop.push(c); continue; }
    if (C.stat && C.stat.test(L)) spin = false;
    else if (C.keep && C.keep.test(L)) spin = null;
    else if (C.spin && C.spin.test(L)) spin = true;
    else if (off < K.R * 0.12 || ext < K.R * 0.10) spin = true;
    else { // part of a rotational pattern? (lug nuts, separate spokes)
      const twins = mine.filter(o => o !== c && o.q === c.q && Math.abs(o.tris.length - c.tris.length) <= 1 &&
        Math.abs(Math.hypot(o.m[1] - K.hub[1], o.m[LON] - K.hub[LON]) - off) < K.R * 0.05);
      spin = twins.length >= 2 ? true : null;   /* unidentified: stays on the body */
    }
    if (spin === true) K.spin.push(c); else if (spin === false) K.stat.push(c); else K.body.push(c);
  }
  console.log(key, id, 'hub', K.hub.map(x => x.toFixed(3)).join(','), 'R', K.R.toFixed(3),
    'spin', K.spin.length, 'comps', K.spin.reduce((a, c) => a + c.tris.length, 0), 'tris | static', K.stat.length,
    '\n   STAT:', [...new Set(K.stat.map(c => label(c.q).split('/').slice(-3).join('/')))].join(' | '),
    '\n   SPIN:', [...new Set(K.spin.map(c => label(c.q).split('/').slice(-3).join('/')))].join(' | ').slice(0,400),
    '\n   BODY:', [...new Set(K.body.map(c => label(c.q).split('/').slice(-3).join('/')))].join(' | ').slice(0,400));
}
// 5. rebuild: cut triangles out of source primitives, emit pivot nodes
const taken = new Map();   // q -> Set(tri)
function emit(id, K, list, kind) {
  if (!list.length) return null;
  const node = doc.createNode('TGK_' + kind + '_' + id).setTranslation(K.hub);
  const mesh = doc.createMesh('TGK_' + kind + '_' + id); node.setMesh(mesh); scene.addChild(node);
  const byPrim = new Map();
  for (const c of list) { if (!byPrim.has(c.q)) byPrim.set(c.q, []); byPrim.get(c.q).push(...c.tris);
    if (!taken.has(c.q)) taken.set(c.q, new Set()); c.tris.forEach(t => taken.get(c.q).add(t)); }
  for (const [q, tris] of byPrim) {
    const M = q.node.getWorldMatrix();
    // normal matrix = inverse transpose of upper 3x3
    const a = [M[0],M[1],M[2],M[4],M[5],M[6],M[8],M[9],M[10]];
    const det = a[0]*(a[4]*a[8]-a[5]*a[7]) - a[3]*(a[1]*a[8]-a[2]*a[7]) + a[6]*(a[1]*a[5]-a[2]*a[4]);
    const inv = [(a[4]*a[8]-a[5]*a[7])/det, (a[2]*a[7]-a[1]*a[8])/det, (a[1]*a[5]-a[2]*a[4])/det,
                 (a[5]*a[6]-a[3]*a[8])/det, (a[0]*a[8]-a[2]*a[6])/det, (a[2]*a[3]-a[0]*a[5])/det,
                 (a[3]*a[7]-a[4]*a[6])/det, (a[1]*a[6]-a[0]*a[7])/det, (a[0]*a[4]-a[1]*a[3])/det];
    // inv is column-major inverse; normal = transpose(inv) * n  => n' [r] = sum_c inv[r*3+c]*n[c]
    const remap = new Map(), order = [];
    const idx = [];
    for (const t of tris) for (let j = 0; j < 3; j++) { const v = q.I[t*3+j]; if (!remap.has(v)) { remap.set(v, order.length); order.push(v); } idx.push(remap.get(v)); }
    /* orient each triangle so its winding agrees with its shading normals -
       some source parts (X5 rotors on mirrored corners) were wound inside-out,
       which a double-sided material then lights from the back: a black disc */
    const NA = q.p.getAttribute('NORMAL'), ne = [0,0,0];
    if (NA) for (let i = 0; i < idx.length; i += 3) {
      const a = order[idx[i]], b = order[idx[i+1]], c = order[idx[i+2]], W = q.W;
      const ux = W[b*3]-W[a*3], uy = W[b*3+1]-W[a*3+1], uz = W[b*3+2]-W[a*3+2];
      const vx = W[c*3]-W[a*3], vy = W[c*3+1]-W[a*3+1], vz = W[c*3+2]-W[a*3+2];
      const fx = uy*vz-uz*vy, fy = uz*vx-ux*vz, fz = ux*vy-uy*vx;
      let sx = 0, sy = 0, sz = 0;
      for (const v of [a, b, c]) { NA.getElement(v, ne);
        sx += inv[0]*ne[0]+inv[1]*ne[1]+inv[2]*ne[2]; sy += inv[3]*ne[0]+inv[4]*ne[1]+inv[5]*ne[2]; sz += inv[6]*ne[0]+inv[7]*ne[1]+inv[8]*ne[2]; }
      if (fx*sx + fy*sy + fz*sz < 0) { const t2 = idx[i+1]; idx[i+1] = idx[i+2]; idx[i+2] = t2; }
    } else if (det < 0) for (let i = 0; i < idx.length; i += 3) { const t2 = idx[i+1]; idx[i+1] = idx[i+2]; idx[i+2] = t2; }
    const prim = doc.createPrimitive().setMaterial(q.p.getMaterial());
    const buf = root.listBuffers()[0];
    for (const sem of q.p.listSemantics()) {
      if (sem === 'TANGENT') continue;
      const src = q.p.getAttribute(sem), el = src.getElementSize(), out = new Float32Array(order.length * el), e = new Array(el).fill(0);
      order.forEach((v, i) => {
        src.getElement(v, e);
        if (sem === 'POSITION') { out[i*3] = q.W[v*3] - K.hub[0]; out[i*3+1] = q.W[v*3+1] - K.hub[1]; out[i*3+2] = q.W[v*3+2] - K.hub[2]; }
        else if (sem === 'NORMAL') { let x = inv[0]*e[0]+inv[1]*e[1]+inv[2]*e[2], y = inv[3]*e[0]+inv[4]*e[1]+inv[5]*e[2], z = inv[6]*e[0]+inv[7]*e[1]+inv[8]*e[2];
          const l = Math.hypot(x, y, z) || 1; out[i*3] = x/l; out[i*3+1] = y/l; out[i*3+2] = z/l; }
        else for (let k = 0; k < el; k++) out[i*el+k] = e[k];
      });
      prim.setAttribute(sem, doc.createAccessor().setType(src.getType()).setArray(out).setBuffer(buf));
    }
    prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(order.length > 65535 ? new Uint32Array(idx) : new Uint16Array(idx)).setBuffer(buf));
    mesh.addPrimitive(prim);
  }
  return node;
}
for (const id of ids) { emit(id, corners[id], corners[id].spin, 'WHEEL'); emit(id, corners[id], corners[id].stat, 'BRAKE');
  for (const c of corners[id].drop) { if (!taken.has(c.q)) taken.set(c.q, new Set()); c.tris.forEach(t => taken.get(c.q).add(t)); } }
// S6: the replacement bonnet shipped on the black grille material - give it the body paint
if (key === 's6') { const body = root.listMaterials().find(m => m.getName() === 'rs6c8');
  for (const q of P) if (/hood_cus/.test(q.node.getName())) { q.p.setMaterial(body); console.log('s6 hood -> body paint'); } }
let removed = 0;
for (const [q, set] of taken) {
  const keep = []; const T = q.I.length / 3;
  for (let t = 0; t < T; t++) if (!set.has(t)) keep.push(q.I[t*3], q.I[t*3+1], q.I[t*3+2]); else removed++;
  if (!keep.length) { q.mesh.removePrimitive(q.p); continue; }
  const n = q.p.getAttribute('POSITION').getCount();
  q.p.setIndices(doc.createAccessor().setType('SCALAR').setArray(n > 65535 ? new Uint32Array(keep) : new Uint16Array(keep)).setBuffer(root.listBuffers()[0]));
}
console.log(key, 'lines dropped', dropped, 'tris moved', removed);
// 6. TGK number plates (replaces the asset vendors' watermark plates)
{
  const PLATES = './';   /* plate_us.png / plate_eu.png from plates.mjs */
  const fs = await import('fs');
  if (key === 'x5') {
    const m = root.listMaterials().find(m => m.getName() === 'material');
    if (m && m.getBaseColorTexture()) {
      m.getBaseColorTexture().setImage(fs.readFileSync(PLATES + 'plate_us.png')).setMimeType('image/png');
      m.setBaseColorFactor([1, 1, 1, 1]).setAlphaMode('OPAQUE'); m.setName('TGK_plate');
      console.log('x5 plate replaced');
    }
  }
  if (key === 'cc') {
    const Q = prims(doc), white = Q.filter(q => q.mat === 'Material__1.043');
    const drop = Q.filter(q => /^Material__[234]\.043$/.test(q.mat));
    let lo = 1e9, hi = -1e9;   /* extent of the whole plate assembly along its normal */
    const tex = doc.createTexture('TGK_plate').setImage(fs.readFileSync(PLATES + 'plate_eu.png')).setMimeType('image/png');
    const mat = doc.createMaterial('TGK_plate').setBaseColorTexture(tex).setRoughnessFactor(0.45).setMetallicFactor(0);
    const buf = root.listBuffers()[0];
    let made = 0;
    const U = scale / 4.7;     /* model units per metre (the CC is authored in cm) */
    for (const out of [1, -1]) {
      const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; const cz = (A.mn[2] + A.mx[2]) / 2;
      for (const q of white) for (let i = 0; i < q.W.length / 3; i++) {
        if (Math.sign(q.W[i*3+2] - cz) !== out) continue;
        for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q.W[i*3+k]); mx[k] = Math.max(mx[k], q.W[i*3+k]); }
      }
      if (mn[0] > mx[0]) continue;
      let face = out > 0 ? mx[2] : mn[2];
      for (const d of drop) for (let i = 0; i < d.W.length / 3; i++) {
        const x = d.W[i*3], y = d.W[i*3+1], z = d.W[i*3+2];
        if (Math.sign(z - cz) !== out || x < mn[0] - U * 0.01 || x > mx[0] + U * 0.01) continue;
        face = out > 0 ? Math.max(face, z) : Math.min(face, z);
      }
      face += out * U * 0.0015;
      /* inset a hair so the white backing frames the decal like a real plate */
      const x0 = mn[0] + U * 0.002, x1 = mx[0] - U * 0.002, y0 = mn[1] + U * 0.002, y1 = mx[1] - U * 0.002;
      const uL = out > 0 ? 0 : 1, uR = 1 - uL;
      const pos = new Float32Array([x0, y0, face, x1, y0, face, x1, y1, face, x0, y1, face]);
      const nor = new Float32Array([0, 0, out, 0, 0, out, 0, 0, out, 0, 0, out]);
      const uv = new Float32Array([uL, 1, uR, 1, uR, 0, uL, 0]);
      const idx = out > 0 ? new Uint16Array([0, 1, 2, 0, 2, 3]) : new Uint16Array([0, 2, 1, 0, 3, 2]);
      const prim = doc.createPrimitive().setMaterial(mat)
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf))
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nor).setBuffer(buf))
        .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buf))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buf));
      scene.addChild(doc.createNode('TGK_PLATE_' + (out > 0 ? 'P' : 'N')).setMesh(doc.createMesh('TGK_PLATE').addPrimitive(prim)));
      made++;
      console.log('cc plate', out, 'w', ((mx[0]-mn[0])/U).toFixed(3), 'h', ((mx[1]-mn[1])/U).toFixed(3), 'm');
    }
    for (const d of drop) d.mesh.removePrimitive(d.p);
    console.log('cc plates made', made);
  }
}
await doc.transform(prune({ propertyTypes: ['Node','Mesh','Primitive','Accessor'], keepLeaves: false }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await IO.write('/home/claude/w/out/' + key + '.glb', doc);
