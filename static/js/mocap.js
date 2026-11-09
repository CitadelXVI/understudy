// Poses from the reference panel (prototype): MediaPipe finds the body (33 points) and the hands
// (21 points each) in the reference image or video, and the points become Understudy poses.
//   Pose from this frame — the image (or the video's current frame) fitted onto the skeleton at the
//     stage's current frame, as a handle edit: Pin pose, Apply or Regenerate around it.
//   Track video → keyframes — every frame of the video tracked, smoothed, and every Nth clip frame
//     pinned as a pose (or just hands, feet and hips) with the hips following the person's path;
//     Kimodo generates the motion between the keys from the prompt.
// MediaPipe runs in the page from static/vendor/mediapipe (no network; its usage logger is disabled).
// Its depth is a guess from one camera, so poses are a starting point to correct with the handles.
import * as viewer from './viewer.js';
import * as compose from './compose.js';
import * as library from './library.js';
import * as handles from './handles.js';

const $ = s => document.querySelector(s);
const BASE = '/static/vendor/mediapipe/';
const FPS = 30;          // clip frames per second
const TRACK_HZ = 15;     // video samples per second while tracking
const FOV_Y = 40;        // assumed camera field of view (degrees) for the path from the video

let mp = null, poseImage = null, poseVideo = null, handImage = null, loading = null;
let clock = 0;            // VIDEO-mode timestamps must keep rising across runs
let last = null;         // { kind: 'image', result } | { kind: 'video', samples }
const view = $('#referenceView'), bar = $('#mocapBar'), hint = $('#mocapHint');

async function models() {
  if (loading) return loading;
  loading = (async () => {
    mp = await import(BASE + 'vision_bundle.mjs');
    const files = await mp.FilesetResolver.forVisionTasks(BASE + 'wasm');
    const make = async (Kind, model, mode, extra) => {
      for (const delegate of ['GPU', 'CPU']) {
        try { return await Kind.createFromOptions(files, { baseOptions: { modelAssetPath: BASE + model, delegate }, runningMode: mode, ...extra }); }
        catch (e) { if (delegate === 'CPU') throw e; }
      }
    };
    poseImage = await make(mp.PoseLandmarker, 'pose_landmarker_heavy.task', 'IMAGE', { numPoses: 1 });
    poseVideo = await make(mp.PoseLandmarker, 'pose_landmarker_heavy.task', 'VIDEO', { numPoses: 1 });
    handImage = await make(mp.HandLandmarker, 'hand_landmarker.task', 'IMAGE', { numHands: 1 });
  })();
  try { await loading; } catch (e) { loading = null; throw e; }
  return loading;
}

// --- MediaPipe points → stage points ---
// MediaPipe world points: metres, origin between the hips, x to the image's right, y down, z away
// from the camera. The stage: Y up, the camera's view of a figure facing it is +Z toward the camera.
const K = p => [p.x, -p.y, -p.z];
const L = { nose: 0, lear: 7, rear: 8, lsh: 11, rsh: 12, lel: 13, rel: 14, lwr: 15, rwr: 16, lpinky: 17, rpinky: 18, lindex: 19, rindex: 20,
  lhip: 23, rhip: 24, lknee: 25, rknee: 26, lank: 27, rank: 28, lheel: 29, rheel: 30, ltoe: 31, rtoe: 32 };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const rotY = (p, a) => [p[0] * Math.cos(a) + p[2] * Math.sin(a), p[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a)];

// Body points (world landmarks) → the targets handles.fitPose takes, around `hips`, turned by `yaw`.
function targets(world, hips = [0, 0, 0], yaw = 0, hands = {}) {
  const P = {}; for (const [k, i] of Object.entries(L)) P[k] = K(world[i]);
  const c = mid(P.lhip, P.rhip), T = {};
  for (const [k, p] of Object.entries(P)) T[k] = add(rotY(sub(p, c), yaw), hips);
  T.hips = [...hips];
  for (const s of ['l', 'r']) {
    const h = hands[s];
    if (h) { T[s + 'handDir'] = rotY(h.dir, yaw); T[s + 'handAcross'] = rotY(h.across, yaw); }
    else { // the pose model's own index and pinky points: rough, but they turn the hand the right way
      T[s + 'handDir'] = sub(mid(T[s + 'index'], T[s + 'pinky']), T[s + 'wr']);
      T[s + 'handAcross'] = sub(T[s + 'index'], T[s + 'pinky']);
    }
  }
  return T;
}

// SOMA joints (GEM-X output: name -> [x, y, z] in the stage's axes) → the targets handles.fitPose takes.
// Same skeleton family as Kimodo, so the joints are used as they are; hands from the middle/index/pinky bases.
export function targetsFromSoma(J, hips = null) {
  const g = n => J[n], c = g('Hips'), o = hips ? sub(hips, c) : [0, 0, 0], at = n => add(g(n), o);
  const T = { hips: hips ? [...hips] : [...c],
    lhip: at('LeftLeg'), rhip: at('RightLeg'), lsh: at('LeftArm'), rsh: at('RightArm'), lel: at('LeftForeArm'), rel: at('RightForeArm'),
    lwr: at('LeftHand'), rwr: at('RightHand'), lknee: at('LeftShin'), rknee: at('RightShin'), lank: at('LeftFoot'), rank: at('RightFoot'),
    ltoe: at('LeftToeBase'), rtoe: at('RightToeBase'), nose: null, lear: null, rear: null };
  // head: ears along the eye line, nose forward of the eyes' midpoint
  const le = at('LeftEye'), re = at('RightEye'), hd = at('Head'), em = mid(le, re);
  T.lear = add(hd, sub(le, em)); T.rear = add(hd, sub(re, em)); T.nose = add(hd, sub(em, hd));
  for (const [s, side] of [['l', 'Left'], ['r', 'Right']]) {
    const w = at(side + 'Hand'), m = J[side + 'HandMiddle1'] ? at(side + 'HandMiddle1') : at(side + 'HandMiddleEnd');
    const i1 = J[side + 'HandIndex1'] ? at(side + 'HandIndex1') : null, p1 = J[side + 'HandPinky1'] ? at(side + 'HandPinky1') : null;
    if (m) T[s + 'handDir'] = sub(m, w);
    if (i1 && p1) T[s + 'handAcross'] = sub(i1, p1);
  }
  return T;
}
const headingOf = compose.headingOf;
// Fit, then turn the measured body so its hips face `heading` (radians) when given.
function fit(world, hips, heading = null, hands = {}) {
  let pose = handles.fitPose(targets(world, hips, 0, hands));
  if (heading != null) pose = handles.fitPose(targets(world, hips, heading - headingOf(pose.rotations[0]), hands));
  return pose;
}
// Height of the lowest sole point below the hips for a pose (toe joints sit on the floor, ankles 5 cm up).
function lowest(pose) {
  const P = handles.positionsOf(pose.root, pose.rotations), n = viewer.skeleton.names, at = name => P[n.indexOf(name)];
  return Math.min(at('LeftToeBase')[1], at('RightToeBase')[1], at('LeftFoot')[1] - 0.05, at('RightFoot')[1] - 0.05);
}

// --- hands: shape and turn from a crop around each wrist ---
function cropHand(source, W, H, lm, wi, ei) {
  const w = lm[wi], e = lm[ei];
  const fx = (w.x - e.x) * W, fy = (w.y - e.y) * H, size = Math.max(48, Math.hypot(fx, fy) * 1.6);
  const cx = w.x * W + fx * 0.35, cy = w.y * H + fy * 0.35;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  c.getContext('2d').drawImage(source, cx - size / 2, cy - size / 2, size, size, 0, 0, 256, 256);
  const r = handImage.detect(c);
  if (!r.landmarks.length) return null;
  const hw = r.worldLandmarks[0].map(K);
  const dir = sub(mid(hw[5], hw[17]), hw[0]), across = sub(hw[5], hw[17]);
  return { dir, across, shape: handShape(hw), crop: { cx, cy, size, points: r.landmarks[0] } };
}
// Closest of the hand-track shapes: fist, point, flat, open, relaxed.
function handShape(h) {
  const d = (a, b) => Math.hypot(...sub(h[a], h[b]));
  const ext = [[8, 6], [12, 10], [16, 14], [20, 18]].map(([tip, pip]) => d(0, tip) > d(0, pip) * 1.15);
  const n = ext.filter(Boolean).length;
  if (n === 0) return 'fist';
  if (ext[0] && n === 1) return 'point';
  if (n === 4) return d(8, 20) < d(5, 17) * 1.6 ? 'flat' : 'open';
  return 'relaxed';
}

// --- overlay ---
function overlay() {
  let c = view.querySelector('canvas.mocap-overlay');
  const media = view.querySelector('img, video'); if (!media) return null;
  if (!c) { c = document.createElement('canvas'); c.className = 'mocap-overlay'; view.append(c); }
  const r = media.getBoundingClientRect(), pr = view.getBoundingClientRect();
  c.style.left = `${r.left - pr.left}px`; c.style.top = `${r.top - pr.top}px`; c.style.width = `${r.width}px`; c.style.height = `${r.height}px`;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  return c;
}
function drawPoints(points, hands = []) {
  const c = overlay(); if (!c) return;
  const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
  if (!$('#mocapOverlay').checked || !points) return;
  const du = new mp.DrawingUtils(g);
  du.drawConnectors(points, mp.PoseLandmarker.POSE_CONNECTIONS, { color: '#ffffff', lineWidth: 2 });
  du.drawLandmarks(points, { color: '#f2c14e', radius: 2, lineWidth: 0 });
  for (const h of hands) {
    const pts = h.crop.points.map(p => ({ x: (h.crop.cx - h.crop.size / 2 + p.x * h.crop.size) / h.W, y: (h.crop.cy - h.crop.size / 2 + p.y * h.crop.size) / h.H, z: 0 }));
    du.drawConnectors(pts, mp.HandLandmarker.HAND_CONNECTIONS, { color: '#9ad1ff', lineWidth: 1.5 });
  }
}
function drawVideoFrame() {
  const v = view.querySelector('video'); if (!v || last?.kind !== 'video') return;
  const s = sampleAt(last.samples, v.currentTime);
  drawPoints(s?.image || null);
}

// --- pose from the image or the video's current frame ---
function currentSource() {
  const media = view.querySelector('img, video'); if (!media) return null;
  if (media.tagName === 'IMG') return { source: media, W: media.naturalWidth, H: media.naturalHeight };
  const c = document.createElement('canvas'); c.width = media.videoWidth; c.height = media.videoHeight;
  c.getContext('2d').drawImage(media, 0, 0); return { source: c, W: c.width, H: c.height };
}
async function poseFromFrame() {
  const st = viewer.state;
  if (!st.animation || !viewer.skeleton.names?.length) { say('Select a clip first: the pose goes onto its skeleton at the current frame.'); return; }
  if (!viewer.skeleton.names.includes('LeftToeBase')) { say('Pose from a reference needs a SOMA clip.'); return; }
  const src = currentSource(); if (!src) { say('Pick an image or a video above first.'); return; }
  say('Finding the body…');
  await models();
  const r = poseImage.detect(src.source);
  if (!r.landmarks.length) { last = null; drawPoints(null); say('No body found in this image. Full-body shots of a real person work best; drawn hands and close-ups rarely read.'); return; }
  const lm = r.landmarks[0], hands = {}, drawn = [];
  for (const [s, wi, ei] of [['l', 15, 13], ['r', 16, 14]]) {
    const h = cropHand(src.source, src.W, src.H, lm, wi, ei);
    if (h) { hands[s] = h; drawn.push({ ...h, W: src.W, H: src.H }); }
  }
  last = { kind: 'image', result: r };
  drawPoints(lm, drawn);
  const f = st.frame, J = viewer.skeleton.parents.length;
  const hipsRot = [...st.rotations.subarray(f * J * 4, f * J * 4 + 4)];
  const root = [...st.root.slice(f * 3, f * 3 + 3)];
  const keepFacing = $('#mocapFacing').value === 'clip';
  const pose = fit(r.worldLandmarks[0], root, keepFacing ? headingOf(hipsRot) : null, hands);
  pose.root[1] += (viewer.state.floorY || 0) - lowest(pose); // feet on the stage's floor
  handles.loadExternalPose(pose, 'Pose from reference');
  const vis = lm.reduce((a, p) => a + (p.visibility ?? 0), 0) / lm.length;
  const shapes = ['l', 'r'].map(s => hands[s] ? `${s === 'l' ? 'left' : 'right'} hand ${hands[s].shape}` : null).filter(Boolean);
  if (hands.l) $('#handL').value = hands.l.shape;
  if (hands.r) $('#handR').value = hands.r.shape;
  say(`Pose placed at frame ${f + 1} (body found, ${Math.round(vis * 100)}% of points visible${shapes.length ? '; ' + shapes.join(', ') + ' — Set in the Handles bar to keep the shapes' : '; hands not found'}). Depth is a guess: check it from the side, fix with the handles, then Pin pose, Apply or Regenerate around.`);
}

// --- video tracking ---
const seek = (v, t) => new Promise(res => { if (Math.abs(v.currentTime - t) < 1e-4) return res(); v.addEventListener('seeked', res, { once: true }); v.currentTime = t; });
function sampleAt(samples, t) {
  if (!samples?.length) return null;
  let best = null, bd = Infinity; for (const s of samples) { const d = Math.abs(s.t - t); if (d < bd) { bd = d; best = s; } }
  return bd < 0.2 ? best : null;
}
// Linear blend of the tracked points at time t (null across gaps over half a second).
function blendAt(samples, t) {
  let i = samples.findIndex(s => s.t >= t);
  if (i < 0) return samples.at(-1).t > t - 0.25 ? samples.at(-1) : null;
  if (i === 0) return samples[0].t < t + 0.25 ? samples[0] : null;
  const a = samples[i - 1], b = samples[i];
  if (b.t - a.t > 0.5) return null;
  const k = (t - a.t) / (b.t - a.t), lerp = (x, y) => x + (y - x) * k;
  const mix = (p, q) => p.map((pa, j) => ({ x: lerp(pa.x, q[j].x), y: lerp(pa.y, q[j].y), z: lerp(pa.z, q[j].z), visibility: lerp(pa.visibility ?? 1, q[j].visibility ?? 1) }));
  return { t, world: mix(a.world, b.world), image: mix(a.image, b.image), cam: a.cam.map((x, j) => lerp(x, b.cam[j])) };
}
// MediaPipe now and then trades the left and right leg (or arm) for a few frames, mostly when a leg
// crosses in front of the body. On screen the true limbs move little between samples, so when the
// swapped labels sit much closer to the previous sample than the given ones, swap them back.
const LIMB_PAIRS = { legs: [[25, 26], [27, 28], [29, 30], [31, 32]], arms: [[13, 14], [15, 16], [17, 18], [19, 20], [21, 22]] };
function unswap(raw) {
  let swaps = 0;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1].image, b = raw[i].image, d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    for (const pairs of Object.values(LIMB_PAIRS)) {
      let keep = 0, swap = 0;
      for (const [l, r] of pairs) { keep += d(b[l], a[l]) + d(b[r], a[r]); swap += d(b[l], a[r]) + d(b[r], a[l]); }
      if (swap < keep * 0.6) {
        for (const key of ['image', 'world']) { const pts = raw[i][key] = [...raw[i][key]]; for (const [l, r] of pairs) [pts[l], pts[r]] = [pts[r], pts[l]]; }
        swaps++;
      }
    }
  }
  return swaps;
}
// Centred moving average over ±n samples (points and camera values).
function smooth(samples, n = 2) {
  return samples.map((s, i) => {
    const win = samples.slice(Math.max(0, i - n), i + n + 1).filter(o => Math.abs(o.t - s.t) <= (n + 0.5) / TRACK_HZ);
    const avg = key => s[key].map((p, j) => { const m = { x: 0, y: 0, z: 0, visibility: 0 }; for (const o of win) { m.x += o[key][j].x; m.y += o[key][j].y; m.z += o[key][j].z; m.visibility += o[key][j].visibility ?? 1; } for (const c of 'xyz') m[c] /= win.length; m.visibility /= win.length; return m; });
    return { t: s.t, world: avg('world'), image: avg('image'), cam: s.cam.map((_, j) => win.reduce((a, o) => a + o.cam[j], 0) / win.length) };
  });
}
// Where the hips are, from one camera: distance from the body's size on screen, side and height from its place.
const SEGS = [[11, 23], [12, 24], [23, 25], [24, 26], [25, 27], [26, 28], [11, 12], [23, 24]];
function camera(world, image, W, H) {
  const f = H / (2 * Math.tan(FOV_Y * Math.PI / 360));
  let px = 0, m = 0;
  for (const [a, b] of SEGS) { px += Math.hypot((image[a].x - image[b].x) * W, (image[a].y - image[b].y) * H); m += Math.hypot(world[a].x - world[b].x, world[a].y - world[b].y); }
  const D = f * m / Math.max(px, 1);
  const u = (image[23].x + image[24].x) / 2 * W, vv = (image[23].y + image[24].y) / 2 * H;
  const foot = Math.max(...[27, 28, 29, 30, 31, 32].map(i => image[i].y)) * H;
  return [(u - W / 2) * D / f, -(vv - H / 2) * D / f, -D, -(foot - H / 2) * D / f]; // hips x, hips y, z, lowest foot y
}
async function trackVideo() {
  const v = view.querySelector('video'); if (!v) { say('Pick a video above first.'); return; }
  if (!viewer.skeleton.names?.includes('LeftToeBase')) { say('Select a SOMA clip first: the keys are built on its skeleton.'); return; }
  const button = $('#mocapTrack'); button.disabled = true;
  try {
    say('Loading MediaPipe…'); await models();
    if (!v.duration || !Number.isFinite(v.duration)) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
    v.pause();
    const dur = Math.min(v.duration, 12), W = v.videoWidth, H = v.videoHeight, raw = [];
    let missed = 0;
    const base = clock + 1000;
    for (let i = 0, t = 0; t <= dur + 1e-6; i++, t = i / TRACK_HZ) {
      await seek(v, Math.min(t, v.duration - 0.001));
      const r = poseVideo.detectForVideo(v, clock = base + Math.round(t * 1000));
      if (r.landmarks.length) { raw.push({ t, world: r.worldLandmarks[0], image: r.landmarks[0], cam: camera(r.worldLandmarks[0], r.landmarks[0], W, H) }); drawPoints(r.landmarks[0]); }
      else missed++;
      if (i % 5 === 0) say(`Tracking… ${t.toFixed(1)} / ${dur.toFixed(1)} s`);
    }
    if (raw.length < 3) { say('The body was not found in this video. A real person, full body in frame, steady camera works best.'); return; }
    const swaps = unswap(raw);
    // the distance is the noisiest value: median of 5 first, then the average
    const med = raw.map((s, i) => { const w = raw.slice(Math.max(0, i - 2), i + 3).map(o => o.cam[2]).sort((a, b) => a - b); return w[w.length >> 1]; });
    raw.forEach((s, i) => { const k = med[i] / s.cam[2]; s.cam = [s.cam[0] * k, s.cam[1] * k, med[i], s.cam[3] * k]; });
    const samples = smooth(smooth(raw, 2), 2);
    last = { kind: 'video', samples, W, H, dur, missed, swaps, total: raw.length + missed };
    last.track = trackPoses(samples, dur);
    buildKeys(); preview();
  } catch (e) { say(e.message); }
  finally { button.disabled = false; }
}
// Every clip frame of the tracked video as a pose (null across gaps), hips on the person's path,
// frame 0's hips at the origin.
function trackPoses(samples, dur) {
  const frames = Math.max(60, Math.min(360, Math.round(dur * FPS))); // the composer's 60–360 frames
  const floorCam = [...samples.map(s => s.cam[3])].sort((a, b) => a - b)[Math.floor(samples.length * 0.1)];
  const out = [];
  for (let f = 0; f < frames; f++) {
    const s = blendAt(samples, Math.min(f / FPS, dur)); if (!s) { out.push(null); continue; }
    const pose = handles.fitPose(targets(s.world, [0, 0, 0]));
    const lift = Math.max(0, s.cam[3] - floorCam - 0.04);       // feet off the floor (a jump) from the camera
    pose.root = [s.cam[0], 0.02 - lowest(pose) + lift, s.cam[2]]; // toe joints rest ~2 cm up in Kimodo clips
    out.push(pose);
  }
  const first = out.find(Boolean);
  if (first) { const [x0, , z0] = first.root; for (const p of out) if (p) { p.root[0] -= x0; p.root[2] -= z0; } }
  return out;
}
function evenKeys(frames, step) {
  const keys = []; for (let f = 0; f < frames; f += step) keys.push(f);
  if (keys.at(-1) !== frames - 1) keys.push(frames - 1);
  return keys;
}
// Keys where the motion turns: start from the first and last frame and keep adding the frame where straight
// interpolation between its neighbouring keys strays furthest from the tracked joints (a kick's peak, a landing),
// so the same number of keys lands on the moments that matter instead of an even grid that can skip them.
function extremeKeys(track, count) {
  const P = track.map(p => p ? handles.positionsOf(p.root, p.rotations) : null), n = track.length;
  const ok = P.map(Boolean), keys = [0, n - 1].filter(f => ok[f]);
  const stray = (a, b) => { // worst frame between keys a and b: joint distance from the interpolated pose
    let best = -1, bd = 0.02;
    for (let f = a + 3; f <= b - 3; f++) {
      if (!ok[f]) continue;
      const t = (f - a) / (b - a); let d = 0;
      for (let j = 0; j < P[f].length; j++) for (let c = 0; c < 3; c++) { const e = P[f][j][c] - (P[a][j][c] + (P[b][j][c] - P[a][j][c]) * t); d += e * e; }
      d = Math.sqrt(d / P[f].length);
      if (d > bd) { bd = d; best = f; }
    }
    return [best, bd];
  };
  while (keys.length < count) {
    keys.sort((p, q) => p - q);
    let pick = -1, worst = 0;
    for (let i = 0; i + 1 < keys.length; i++) { const [f, d] = stray(keys[i], keys[i + 1]); if (f >= 0 && d > worst) { worst = d; pick = f; } }
    if (pick < 0) break;
    keys.push(pick);
  }
  return keys.sort((p, q) => p - q);
}

// Keys from the tracked video: poses every Nth frame.
function buildKeys() {
  if (last?.kind !== 'video' || !last.track) return;
  // Kimodo's guidance: under ~20 constrained frames per constraint type (the root path is exempt), so long
  // clips space their pose keys out; the hips' ground path is pinned densely on its own.
  const asked = Math.max(2, Math.min(30, Number($('#mocapStep').value) || 10)), frames = last.track.length;
  const step = Math.max(asked, Math.ceil((frames - 1) / 19));
  const keys = $('#mocapKeyMode').value === 'even' ? evenKeys(frames, step) : extremeKeys(last.track, Math.ceil((frames - 1) / step) + 1);
  const poses = keys.filter(f => last.track[f]).map(f => ({ frame: f, ...last.track[f] }));
  if (!poses.length) { say('No usable keys: the body was lost for most of the video.'); return; }
  const mode = $('#mocapPin').value, list = [];
  for (let i = 0; i < poses.length; i += 20) { // about 20 keys per constraint (upstream's guidance)
    const chunk = poses.slice(i, i + 20);
    const c = { type: mode === 'ends' ? 'end-effector' : 'fullbody', frame_indices: chunk.map(p => p.frame), root_positions: chunk.map(p => p.root), local_joints_rot_xyzw: chunk.map(p => p.rotations) };
    if (mode === 'ends') c.joint_names = ['Hips', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'];
    list.push(c);
  }
  // the hips' ground path every 3 frames with the hips' facing, from the whole tracked clip
  const pathFrames = []; for (let f = 0; f < frames; f += 3) if (last.track[f]) pathFrames.push(f);
  if (pathFrames.length > 1) list.push({ type: 'root2d', frame_indices: pathFrames,
    smooth_root_2d: pathFrames.map(f => [last.track[f].root[0], last.track[f].root[2]]),
    global_root_heading: pathFrames.map(f => { const h = headingOf(last.track[f].rotations[0]); return [Math.cos(h), Math.sin(h)]; }) });
  list[0].heading = headingOf(poses[0].rotations[0]); // frame 0 faces the way the person faces
  compose.replaceKeyframes(list);
  compose.setFirstHeading(list[0].heading);
  const prompt = $('#prompt').value.trim();
  compose.setSegments([{ prompt, frames }]);
  compose.flash();
  const travel = Math.hypot(poses.at(-1).root[0], poses.at(-1).root[2]);
  say(`Tracked ${last.total - last.missed} of ${last.total} video frames (${last.dur.toFixed(1)} s${last.swaps ? `; ${last.swaps} left/right mix-up${last.swaps === 1 ? '' : 's'} fixed` : ''}). ${poses.length} keys pinned ${$('#mocapKeyMode').value === 'even' ? `every ${step} frames` : 'where the motion turns'}${step > asked ? ` (at most ${Math.ceil((frames - 1) / step) + 1}: Kimodo follows ~20 keys best)` : ''} over ${frames} frames, hips path every 3 frames, hips travel ${travel.toFixed(2)} m. ${prompt ? 'Generate to fill the motion between them.' : 'Write a prompt that describes the move, then Generate.'}`);
}

// A motion tracked outside the page (GEM-X: SOMA joints per 30 Hz frame in the video camera's axes, x right,
// y up, z toward the camera, floor near y = 0) becomes the tracked motion: keys, hip path and preview as usual.
export function loadSomaTrack(data, label = 'GEM-X') {
  if (data.rot) return loadSomaRotations(data, label);
  const J = data.joints, frames = Math.max(60, Math.min(360, data.frames));
  const at = (f, n) => J[n][Math.min(f, data.frames - 1)];
  const track = [];
  for (let f = 0; f < frames; f++) {
    const pts = {}; for (const n of Object.keys(J)) pts[n] = at(f, n);
    const pose = handles.fitPose(targetsFromSoma(pts));
    pose.root = [...pts.Hips];
    const low = lowest(pose); if (low < 0.02) pose.root[1] += 0.02 - low; // never under Kimodo's floor
    track.push(pose);
  }
  const [x0, , z0] = track[0].root;
  for (const p of track) { p.root[0] -= x0; p.root[2] -= z0; }
  last = { kind: 'video', samples: [], dur: data.frames / FPS, missed: 0, swaps: 0, total: data.frames, track, source: label };
  buildKeys(); preview();
  return track.length;
}

// Native rotations (gemx_export.py *_rot.json): GEM-X's local SOMA rotations are Kimodo's own, so each frame's
// pose is used as it is — collarbones, spine and head included — with the Hips joint as the root (world axes, Y up).
function loadSomaRotations(data, label) {
  const names = viewer.skeleton.names, order = names.map(n => data.names.indexOf(n));
  if (order.some(i => i < 0)) throw new Error('The GEM-X file does not cover this skeleton (' + names.filter((n, i) => order[i] < 0).join(', ') + ')');
  const frames = Math.max(60, Math.min(360, data.frames)), track = [];
  for (let f = 0; f < frames; f++) {
    const k = Math.min(f, data.frames - 1);
    track.push({ root: [...data.root[k]], rotations: order.map(i => [...data.rot[k][i]]) });
  }
  // one height shift for the whole clip: its low soles (5th percentile) onto Kimodo's floor (toe joints ~2 cm up)
  const lows = track.map(lowest).sort((p, q) => p - q), lift = 0.02 - lows[Math.floor(lows.length * 0.05)];
  for (const p of track) p.root[1] += lift;
  const [x0, , z0] = track[0].root;
  for (const p of track) { p.root[0] -= x0; p.root[2] -= z0; }
  last = { kind: 'video', samples: [], dur: data.frames / FPS, missed: 0, swaps: 0, total: data.frames, track, source: label + ' (native rotations)', shift: [x0, z0] };
  buildKeys(); preview();
  const useBtn = $('#mocapUseTrack'); if (useBtn) useBtn.hidden = false;
  return track.length;
}

// The tracked motion as a clip, as it is (then Clean up): the video's own timing and speed, where generating from keys
// smooths a strike (a 5.6 m/s kick came back at 3.7 m/s through Kimodo).
async function useTrack() {
  if (last?.kind !== 'video' || !last.track) { say('Track a video first.'); return; }
  const btn = $('#mocapUseTrack'); btn.disabled = true;
  try {
    say('Making a clip from the tracked motion…');
    const name = ($('#prompt').value.trim() || 'tracked motion').replace(/^A person /i, '') + ' · from video';
    const body = { name, model: $('#motionModel')?.value || 'soma-rp-v1.2', prompt: $('#prompt').value.trim(), tags: ['mocap', 'tracked'],
      project: library.currentProject(), root: last.track.map(p => p.root), rotations: last.track.map(p => p.rotations) };
    let r = await fetch('/api/animations/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    const made = await r.json();
    say('Clean up: floor, shake and clipping…');
    r = await fetch(`/api/animations/${made.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'cleanup', in_place: true, keep_snap: true }) });   // tracked motion: keep its speed and snap
    const cleaned = r.ok ? await r.json() : made;
    await library.refresh();
    library.select(library.find(cleaned.id) || cleaned);
    const flags = cleaned.metrics?.flags || [];
    say(`Clip made from the tracked motion (${cleaned.frames} frames)${flags.length ? `; the checks found: ${flags.join(', ')}` : '; checks clean'}.`);
  } catch (e) { say(e.message); }
  btn.disabled = false;
}
$('#mocapUseTrack')?.addEventListener('click', useTrack);

// GEM-X on the server: upload the reference video, follow the job, load its native SOMA rotations as the track.
let gemxEnabled = false;
fetch('/api/mocap/gemx').then(r => r.ok ? r.json() : null).then(d => { gemxEnabled = !!d?.enabled; syncBar(); }).catch(() => {});
async function trackGemx() {
  const v = view.querySelector('video'); if (!v) { say('Pick a video above first.'); return; }
  if (!viewer.skeleton.names?.includes('LeftToeBase')) { say('Select a SOMA clip first: the keys are built on its skeleton.'); return; }
  const file = $('#referenceFile').files[0]; if (!file) { say('Pick the video again (the file is needed for upload).'); return; }
  const button = $('#mocapGemx'); button.disabled = true;
  try {
    say('GEM-X: uploading the video…');
    let r = await fetch('/api/mocap/gemx?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'video/mp4' }, body: file });
    if (!r.ok) throw new Error(await r.text());
    const job = await r.json(), t0 = Date.now();
    for (;;) {
      await new Promise(res => setTimeout(res, 2000));
      const j = await (await fetch('/api/mocap/gemx/' + job.id)).json();
      if (j.status === 'failed') throw new Error('GEM-X failed: ' + (j.error || '') + ' — ' + (j.log || []).slice(-3).join(' / '));
      if (j.status === 'done') break;
      say(`GEM-X (${j.device === 'cuda' ? 'Radeon' : 'CPU'}): ${j.stage || 'working'}… ${Math.round((Date.now() - t0) / 1000)} s`);
    }
    const data = await (await fetch('/api/mocap/gemx/' + job.id + '/rot.json')).json();
    loadSomaTrack(data, 'GEM-X');
    drawVideoFrame();
  } catch (e) { say(e.message); }
  finally { button.disabled = false; }
}

// GEM-X on one image: a true 3D pose with native SOMA rotations, placed at the stage's frame like any handle edit.
const SOMA_DRAW = [['Hips','Spine2'],['Spine2','Chest'],['Chest','Neck1'],['Neck1','Head'],['Chest','LeftArm'],['LeftArm','LeftForeArm'],['LeftForeArm','LeftHand'],
  ['Chest','RightArm'],['RightArm','RightForeArm'],['RightForeArm','RightHand'],['Hips','LeftLeg'],['LeftLeg','LeftShin'],['LeftShin','LeftFoot'],['LeftFoot','LeftToeBase'],
  ['Hips','RightLeg'],['RightLeg','RightShin'],['RightShin','RightFoot'],['RightFoot','RightToeBase']];
function drawSoma(d) {
  const c = overlay(); if (!c) return; const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
  if (!$('#mocapOverlay').checked || !d?.joints2d) return;
  const [W, H] = d.image_size, P = n => [d.joints2d[n][0] / W * c.width, d.joints2d[n][1] / H * c.height];
  g.lineWidth = 2 * (window.devicePixelRatio || 1);
  for (const [a, b] of SOMA_DRAW) { g.strokeStyle = /Left/.test(a + b) ? '#f2c14e' : '#ffffff'; g.beginPath(); g.moveTo(...P(a)); g.lineTo(...P(b)); g.stroke(); }
}
async function poseGemx() {
  const st = viewer.state;
  if (!st.animation || !viewer.skeleton.names?.includes('LeftToeBase')) { say('Select a SOMA clip first: the pose goes onto its skeleton at the current frame.'); return; }
  const src = currentSource(); if (!src) { say('Pick an image or a video above first.'); return; }
  const button = $('#mocapPoseGemx'); button.disabled = true;
  try {
    const c = document.createElement('canvas'); c.width = src.W; c.height = src.H; c.getContext('2d').drawImage(src.source, 0, 0);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    say('GEM-X: posing the figure on the Radeon… (20–40 s)');
    const r = await fetch('/api/mocap/gemx-image', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    if (!d.found) { say('GEM-X found no person in this image.'); return; }
    last = { kind: 'gemx-image', result: d }; drawSoma(d);
    const names = viewer.skeleton.names, order = names.map(n => d.names.indexOf(n));
    const rotations = order.map(i => [...d.rot[i]]);
    const f = st.frame, J = viewer.skeleton.parents.length;
    if ($('#mocapFacing').value === 'clip') { // turn about Y so the hips face like the clip's at this frame
      const want = headingOf([...st.rotations.subarray(f * J * 4, f * J * 4 + 4)]), have = headingOf(rotations[0]), a = (want - have) / 2;
      rotations[0] = viewer.multiply([0, Math.sin(a), 0, Math.cos(a)], rotations[0]);
    }
    const root = [st.root[f * 3], 0, st.root[f * 3 + 2]], pose = { root, rotations };
    pose.root[1] = (viewer.state.floorY || 0) - lowest(pose);
    handles.loadExternalPose(pose, 'Pose from reference (GEM-X)');
    say(`GEM-X pose placed at frame ${f + 1} (person found, ${Math.round(d.score * 100)}% sure). Check it from the side, fix with the handles, then Pin pose, Apply or Regenerate around.`);
  } catch (e) { say(e.message); }
  finally { button.disabled = false; }
}

function say(text) { hint.textContent = text; hint.hidden = !text; }

// Raw tracking on the stage: while ticked, the stage shows the fitted MediaPipe pose for the current frame
// instead of the clip's (for judging what Kimodo adds). Off while the handles are in use.
function preview() {
  const on = $('#mocapPreview').checked && last?.track && !handles.isActive();
  const f = viewer.state.frame, p = on ? last.track[Math.min(f, last.track.length - 1)] : null;
  if (p) viewer.setOverride({ frame: f, root: p.root, rotations: p.rotations });
  else if (viewer.state.override?.mocap) viewer.setOverride(null);
  if (p) viewer.state.override.mocap = true;
  viewer.draw();
}
viewer.onFrameChange(() => { if ($('#mocapPreview').checked) preview(); });

// Show the bar when a reference is picked; image → pose only, video → pose + tracking.
function syncBar() {
  const media = view.querySelector('img, video'), isVideo = !!media && media.tagName === 'VIDEO';
  bar.hidden = !media;
  $('#mocapTrack').hidden = $('#mocapStepLabel').hidden = $('#mocapPinLabel').hidden = $('#mocapPreviewLabel').hidden = $('#mocapKeyModeLabel').hidden = !isVideo;
  $('#mocapGemx').hidden = !(isVideo && gemxEnabled);
  $('#mocapPoseGemx').hidden = !(media && gemxEnabled);
}
new MutationObserver(() => {
  const media = view.querySelector('img, video');
  last = null; say(''); syncBar();
  if (media?.tagName === 'VIDEO') for (const ev of ['timeupdate', 'seeked']) media.addEventListener(ev, drawVideoFrame);
  if (media) media.addEventListener(media.tagName === 'IMG' ? 'load' : 'loadedmetadata', () => overlay(), { once: true });
}).observe(view, { childList: true });
$('#mocapPose').onclick = () => poseFromFrame().catch(e => say(e.message));
$('#mocapTrack').onclick = () => trackVideo();
$('#mocapGemx').onclick = () => trackGemx();
$('#mocapPoseGemx').onclick = () => poseGemx();
$('#mocapStep').onchange = buildKeys;
$('#mocapPreview').onchange = preview;
$('#mocapPin').onchange = buildKeys;
$('#mocapKeyMode').onchange = buildKeys;
$('#mocapOverlay').onchange = () => { if (last?.kind === 'image') drawPoints(last.result.landmarks[0]); else if (last?.kind === 'gemx-image') drawSoma(last.result); else drawVideoFrame(); };
window.addEventListener('resize', () => { if (last?.kind === 'image') drawPoints(last.result.landmarks[0]); else drawVideoFrame(); });

// For tests: run the steps without clicks.
export const test = { poseGemx, poseFromFrame, trackVideo, buildKeys, last: () => last, models, targets, fit, image: () => poseImage, loadSomaTrack };
window.mocap = test;
