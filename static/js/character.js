// Your own character on the stage: a GLB (UE5 Manny-style, Mixamo or VRM
// naming) rendered with three.js on a canvas over the 2D stage, driven by
// the clip through a rest-aligned rotation retarget. A preview, not the
// Unreal retarget: twist and finger detail are not carried.
import * as THREE from '../vendor/three.module.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import * as viewer from './viewer.js';

const $ = s => document.querySelector(s);
const stage = $('#view'), overlay = $('#view3d');
const renderer = new THREE.WebGLRenderer({ canvas: overlay, alpha: true, antialias: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0); // transparent: the 2D stage shows through wherever nothing is drawn
renderer.clear();
const scene = new THREE.Scene();
// Studio lighting for a black glossy doll on a grey stage: a warm key from the front-left
// that throws one soft shadow on the floor, a cool fill, two rims that trace the shells'
// edges, a neutral hemisphere, and a softbox environment (built below) so the gloss
// carries broad soft reflections instead of pinpoint highlights.
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
scene.add(new THREE.HemisphereLight(0xe6e9f0, 0x55565c, 1.5));
const key = new THREE.DirectionalLight(0xfff3e4, 3.6); key.position.set(2.5, 5, 3.5); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048); key.shadow.camera.near = .5; key.shadow.camera.far = 30; key.shadow.camera.left = key.shadow.camera.bottom = -6; key.shadow.camera.right = key.shadow.camera.top = 6; key.shadow.bias = -.0005; key.shadow.normalBias = .02; key.shadow.radius = 4;
scene.add(key); scene.add(key.target);
const rim = new THREE.DirectionalLight(0xffe4c8, 3.2); rim.position.set(-3, 3.2, -4); scene.add(rim);
const rim2 = new THREE.DirectionalLight(0xd6e4ff, 2.8); rim2.position.set(3, 2.4, -4); scene.add(rim2);
const fill = new THREE.DirectionalLight(0xd0dcf0, 1.0); fill.position.set(-2.5, 1.5, 3); scene.add(fill);
// The floor only shows the shadow (the 2D stage draws the grid underneath). DoubleSide
// because the stage's view matrix mirrors z (see syncCamera), which flips the winding
// that front-face culling relies on; the doll's shells are DoubleSide for the same reason.
const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: .45, side: THREE.DoubleSide }));
floor.rotation.x = -Math.PI / 2; floor.position.y = .002; floor.receiveShadow = true; floor.frustumCulled = false; scene.add(floor);
// Softbox environment: a dim grey room with a wide top light, a tall key panel front-left,
// a cooler panel on the right and a strip behind, prefiltered so every glossy shell
// reflects it. Reflections, not albedo, are what make a black doll read as a form.
function studioEnvironment() {
  const room = new THREE.Scene();
  const box = (w, h, d, colour, x, y, z, ry = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: colour })); m.position.set(x, y, z); m.rotation.y = ry; room.add(m); };
  room.add(new THREE.Mesh(new THREE.BoxGeometry(14, 10, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(.12, .12, .13), side: THREE.BackSide })));
  box(5, .1, 5, new THREE.Color(1.9, 1.87, 1.8), 0, 4.9, 0);             // top softbox
  box(.1, 4, 2.5, new THREE.Color(2.2, 2.05, 1.85), -6.9, 2.2, 2.5, 0);   // key panel, front-left
  box(.1, 3, 2, new THREE.Color(.9, 1.0, 1.2), 6.9, 1.8, 1.5, 0);          // cool fill panel, right
  box(5, 1.2, .1, new THREE.Color(1.3, 1.4, 1.6), 0, 2.6, -6.9, 0);        // rim strip, behind
  box(4, .1, 4, new THREE.Color(.3, .3, .32), 0, -4.9, 0);                 // a touch of floor bounce
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(room, .04).texture;
    pmrem.dispose();
    return env;
  } catch (e) { console.warn('stage environment skipped', e); return null; }
}
scene.environment = studioEnvironment();
export const stageLights = { scene, renderer, key, floor }; // for stage inspection scripts
const camera = new THREE.PerspectiveCamera(); camera.matrixAutoUpdate = false;
export const stageCamera = camera; // for stage inspection scripts

const state = { model: null, bones: {}, rest: {}, mapped: [], hips: null, fit: true, showSkeleton: false, scaleToKimodo: 1, hipsRestHeight: 1,
  // 'match': every mapped joint sits exactly on the clip's joint and each shell stretches to span
  // the gap (body and skeleton in sync by construction); 'doll': the body keeps its own proportions.
  fitMode: 'doll', scaleMatch: 1, axis: {} }; // default: the doll as modelled in Blender (owner's ruling)
export const character = state;

// SOMA joint → names seen on common rigs (normalised: lower-case, no prefix).
const NAMES = {
  Hips: ['hips', 'pelvis'],
  Spine1: ['spine', 'spine_01', 'spine1', 'spine01'],
  Spine2: ['spine1', 'spine_02', 'spine_03', 'spine2', 'spine02', 'chest'],
  Chest: ['spine2', 'spine_03', 'spine_05', 'spine3', 'upperchest', 'upper_chest'],
  Neck1: ['neck', 'neck_01', 'neck1'],
  Neck2: ['neck_02', 'neck2'],
  Head: ['head'],
  LeftShoulder: ['leftshoulder', 'clavicle_l', 'shoulder_l', 'l_shoulder', 'shoulderl'],
  LeftArm: ['leftarm', 'upperarm_l', 'upper_arm_l', 'l_upperarm', 'upper_arml'],
  LeftForeArm: ['leftforearm', 'lowerarm_l', 'lower_arm_l', 'forearm_l', 'forearml'],
  LeftHand: ['lefthand', 'hand_l', 'l_hand', 'handl'],
  LeftLeg: ['leftupleg', 'thigh_l', 'upper_leg_l', 'upperleg_l', 'thighl'],
  LeftShin: ['leftleg', 'calf_l', 'lower_leg_l', 'lowerleg_l', 'shin_l', 'shinl'],
  LeftFoot: ['leftfoot', 'foot_l', 'l_foot', 'footl'],
  LeftToeBase: ['lefttoebase', 'ball_l', 'toes_l', 'toe_l', 'toel'],
  RightShoulder: ['rightshoulder', 'clavicle_r', 'shoulder_r', 'r_shoulder', 'shoulderr'],
  RightArm: ['rightarm', 'upperarm_r', 'upper_arm_r', 'r_upperarm', 'upper_armr'],
  RightForeArm: ['rightforearm', 'lowerarm_r', 'lower_arm_r', 'forearm_r', 'forearmr'],
  RightHand: ['righthand', 'hand_r', 'r_hand', 'handr'],
  RightLeg: ['rightupleg', 'thigh_r', 'upper_leg_r', 'upperleg_r', 'thighr'],
  RightShin: ['rightleg', 'calf_r', 'lower_leg_r', 'lowerleg_r', 'shin_r', 'shinr'],
  RightFoot: ['rightfoot', 'foot_r', 'r_foot', 'footr'],
  RightToeBase: ['righttoebase', 'ball_r', 'toes_r', 'toe_r', 'toer'],
};
// Rigify's spine is one chain, "spine" being the pelvis: map it by position in the chain.
function rigifySpine(bones) {
  if (!bones['spine'] || !bones['spine003']) return null;
  const chain = ['spine', 'spine001', 'spine002', 'spine003', 'spine004', 'spine005', 'spine006'].filter(n => bones[n]);
  const map = { Hips: bones['spine'] };
  const head = chain[chain.length - 1], neck = chain[chain.length - 2];
  map.Head = bones[head];
  map.Neck1 = bones[neck];
  const body = chain.slice(1, -2); // spine.00x between pelvis and neck
  if (body.length >= 1) map.Spine1 = bones[body[0]];
  if (body.length >= 3) map.Spine2 = bones[body[1]];
  if (body.length >= 2) map.Chest = bones[body[body.length - 1]];
  return map;
}
// Which SOMA joint continues each chain (for aligning rest directions).
const NEXT = { Hips: 'Spine1', Spine1: 'Spine2', Spine2: 'Chest', Chest: 'Neck1', Neck1: 'Neck2', Neck2: 'Head', LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftLeg: 'LeftShin', LeftShin: 'LeftFoot', LeftFoot: 'LeftToeBase', RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightLeg: 'RightShin', RightShin: 'RightFoot', RightFoot: 'RightToeBase' };
const MATCH_RIGID = new Set(['LeftFoot', 'RightFoot', 'LeftShoulder', 'RightShoulder', 'Neck1']); // match mode: never aimed or stretched
// Sockets stay the doll's own: these joints sit where their parent shell carries them
// (rigidly, at rest offset), and the limb bone below stretches to reach the clip's next joint.
const MATCH_SOCKET = { LeftShoulder: 'Chest', RightShoulder: 'Chest', LeftArm: 'LeftShoulder', RightArm: 'RightShoulder', LeftLeg: 'Hips', RightLeg: 'Hips', Head: 'Neck1' };
// The torso keeps the doll's own shape: spine joints are carried up the chain at the doll's
// rest offsets, uniformly scaled so that the doll's hips→neck spans from the placed pelvis to
// the clip's neck joint (the ratio is per frame: the pelvis sits lower than SOMA's hips).
const MATCH_TORSO = {};
const MATCH_UNIFORM = new Set(['Hips', 'Spine1', 'Chest']);
const SWING_ONLY = new Set(['LeftArm', 'RightArm', 'LeftLeg', 'RightLeg']); // torso shells scale uniformly: a taller chest is also a wider one
const MATCH_FOLLOW = new Set(['LeftToeBase', 'RightToeBase']); // match mode: not placed, follow their parent by FK
const normalise = n => n.toLowerCase().replace(/[.:\s]/g, '').replace(/^mixamorig_?/, '').replace(/^(j_bip_[clr]_|def-|cc_base_|bip001)/, '');

function fitOverlay() {
  if (overlay.width !== stage.width || overlay.height !== stage.height) { overlay.width = stage.width; overlay.height = stage.height; renderer.setSize(stage.width, stage.height, false); }
}

// Camera: the 2D stage's projection, rebuilt as view + projection matrices.
function syncCamera() {
  const v = viewer.getView(), W = stage.width, H = stage.height, s = viewer.scale(), f = v.cameraZoom * s * viewer.liftScale();
  const T1 = new THREE.Matrix4().makeTranslation(-v.cameraX, 0, -v.cameraZ);
  const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw), cp = Math.cos(v.pitch), sp = Math.sin(v.pitch);
  const Ry = new THREE.Matrix4().set(cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1);
  const Rx = new THREE.Matrix4().set(1, 0, 0, 0, 0, cp, -sp, 0, 0, sp, cp, 0, 0, 0, 0, 1);
  const T2 = new THREE.Matrix4().makeTranslation(0, 0, 8);
  const flip = new THREE.Matrix4().makeScale(-1, 1, -1); // the stage looks down +z, three.js down -z; x as the stage's cameraSpace (not mirror-imaged)
  const view = new THREE.Matrix4().multiplyMatrices(flip, new THREE.Matrix4().multiplyMatrices(T2, new THREE.Matrix4().multiplyMatrices(Rx, new THREE.Matrix4().multiplyMatrices(Ry, T1))));
  camera.matrixWorldInverse.copy(view);
  camera.matrixWorld.copy(view).invert();
  const near = .05, far = 200;
  const ox = 2 * (viewer.anchorXFrac() * W - W / 2 + v.panX * s) / W, oy = 1 - 2 * (H * viewer.anchorFrac() + v.panY * s) / H;
  camera.projectionMatrix.set(
    2 * f / W, 0, -ox, 0,
    0, 2 * f / H, -oy, 0,
    0, 0, -(far + near) / (far - near), -2 * far * near / (far - near),
    0, 0, -1, 0);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

// The doll was exported with its left index finger extended (every other finger
// curls ~25° per knuckle). Any finger whose mirror twin curls more takes the twin's
// local rotations mirrored: Rigify's L/R bones mirror as (x, -y, -z, w).
function relaxFingers(model) {
  const byName = {};
  model.traverse(o => { if (o.isBone) byName[o.name] = o; });
  for (const f of ['thumb', 'f_index', 'f_middle', 'f_ring', 'f_pinky']) {
    const chain = side => ['01', '02', '03'].map(s => byName[`DEF-${f}${s}${side}`]).filter(Boolean);
    const L = chain('L'), R = chain('R');
    if (L.length < 3 || R.length < 3) continue;
    const curl = c => c.slice(1).reduce((a, b) => a + 2 * Math.acos(Math.min(1, Math.abs(b.quaternion.w))), 0);
    const cl = curl(L), cr = curl(R);
    if (Math.abs(cl - cr) < 0.17) continue; // twins agree within 10°
    const [from, to] = cl < cr ? [R, L] : [L, R];
    from.forEach((b, i) => to[i].quaternion.set(b.quaternion.x, -b.quaternion.y, -b.quaternion.z, b.quaternion.w));
  }
}
let defaultGLB = null; // the doll's bytes, kept so every actor can get a body
export async function load(file, { isDefault = false } = {}) {
  clear();
  usingDefaultBody = isDefault;
  const bytes = await file.arrayBuffer();
  if (isDefault) defaultGLB = bytes;
  const gltf = await new GLTFLoader().parseAsync(bytes.slice(0), '');
  const model = gltf.scene;
  const body = state;
  prepareBody(model, isDefault, body, file);
  $('#characterHint').textContent = `${isDefault ? 'Understudy body' : file.name}: ${state.mapped.length}/23 joints mapped · hips ${state.hipsRestHeight.toFixed(2)} m${state.hingeAligned ? ` · ${state.hingeAligned} hinges aligned` : ''}`;
  $('#characterBar').hidden = false;
  viewer.setCharacterShown(true, state.showSkeleton);
  if (!isDefault) startTransition(1);
  viewer.draw();
}
// Build a posable body out of a loaded GLB scene: bone map, rest pose, scale, rest alignment.
function prepareBody(model, isDefault, body, file) {
  // Outline shells (inverted hulls for a toon look) only darken the figure here; the
  // default body gets a glossy dark grey so it reads against the stage.
  // The doll as it reads in the owner's Blender viewport: black shells under studio light, soft highlights.
  const glossy = new THREE.MeshStandardMaterial({ color: 0x1c1c21, roughness: .48, metalness: .08, side: THREE.DoubleSide, emissive: new THREE.Color(body.tint || 0x000000), emissiveIntensity: body.tint ? .22 : 0 });
  model.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.every(m => /outline/i.test(m?.name || ''))) { o.visible = false; return; }
    if (isDefault) o.material = Array.isArray(o.material) ? o.material.map(m => /outline/i.test(m?.name || '') ? new THREE.MeshBasicMaterial({ visible: false }) : glossy) : glossy;
    else for (const m of mats) if (m) m.side = THREE.DoubleSide;
    o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; // self-shadow: a hand at the face shades the face
  });
  scene.add(model);
  body.isDefault = isDefault; body.model = model;
  if (isDefault) relaxFingers(model);
  body.fingerRest = new Map(); model.traverse(o => { if (o.isBone && fingerOf(o.name)) body.fingerRest.set(o, o.quaternion.clone()); });
  body.fingerAxis = model.getObjectByName('index_01_l') ? FINGER_AXIS_UE : new THREE.Vector3(1, 0, 0);
  model.updateMatrixWorld(true);
  // Bones by normalised name.
  const bones = {};
  model.traverse(o => { if (o.isBone) bones[normalise(o.name)] = o; });
  // A body rigged to Understudy's own skeleton (the Blender "Understudy Skeleton" scene) uses the exact joint
  // names: map them 1:1 before any name guessing, since SOMA's LeftLeg is the thigh and Mixamo's is the shin.
  const exactNames = ['Hips', 'Spine1', 'Spine2', 'Chest', 'Neck1', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftLeg', 'LeftShin', 'LeftFoot', 'RightLeg', 'RightShin', 'RightFoot'];
  const byExact = {}; model.traverse(o => { if (o.isBone) byExact[o.name] = o; });
  const isSoma = exactNames.every(n => byExact[n]);
  const map = isSoma ? Object.fromEntries(Object.keys(NAMES).filter(n => byExact[n]).map(n => [n, byExact[n]])) : (rigifySpine(bones) || {});
  for (const [soma, candidates] of Object.entries(NAMES)) { if (map[soma]) continue; for (const c of candidates) if (bones[c]) { map[soma] = bones[c]; break; } }
  if (!map.Hips || !map.LeftArm || !map.LeftLeg) { scene.remove(model); throw new Error(`could not find a humanoid rig (hips/arm/leg) among ${Object.keys(bones).length} bones`); }
  body.bones = map;
  // Rest pose in world space.
  const rest = {};
  for (const [soma, bone] of Object.entries(map)) rest[soma] = { q: bone.getWorldQuaternion(new THREE.Quaternion()), p: bone.getWorldPosition(new THREE.Vector3()), local: bone.quaternion.clone(), pos: bone.position.clone() };
  body.exactKey = null; body.exact = false; // decided against the clip skeleton in poseRig (checkExact)
  // Scale: this rig's hips height against Kimodo's standing hips (0.988 m rest).
  const hipsY = rest.Hips.p.y - lowestPoint(model);
  body.hipsRestHeight = hipsY || 1;
  body.scaleToKimodo = 0.988 / body.hipsRestHeight;
  // Rest alignment: rotate each target bone's rest so its direction to the next joint matches SOMA's.
  const src = somaRest();
  // Match mode: shells are sized from the hip-joint height (the hips bone origin varies by rig);
  // each bone remembers which local axis runs to its next mapped joint, and how long that is at rest.
  const legRest = rest.LeftLeg || rest.RightLeg, legSrc = src.LeftLeg || src.RightLeg;
  const headRest = rest.Head, headSrc = src.Head, low = lowestPoint(model);
  body.scaleMatch = headRest && headSrc && headRest.p.y - low > 0.5 ? headSrc.y / (headRest.p.y - low) // same height as the clip's skeleton: the reference view's scale
    : legRest && legSrc && legRest.p.y > 0.05 ? legSrc.y / legRest.p.y : body.scaleToKimodo;
  body.somaAnkleY = (src.LeftFoot || src.RightFoot)?.y ?? 0.05;
  body.torsoRatio = rest.Neck1 && src.Neck1 ? src.Neck1.clone().sub(src.Hips).length() / (rest.Neck1.p.clone().sub(rest.Hips.p).length() * body.scaleMatch) : 1;
  body.axis = {};
  for (const soma of Object.keys(map)) {
    // Feet are not aimed at the clip's toe joint: that landmark sits elsewhere on a doll's
    // foot shell, so aiming pitched the foot. They keep their rest pitch + the clip's
    // ankle motion (DELTA_ONLY) and their own length; the toes ride along by FK.
    if (MATCH_RIGID.has(soma)) continue;
    let next = NEXT[soma]; while (next && !map[next]) next = NEXT[next];
    if (!next) continue;
    const d = rest[next].p.clone().sub(rest[soma].p), len = d.length(); if (len < 1e-4) continue;
    const local = d.clone().applyQuaternion(rest[soma].q.clone().invert());
    const ax = [Math.abs(local.x), Math.abs(local.y), Math.abs(local.z)], i = ax.indexOf(Math.max(...ax));
    const unit = new THREE.Vector3(); unit.setComponent(i, Math.sign(local.getComponent(i)) || 1);
    body.axis[soma] = { next, i, unit, restLen: len };
  }
  // Rest alignment, walked down each chain: the root takes a full frame
  // correction (direction and up, so the whole rig stands the same way), and
  // every child adds only the smallest rotation that bends its rest direction
  // onto SOMA's, on top of its parent's correction. Roll therefore stays
  // continuous along arms and legs instead of each bone twisting on its own.
  const frameOf = dir => {
    const d = dir.clone().normalize();
    let u = new THREE.Vector3(0, 1, 0);
    if (Math.abs(d.dot(u)) > .9) u = new THREE.Vector3(0, 0, 1);
    u = u.sub(d.clone().multiplyScalar(d.dot(u))).normalize();
    return new THREE.Matrix4().makeBasis(d, u, new THREE.Vector3().crossVectors(d, u));
  };
  // Hinge axes. Kimodo's elbow/knee axis is the dominant rotation axis of the
  // forearm/shin joint across the clip (in the parent's rest frame = world at
  // SOMA rest). The doll's is the child bone's rest local X (Rigify bends
  // limbs about X). Aligning the upper arm / thigh frame on (direction, hinge)
  // puts both hinges on the same axis, so the elbow and knee pieces stay shut.
  const flexionAxis = childSoma => {
    const { names, parents } = viewer.skeleton, rot = viewer.state.rotations, anim = viewer.state.animation;
    const j = names.indexOf(childSoma); if (j < 0 || !rot || !anim) return null;
    const joints = parents.length, sum = new THREE.Vector3();
    for (let f = 0; f < anim.frames; f++) {
      const at = (f * joints + j) * 4, x = rot[at], y = rot[at + 1], z = rot[at + 2], w = rot[at + 3];
      const sinHalf = Math.sqrt(x * x + y * y + z * z); if (sinHalf < 1e-6) continue;
      const angle = 2 * Math.atan2(sinHalf, w);
      sum.add(new THREE.Vector3(x, y, z).multiplyScalar(angle / sinHalf)); // axis × signed angle
    }
    return sum.length() > .5 ? sum.normalize() : null;
  };
  const HINGES = { LeftArm: 'LeftForeArm', RightArm: 'RightForeArm', LeftLeg: 'LeftShin', RightLeg: 'RightShin' };
  // End pieces whose landmarks differ between rigs (a doll's toe bone is not where SOMA's is):
  // they take their parent's correction only and move by the clip's joint delta from their own rest.
  const DELTA_ONLY = new Set(['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase', 'LeftHand', 'RightHand', 'Head']);
  const hingeFrame = (dir, hinge) => {
    const d = dir.clone().normalize();
    const h = hinge.clone().sub(d.clone().multiplyScalar(d.dot(hinge))).normalize();
    return new THREE.Matrix4().makeBasis(d, h, new THREE.Vector3().crossVectors(d, h));
  };
  const forward = new THREE.Vector3(0, 0, 1);
  const align = {};
  const parentOf = soma => parentSoma(soma, body);
  const order = Object.keys(map).sort((a, b) => depthOf(a, body) - depthOf(b, body));
  let hingeAligned = 0;
  for (const soma of order) {
    if (body.exact) { align[soma] = new THREE.Quaternion(); continue; } // exact rig: the clip's rotations apply as they are
    const next = NEXT[soma], parent = parentOf(soma);
    const base = parent && align[parent] ? align[parent].clone() : new THREE.Quaternion();
    if (DELTA_ONLY.has(soma)) { align[soma] = base; continue; }
    if (next && map[next] && src[next]) {
      const dt = rest[next].p.clone().sub(rest[soma].p).normalize(), ds = src[next].clone().sub(src[soma]).normalize();
      const childSoma = HINGES[soma];
      const hs = childSoma && map[childSoma] ? flexionAxis(childSoma) : null;
      if (hs) {
        // Doll hinge: the child bone's rest local X in world; sign chosen so both bend the same way relative to forward.
        let ht = new THREE.Vector3(1, 0, 0).applyQuaternion(rest[childSoma].q);
        const sideS = Math.sign(new THREE.Vector3().crossVectors(ds, hs).dot(forward)) || 1;
        const sideT = Math.sign(new THREE.Vector3().crossVectors(dt, ht).dot(forward)) || 1;
        if (sideS !== sideT) ht.negate();
        align[soma] = new THREE.Quaternion().setFromRotationMatrix(hingeFrame(ds, hs).multiply(hingeFrame(dt, ht).invert()));
        hingeAligned++;
      } else if (!parent || !align[parent]) {
        align[soma] = new THREE.Quaternion().setFromRotationMatrix(frameOf(ds).multiply(frameOf(dt).invert()));
      } else {
        const bent = dt.clone().applyQuaternion(base);
        align[soma] = new THREE.Quaternion().setFromUnitVectors(bent, ds).multiply(base);
      }
    } else align[soma] = base;
  }
  body.hingeAligned = hingeAligned;
  for (const soma of Object.keys(map)) if (!align[soma]) align[soma] = (align[parentSoma(soma, body)] || new THREE.Quaternion());
  Object.assign(body, { model, bones: map, rest, align, hips: map.Hips, mapped: Object.keys(map) });
  // Pivot bones ("LeftFootPivot", "LeftToeBasePivot"…): helper bones placed where the body's own joint is (a doll
  // ankle ball sits higher than the skeleton's ankle). Each copies its target joint's world rotation, so the part
  // turns about its own visible joint and stays one rigid piece. Half bones ("LeftLegHalf") turn halfway between the
  // joint's parent and the joint: the hip's skin band rides on them so a deep hip bend neither tears nor collapses.
  // Parents come before children.
  body.pivots = [];
  model.traverse(o => { if (!o.isBone) return; const m = /^(.+)(Pivot|Half)$/.exec(o.name); if (!m || !map[m[1]]) return;
    body.pivots.push({ bone: o, target: m[1], kind: m[2] === 'Half' ? 'half' : 'pivot', restQ: o.getWorldQuaternion(new THREE.Quaternion()), depth: (() => { let d = 0, q = o; while (q.parent) { d++; q = q.parent; } return d; })() }); });
  body.pivots.sort((x, y) => x.depth - y.depth);
  // Foot pivots keep their shoe's sole points (in the foot pivot's frame) to keep a planted shoe out of the floor. The toe
  // piece is left out: tipping the shoe to lift a pointed toe would lift the ball of the foot off a planted skeleton toe.
  model.updateMatrixWorld(true);
  for (const pv of body.pivots) if (/Foot$/.test(pv.target)) pv.sole = solePoints(model, pv.bone);
  body.headCentre = headCentreOf(model, map.Head);
  applyFit(body);
}
// The centre of the skull in the Head bone's own frame: the head shell's bounding box at rest
// (the shell skinned mostly to the Head bone). Falls back to a point a little up the bone.
function headCentreOf(model, head) {
  if (!head) return null;
  let best = null, bestShare = 0;
  model.traverse(o => {
    if (!o.isSkinnedMesh || !o.skeleton) return;
    const idx = o.geometry.getAttribute('skinIndex'); if (!idx) return;
    const h = o.skeleton.bones.indexOf(head); if (h < 0) return;
    let n = 0; for (let i = 0; i < idx.count; i++) if (idx.getX(i) === h) n++;
    const share = n / idx.count;
    if (share > bestShare) { bestShare = share; best = o; }
  });
  if (!best || bestShare < .5) return null; // one-piece bodies: the skull centre is taken from the clip's own head offset
  best.geometry.computeBoundingBox();
  const centre = best.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(best.matrixWorld);
  head.updateWorldMatrix(true, false);
  return head.worldToLocal(centre);
}
// A second body for another actor on the stage, from the same doll.
const actorBodies = new Map();
async function spawnBody(label, tint) {
  if (!defaultGLB || actorBodies.has(label)) return actorBodies.get(label) || null;
  actorBodies.set(label, { loading: true });
  try {
    const gltf = await new GLTFLoader().parseAsync(defaultGLB.slice(0), '');
    const body = { model: null, bones: {}, rest: {}, mapped: [], hips: null, fit: true, scaleToKimodo: 1, hipsRestHeight: 1, fitMode: state.fitMode, scaleMatch: 1, axis: {}, tint, label };
    relaxFingers(gltf.scene);
    prepareBody(gltf.scene, true, body, null);
    actorBodies.set(label, body);
    viewer.draw();
    return body;
  } catch (e) { actorBodies.delete(label); lastSpawnError = String(e && e.stack || e); console.warn('actor body', e); return null; }
}
export let lastSpawnError = '';
export const spawnActorBody = spawnBody;
function dropBody(label) { const b = actorBodies.get(label); if (b?.model) scene.remove(b.model); actorBodies.delete(label); }
function parentSomaRaw(soma) { for (const [k, v] of Object.entries(NEXT)) if (v === soma) return k; return { LeftShoulder: 'Chest', RightShoulder: 'Chest', LeftLeg: 'Hips', RightLeg: 'Hips' }[soma] || null; }
function parentSoma(soma, body = state) { let p = parentSomaRaw(soma); while (p && body.bones && !body.bones[p]) p = parentSomaRaw(p); return p; }
function depthOf(soma, body = state) { let d = 0, p = parentSoma(soma, body); while (p) { d++; p = parentSoma(p, body); } return d; }
function lowestPoint(model) { const box = new THREE.Box3().setFromObject(model); return box.min.y; }
function somaRest() {
  const { parents, offsets, names } = viewer.skeleton;
  const out = {}, global = [];
  for (let j = 0; j < parents.length; j++) {
    const o = offsets[j], p = parents[j];
    global[j] = p < 0 ? new THREE.Vector3(0, 0.988, 0) : global[p].clone().add(new THREE.Vector3(o[0], o[1], o[2]));
    out[names[j]] = global[j];
  }
  return out;
}
function applyFit(body = state) { if (body.model) body.model.scale.setScalar(body.fit ? body.scaleToKimodo : 1); body.model?.updateMatrixWorld(true); }
export function setFit(on) { state.fit = on; applyFit(state); viewer.draw(); }
// The doll as a skeleton: one world position per clip joint (its mapped bone; hand ends from the
// middle-finger / thumb tips; anything unmapped falls back to the clip's own joint), and the finger
// bones as segments. The X-ray figure is drawn from this, so it always sits inside the shells.
const HAND_END = { LeftHandMiddleEnd: ['DEF-f_middle03L', 'middle_02_l'], RightHandMiddleEnd: ['DEF-f_middle03R', 'middle_02_r'], LeftHandThumbEnd: ['DEF-thumb03L', 'thumb_02_l'], RightHandThumbEnd: ['DEF-thumb03R', 'thumb_02_r'] };
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
function dollSkeleton() {
  const body = state; if (!body.model || !body.bones || !viewer.isBodyShown()) return null;
  const names = viewer.skeleton.names, pose = viewer.pose(); if (!pose?.length) return null;
  const byName = {}; body.model.traverse(o => { if (o.isBone) byName[o.name] = o; });
  const tip = bone => { // a Rigify bone's tail: its origin plus its length along local Y
    const p = bone.getWorldPosition(tmpV.clone()); const child = bone.children.find(c => c.isBone);
    if (child) return child.getWorldPosition(tmpV2.clone());
    const len = bone.userData.length ?? (bone.children[0]?.position.length() || .02);
    return p.add(new THREE.Vector3(0, len, 0).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())));
  };
  const { parents } = viewer.skeleton;
  const dollAt = j => body.bones[names[j]] ? body.bones[names[j]].getWorldPosition(new THREE.Vector3()).toArray() : null;
  const joints = names.map((n, j) => {
    if (body.bones[n]) return dollAt(j);
    const end = HAND_END[n]?.find(b => byName[b]); if (end) return tip(byName[end]).toArray();
    // unmapped (Spine2, Neck2, Jaw, eyes…): the clip's offset from the nearest mapped ancestor, scaled by how
    // much shorter the doll's run from that ancestor to the next mapped joint is, carried from the doll's ancestor
    let a = parents[j]; while (a >= 0 && !body.bones[names[a]]) a = parents[a];
    if (a < 0) return pose[j];
    let d = -1; const queue = names.map((_, k) => k).filter(k => parents[k] === j);
    while (queue.length && d < 0) { const k = queue.shift(); if (body.bones[names[k]]) d = k; else queue.push(...names.map((_, m) => m).filter(m => parents[m] === k)); }
    const A = dollAt(a), sA = pose[a];
    let s = 1;
    if (d >= 0) { const D = dollAt(d), sD = pose[d]; const num = Math.hypot(D[0] - A[0], D[1] - A[1], D[2] - A[2]), den = Math.hypot(sD[0] - sA[0], sD[1] - sA[1], sD[2] - sA[2]); if (den > 1e-4) s = num / den; }
    return [A[0] + (pose[j][0] - sA[0]) * s, A[1] + (pose[j][1] - sA[1]) * s, A[2] + (pose[j][2] - sA[2]) * s];
  });
  const fingers = [];
  for (const [name, bone] of Object.entries(byName)) {
    if (!fingerOf(name)) continue;
    fingers.push([bone.getWorldPosition(new THREE.Vector3()).toArray(), tip(bone).toArray()]);
  }
  return { joints, fingers };
}
viewer.setBodySkeleton(dollSkeleton);
export function setShowSkeleton(on) {
  state.showSkeleton = on; viewer.setCharacterShown(!!state.model, on);
  for (const id of ['#characterSkeleton', '#xray']) { const el = $(id); if (el && el.checked !== on) el.checked = on; }
  if (!on) $('#xrayHint').textContent = '';
  state.model?.traverse(o => { if (o.isMesh) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m) m.needsUpdate = true; });
  viewer.draw();
}
// How far the body's joints sit from the clip's joints on this frame (the doll
// keeps its own limb lengths, so hands and feet drift by the proportion difference).
let syncAt = 0;
function reportSync() {
  const now = performance.now(); if (now - syncAt < 250) return; syncAt = now;
  const p = viewer.pose(), names = viewer.skeleton.names; if (!p?.length) return;
  const k = state.fit ? state.scaleToKimodo : 1, parts = [];
  for (const [label, somas] of [['elbows', ['LeftForeArm', 'RightForeArm']], ['hands', ['LeftHand', 'RightHand']], ['knees', ['LeftShin', 'RightShin']], ['toes', ['LeftToeBase', 'RightToeBase']], ['neck', ['Neck1']], ['head', ['Head']], ['shoulder sockets', ['LeftArm', 'RightArm']], ['hip sockets', ['LeftLeg', 'RightLeg']]]) {
    let worst = 0, any = false;
    for (const s of somas) { const b = state.bones[s], j = names.indexOf(s); if (!b || j < 0) continue; any = true; const w = b.getWorldPosition(new THREE.Vector3()); worst = Math.max(worst, Math.hypot(w.x - p[j][0], w.y - p[j][1], w.z - p[j][2])); }
    if (any) parts.push(`${label} ${(worst * 100).toFixed(1)} cm`);
  }
  $('#xrayHint').textContent = parts.length ? `· body vs skeleton: ${parts.join(', ')}` : '';
  void k;
}
export function hasActorBody(label) { const b = actorBodies.get(label); return !!b?.model && viewer.isBodyShown(); }
export function clear() {
  for (const label of [...actorBodies.keys()]) dropBody(label);
  if (state.model) scene.remove(state.model);
  Object.assign(state, { model: null, bones: {}, rest: {}, mapped: [], hips: null });
  $('#characterBar').hidden = true;
  viewer.setCharacterShown(false, true);
  renderer.clear();
}

// Pose the rig from the clip's current frame. Mapped bones are posed in SOMA
// order (parents first). A mapped bone that the exporter left at the armature
// root (Rigify parents some deform bones to control bones, which a deform-only
// export drops) also gets its position from its nearest mapped ancestor, so it
// travels with the body instead of staying at its rest spot.
const tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), tmpM = new THREE.Matrix4();
const HINGE_CHILD = { LeftForeArm: true, RightForeArm: true, LeftShin: true, RightShin: true };
// Clavicles take this share of the clip's shoulder swing. Kimodo's clavicles
// (16 cm) swing further than a doll's shoulder socket allows; the upper arm is
// posed from its own world rotation afterwards, so the arm still points right.
const CLAVICLE_DAMPING = 0.6;
const CLAVICLE = { LeftShoulder: 'Chest', RightShoulder: 'Chest' };
// Kimodo's clavicles rest 15–30° away from the skeleton's identity pose even
// when standing still, so the neutral is the clip's average clavicle, not the
// rest; only the deviation from that average moves the doll's shoulder.
const clavicleBaseline = { clipId: null, mean: {} };
function clavicleMean(src, soma) {
  const anim = src.animation, rot = src.rotations, names = viewer.skeleton.names;
  if (!anim || !rot) return new THREE.Quaternion();
  if (clavicleBaseline.clipId !== anim.id) { clavicleBaseline.clipId = anim.id; clavicleBaseline.mean = {}; }
  if (clavicleBaseline.mean[soma]) return clavicleBaseline.mean[soma];
  const j = names.indexOf(soma), J = names.length, acc = [0, 0, 0, 0];
  for (let f = 0; f < anim.frames; f++) {
    const at = (f * J + j) * 4; let q = [rot[at], rot[at + 1], rot[at + 2], rot[at + 3]];
    if (q[0] * acc[0] + q[1] * acc[1] + q[2] * acc[2] + q[3] * acc[3] < 0) q = q.map(v => -v);
    for (let k = 0; k < 4; k++) acc[k] += q[k];
  }
  const mean = new THREE.Quaternion(acc[0], acc[1], acc[2], acc[3]).normalize();
  clavicleBaseline.mean[soma] = mean;
  return mean;
}
function nearestMappedAncestor(body, soma, index) {
  const { parents, names } = viewer.skeleton;
  let j = parents[index[soma]];
  while (j >= 0) { if (body.bones[names[j]]) return names[j]; j = parents[j]; }
  return null;
}
// The stage clip as a pose source (override and live filters included).
function stageSource() {
  return { globals: viewer.globalRotations(), root: viewer.rootPosition(), pose: viewer.pose(), frame: viewer.state.frame, rotations: viewer.state.rotations, animation: viewer.state.animation };
}
// An exact rig (rest offsets equal to the clip skeleton's within 1.5 cm) is driven by plain FK: none of the
// compensations written for a mismatched doll. Checked against the clip's skeleton, so it is re-checked when that
// skeleton arrives or changes (a body can load before the first clip).
function checkExact(body) {
  const key = viewer.skeleton.names.join('|');
  if (!body.rest || body.exactKey === key) return;
  const srcR = somaRest(); let worst = 0, n = 0;
  for (const soma of Object.keys(body.bones || {})) { const p = parentSoma(soma, body); if (!p || !srcR[soma] || !srcR[p] || !body.rest[p] || !body.rest[soma]) continue;
    const dOld = body.rest[soma].p.clone().sub(body.rest[p].p), dSrc = srcR[soma].clone().sub(srcR[p]); worst = Math.max(worst, dOld.distanceTo(dSrc)); n++; }
  if (!n) return; // no clip skeleton yet: decide later
  body.exactKey = key; body.exact = n >= 15 && worst < 0.015; body.restWorst = worst;
  if (body.exact && body.align) for (const k of Object.keys(body.align)) body.align[k] = new THREE.Quaternion();
  if (body.exact) console.info(`body: exact rig (worst rest offset ${(worst * 100).toFixed(1)} cm over ${n} joints)`);
}
function poseRig(body, src) {
  checkExact(body);
  const { names } = viewer.skeleton;
  const globals = src.globals;
  const root = src.root;
  if (!globals || !root) return;
  const index = {}; names.forEach((n, i) => { index[n] = i; });
  const k = body.fit ? body.scaleToKimodo : 1;             // model scale applied to rest offsets
  const travel = body.fit ? 1 : body.hipsRestHeight / 0.988; // how far the rig travels per clip metre
  const order = body.mapped.filter(soma => index[soma] != null).sort((a, b) => index[a] - index[b]);
  const desired = {}; // world rotation each mapped bone should end up with (match mode re-derives locals from it)
  for (const soma of order) {
    const bone = body.bones[soma], parent = bone.parent;
    parent.updateWorldMatrix(true, false);
    const parentWorldQ = parent.getWorldQuaternion(tmpQ.clone());
    const g = globals[index[soma]];
    let worldQ = new THREE.Quaternion(g[0], g[1], g[2], g[3]).multiply(body.align[soma]).multiply(body.rest[soma].q);
    if (CLAVICLE[soma] && body.bones[CLAVICLE[soma]] && !body.exact) {
      // Neutral = the doll's own rest clavicle carried by the chest. Motion = Kimodo's
      // clavicle deviation from its clip average (a chest-local rotation), turned into
      // a world rotation through the chest's current pose, damped.
      const chestSoma = CLAVICLE[soma], chest = body.bones[chestSoma];
      chest.updateWorldMatrix(true, false);
      const chestWorld = chest.getWorldQuaternion(new THREE.Quaternion());
      const base = chestWorld.clone().multiply(body.rest[chestSoma].q.clone().invert()).multiply(body.rest[soma].q);
      const j = index[soma], J = names.length, f = src.frame, at = (f * J + j) * 4, rot = src.rotations;
      const local = new THREE.Quaternion(rot[at], rot[at + 1], rot[at + 2], rot[at + 3]);
      const deviation = local.multiply(clavicleMean(src, soma).clone().invert());           // chest-local, from the clip's neutral
      const gc = globals[index[chestSoma]], chestSrc = new THREE.Quaternion(gc[0], gc[1], gc[2], gc[3]);
      const deviationWorld = chestSrc.clone().multiply(deviation).multiply(chestSrc.clone().invert());
      const damped = new THREE.Quaternion().slerp(deviationWorld, CLAVICLE_DAMPING);
      worldQ = damped.multiply(base);
    }
    bone.quaternion.copy(parentWorldQ.clone().invert().multiply(worldQ));
    // Elbows and knees are hinges on this kind of body: keep only the rotation
    // about the hinge (the bone's rest local X) and drop twist and deviation.
    // The hand/foot are posed from their own world rotation afterwards, so the
    // twist shows up at the wrist/ankle swivel instead of opening the joint.
    if (HINGE_CHILD[soma] && parent.isBone && body.exact) {
      // swing only: the forearm/shin points exactly where the clip's does, but does not spin about its own axis
      const restLocal = body.rest[soma].local;
      const delta = bone.quaternion.clone().multiply(restLocal.clone().invert());
      const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(restLocal).normalize(); // the bone's own axis in the parent's frame
      const d = delta.x * axis.x + delta.y * axis.y + delta.z * axis.z;
      const twist = new THREE.Quaternion(axis.x * d, axis.y * d, axis.z * d, delta.w).normalize();
      bone.quaternion.copy(delta.multiply(twist.invert()).multiply(restLocal));
    }
    if (HINGE_CHILD[soma] && parent.isBone && !body.exact) {
      const restLocal = body.rest[soma].local;
      const delta = bone.quaternion.clone().multiply(restLocal.clone().invert()); // from rest, in the parent's frame
      const h = new THREE.Vector3(1, 0, 0).applyQuaternion(restLocal).normalize();
      const dot = delta.x * h.x + delta.y * h.y + delta.z * h.z;
      const twist = new THREE.Quaternion(h.x * dot, h.y * dot, h.z * dot, delta.w).normalize();
      bone.quaternion.copy(twist.multiply(restLocal));
    }
    desired[soma] = parentWorldQ.clone().multiply(bone.quaternion);
    let worldPos = null;
    if (soma === 'Hips') {
      worldPos = new THREE.Vector3(root[0] * travel, root[1] * travel, root[2] * travel);
    } else if (!parent.isBone) {
      const anc = nearestMappedAncestor(body, soma, index);
      if (anc) {
        const A = body.bones[anc];
        A.updateWorldMatrix(true, false);
        const Apos = A.getWorldPosition(new THREE.Vector3()), AQ = A.getWorldQuaternion(new THREE.Quaternion());
        const delta = AQ.multiply(body.rest[anc].q.clone().invert());
        const off = body.rest[soma].p.clone().sub(body.rest[anc].p).multiplyScalar(k).applyQuaternion(delta);
        worldPos = Apos.add(off);
      }
    }
    if (worldPos) {
      const parentInv = tmpM.copy(parent.matrixWorld).invert();
      bone.position.copy(worldPos.applyMatrix4(parentInv));
    }
    if (!bone.matrixAutoUpdate) { bone.scale.set(1, 1, 1); bone.updateMatrix(); } // match mode froze it last frame
  }
  poseFingers(body, src);
  body.model.updateMatrixWorld(true);
  matchSkeleton(body, src, order, index, desired, (body === state ? state.fitMode : state.fitMode) === 'match');
  posePivots(body);
}

// Hands. Kimodo has no finger joints, so the doll's fingers are posed here: a
// few hand shapes as extra curl per knuckle (about the finger's own X, the axis
// the doll's knuckles bend on), chosen per hand per frame and eased so they
// don't snap. "auto" makes a fist when the hand is travelling fast (a punch,
// a swing) and relaxes otherwise.
// A finger bone by name: Rigify's DEF-f_index01L … and UE5's index_01_l … (metacarpals are not knuckles).
function fingerOf(name) {
  let m = /^DEF-(f_index|f_middle|f_ring|f_pinky|thumb)0([123])([LR])$/.exec(name);
  if (m) return { finger: m[1].replace('f_', ''), knuckle: Number(m[2]) - 1, side: m[3] };
  m = /^(index|middle|ring|pinky|thumb)_0([123])_([lr])$/.exec(name);
  if (m) return { finger: m[1], knuckle: Number(m[2]) - 1, side: m[3].toUpperCase() };
  return null;
}
const FINGER_AXIS_UE = new THREE.Vector3(0, 0, 1); // UE5 finger bones bend about their local Z (checked on the UEFN mannequin)
const HAND_POSES = { // extra degrees on [knuckle 01, 02, 03] for fingers, and for the thumb
  relaxed: { f: [10, 16, 12], t: [3, 8, 6] }, // a resting hand curls a little; dead-straight fingers read as a mannequin
  fist: { f: [38, 50, 42], t: [8, 22, 20] }, // a loose fist: knuckles read, the thumb lies over the fingers instead of sinking in
  open: { f: [-18, -22, -22], t: [-8, -5, -5] },
  point: { f: [40, 55, 45], t: [10, 35, 30], index: [-18, -22, -22] },
  flat: { f: [-18, -25, -25], t: [-8, -5, -5] },
};
const hands = { mode: localStorage.getItem('understudy.hands') || 'auto', curl: { L: 0, R: 0 }, shape: { L: 'relaxed', R: 'relaxed' } };
// the prompt-shape cache is per clip id, shared by every body
export function setHands(mode) { hands.mode = HAND_POSES[mode] || mode === 'auto' ? mode : 'auto'; localStorage.setItem('understudy.hands', hands.mode); viewer.draw(); }
const PROMPT_FIST = /(punch|punches|jab|cross|hook|uppercut|boxing|boxer|fight|fights|fighting|guard|spar|spars|brawl|grab|grabs|hold|holds|holding|grip|carry|carries|sword|bat|staff|axe|club|hammer|pull|pulls|drag|climb|climbs|hang)/i;
const PROMPT_OPEN = /(wave|waves|push|pushes|slap|slaps|clap|claps|catch|catches|open hands?|palms?|high.?five|block|blocks|cast|casts|spell)/i;
let promptShapeCache = { id: null, shape: 'relaxed' };
function promptHandShapeOf(a) {
  if (!a) return 'relaxed';
  if (promptShapeCache.id !== a.id) {
    const text = `${a.actor_prompt || ''} ${a.prompt || ''} ${(a.segments || []).map(s => s.prompt).join(' ')}`;
    promptShapeCache = { id: a.id, shape: PROMPT_FIST.test(text) ? 'fist' : PROMPT_OPEN.test(text) ? 'open' : 'relaxed' };
  }
  return promptShapeCache.shape;
}
function handSpeed(side) { // m/s of the wrist over the surrounding frames of the clip
  const names = viewer.skeleton.names, j = names.indexOf(side === 'L' ? 'LeftHand' : 'RightHand'); if (j < 0) return 0;
  const f = viewer.state.frame, a = viewer.positionsAt(f - 1), b = viewer.positionsAt(f + 1); if (!a || !b) return 0;
  return Math.hypot(b[j][0] - a[j][0], b[j][1] - a[j][1], b[j][2] - a[j][2]) * 15;
}
// The clip's hand track: the key in force at a frame (per hand); 'auto' falls through to the rule.
function trackShapeOf(a, side, frame) {
  const keys = a?.hand_track; if (!keys?.length) return null;
  let cur = null; for (const k of keys) { if (k.frame <= frame) cur = k; else break; }
  if (!cur) return null;
  const shape = side === 'L' ? cur.left : cur.right;
  return shape && shape !== 'auto' ? shape : null;
}
function poseFingers(body, src) {
  const fingerRest = body.fingerRest; if (!fingerRest?.size) return;
  const own = body === state;
  if (!body.hands) body.hands = { curl: { L: 0, R: 0 }, shape: { L: 'relaxed', R: 'relaxed' } };
  const hs = own ? hands : body.hands;
  for (const side of ['L', 'R']) {
    let shape = trackShapeOf(src.animation, side, src.frame) || hands.mode;
    if (shape === 'auto') {
      // Contact-aware: the prompt says what the hands are doing; speed still makes a fist of a fast hand.
      const base = promptHandShapeOf(src.animation);
      const v = own ? handSpeed(side) : 0;
      shape = v > 2.4 ? 'fist' : v > 1.6 && hs.shape[side] === 'fist' ? 'fist' : base; // hysteresis
    }
    hs.shape[side] = shape;
    const target = shape === 'relaxed' ? 0 : 1;
    hs.curl[side] += (target - hs.curl[side]) * (viewer.state.playing ? .3 : 1);
    const pose = HAND_POSES[shape] || HAND_POSES.relaxed, w = hs.curl[side];
    for (const [bone, rest] of fingerRest) {
      const m = fingerOf(bone.name); if (!m || m.side !== side) continue;
      const deg = (m.finger === 'thumb' ? pose.t : (m.finger === 'index' && pose.index) ? pose.index : pose.f)[m.knuckle] * w;
      bone.quaternion.copy(rest).multiply(new THREE.Quaternion().setFromAxisAngle(body.fingerAxis || new THREE.Vector3(1, 0, 0), deg * Math.PI / 180));
    }
  }
}
// Match mode: after plain FK, every mapped bone gets new local transforms so
// that its origin is the clip's joint, its length axis points at the next joint
// and its shell is stretched to span the gap (three.js recomputes world
// matrices from locals whenever it likes, so locals are what must change). The
// pelvis is the exception: it is placed so the doll's hip sockets land on the
// clip's hip joints, since a rig's hips bone origin can sit anywhere in the pelvis.
const MATCH_STRETCH = [0.55, 1.7];
const tmpLocal = new THREE.Matrix4(), tmpWorld = new THREE.Matrix4();
// A shoe's sole: the vertices skinned mostly to the given pivot bones, kept in the first bone's frame (the lowest
// band only), so the whole shoe can be checked against the floor as one rigid piece.
function solePoints(model, bone, others = []) {
  const pts = [], inv = bone.matrixWorld.clone().invert(), v = new THREE.Vector3();
  model.traverse(o => {
    if (!o.isSkinnedMesh || !o.skeleton) return;
    const set = new Set([bone, ...others].map(x => o.skeleton.bones.indexOf(x)).filter(i => i >= 0)); if (!set.size) return;
    const pos = o.geometry.getAttribute('position'), si = o.geometry.getAttribute('skinIndex'), sw = o.geometry.getAttribute('skinWeight');
    o.skeleton.update(); const bm = o.skeleton.boneMatrices, M = new THREE.Matrix4(), acc = new THREE.Vector3(), t = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) for (let k = 0; k < 4; k++) if (set.has(si.getComponent(i, k)) && sw.getComponent(i, k) > .5) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.bindMatrix); acc.set(0, 0, 0);   // skinned exactly as the shader does it
      for (let m = 0; m < 4; m++) { const w = sw.getComponent(i, m); if (!w) continue; M.fromArray(bm, si.getComponent(i, m) * 16); acc.add(t.copy(v).applyMatrix4(M).multiplyScalar(w)); }
      acc.applyMatrix4(o.bindMatrixInverse).applyMatrix4(o.matrixWorld);
      pts.push({ y: acc.y, p: acc.clone().applyMatrix4(inv) }); break; }
  });
  pts.sort((a, b) => a.y - b.y);
  const low = pts.length ? pts[0].y : 0;
  return pts.filter(q => q.y < low + .02).filter((_, i, a) => a.length < 160 || i % Math.ceil(a.length / 160) === 0).map(q => q.p);
}
// Lowest point of a shoe's sole in world space, with the pivot's current pose.
function soleLow(pv) { let low = Infinity; const v = new THREE.Vector3(); for (const p of pv.sole) low = Math.min(low, v.copy(p).applyMatrix4(pv.bone.matrixWorld).y); return low; }
const FLOOR_TOL = .004;            // a sole this far into the floor is left alone
const FOOT_LIFT_MAX = 0;           // radians a planted shoe may tip toes-up to stay out of the floor. Off: tipping reacted to a foot slapping down within one frame and shook the doll (2026-10-25); it barely reduced sinking
const TOE_FOLLOW_FULL = .02, TOE_FOLLOW_TOP = .07; // toe joint height over the floor: clip toe bend followed fully / not at all
// Turn a posed pivot toes-up about the side axis, the least that lifts its sole clear of the floor (or, when no
// turn within `max` clears it, the turn that sinks it least). Returns the extra world turn it applied.
function clearFloor(pv, want, axis, max, set) {
  const floorY = (viewer.state.floorY || 0) - FLOOR_TOL, none = new THREE.Quaternion();
  if (soleLow(pv) >= floorY) return none;
  const turn = a => new THREE.Quaternion().setFromAxisAngle(axis, a);
  set(turn(-.1).multiply(want.clone())); const lowNeg = soleLow(pv); set(turn(.1).multiply(want.clone()));
  const sign = lowNeg > soleLow(pv) ? -1 : 1, at = a => { const q = turn(sign * a); set(q.clone().multiply(want)); return q; };
  at(max);
  if (soleLow(pv) < floorY) { // no turn within max clears it: the turn that sinks least, found continuously (no steps, so no pops)
    let lo = 0, hi = max;
    for (let i = 0; i < 18; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; at(m1); const l1 = soleLow(pv); at(m2); const l2 = soleLow(pv); if (l1 < l2) lo = m1; else hi = m2; }
    return at((lo + hi) / 2);
  }
  let lo = 0, hi = max;
  for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; at(mid); if (soleLow(pv) < floorY) lo = mid; else hi = mid; }
  return at(hi);
}
// How planted each foot is on every frame of the clip on the stage (1 = toe on the floor, 0 = toe 7 cm up or more),
// eased over a few frames: the toe follow and the shoe tilt ride on it, so a take-off or a landing that crosses
// the band in one frame still blends over several (a per-frame height gate popped the doll's feet).
let plantCache = { key: '', w: null };
function plantWeights() {
  const a = viewer.state.animation; if (!a) return null;
  const key = `${a.id}:${a.edits || 0}:${a.frames}:${viewer.state.floorY}`;
  if (plantCache.key === key) return plantCache.w;
  const names = viewer.skeleton.names, fy = viewer.state.floorY || 0, w = {};
  for (const side of ['Left', 'Right']) {
    const j = names.indexOf(side + 'ToeBase'); if (j < 0) continue;
    let raw = []; for (let f = 0; f < a.frames; f++) { const p = viewer.positionsAt(f); const ty = p ? p[j][1] - fy : 1; raw.push(Math.min(1, Math.max(0, (TOE_FOLLOW_TOP - ty) / (TOE_FOLLOW_TOP - TOE_FOLLOW_FULL)))); }
    for (let pass = 0; pass < 2; pass++) raw = raw.map((_, f) => { let s = 0, n = 0; for (let d = -PLANT_EASE; d <= PLANT_EASE; d++) { const g = f + d; if (g < 0 || g >= raw.length) continue; const k = PLANT_EASE + 1 - Math.abs(d); s += raw[g] * k; n += k; } return s / n; });
    w[side] = raw;
  }
  plantCache = { key, w }; return w;
}
const PLANT_EASE = 6; // frames either side the plant weight is eased over
function posePivots(body) {
  if (!body.pivots?.length) return;
  const floorY = viewer.state.floorY || 0, extra = {}, plant = plantWeights(), frame = viewer.state.frame;
  for (const pv of body.pivots) {
    const tgt = body.bones[pv.target]; if (!tgt || !body.rest[pv.target]) continue;
    if (pv.kind === 'half') {
      const par = parentSoma(pv.target, body); if (!par || !body.rest[par]) continue;
      tgt.updateWorldMatrix(true, false); pv.bone.parent.updateWorldMatrix(true, false);
      const tP = body.bones[par].getWorldQuaternion(new THREE.Quaternion()).multiply(body.rest[par].q.clone().invert());
      const tT = tgt.getWorldQuaternion(new THREE.Quaternion()).multiply(body.rest[pv.target].q.clone().invert());
      const want = tP.slerp(tT, .5).multiply(pv.restQ);
      pv.bone.matrixAutoUpdate = true; pv.bone.scale.set(1, 1, 1);
      pv.bone.quaternion.copy(pv.bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(want)); pv.bone.updateMatrix(); pv.bone.updateWorldMatrix(false, true);
      continue;
    }
    // A doll's foot is one rigid shoe: its toe piece turns with the foot, not with the clip's toe joint (a toe bend
    // carried into the air smears the shoe like a sock). Near the floor it follows the clip's bend (a push-off).
    // The toe is never bent further to clear the floor: a kinked toe reads as warping, a toe tip in the floor as contact.
    const toe = /ToeBase$/.test(pv.target), side = pv.target.replace(/ToeBase$|Foot$/, ''), foot = side + 'Foot';
    const drive = toe && body.bones[foot] && body.rest[foot] ? foot : pv.target;
    const src = body.bones[drive];
    src.updateWorldMatrix(true, false); pv.bone.parent.updateWorldMatrix(true, false);
    const turn = src.getWorldQuaternion(new THREE.Quaternion()).multiply(body.rest[drive].q.clone().invert());
    let want = turn.clone().multiply(pv.restQ);     // the driver's turn, applied to the pivot's rest
    const toeJoint = body.bones[side + 'ToeBase'], ty = toeJoint ? toeJoint.getWorldPosition(new THREE.Vector3()).y - floorY : 1;
    const planted = plant?.[side]?.[frame] ?? Math.min(1, Math.max(0, (TOE_FOLLOW_TOP - ty) / (TOE_FOLLOW_TOP - TOE_FOLLOW_FULL)));
    if (drive !== pv.target) {
      const w = planted;
      if (w > 0) { const own = tgt.getWorldQuaternion(new THREE.Quaternion()).multiply(body.rest[pv.target].q.clone().invert()).multiply(pv.restQ); want = want.slerp(own, w); }
      if (extra[side]) want = extra[side].clone().multiply(want);   // the shoe's own floor tip, carried
    }
    const pq = pv.bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    pv.bone.matrixAutoUpdate = true; pv.bone.scale.set(1, 1, 1);
    const set = q => { pv.bone.quaternion.copy(pq).multiply(q); pv.bone.updateMatrix(); pv.bone.updateWorldMatrix(false, true); };
    set(want);
    if (toe || !pv.sole?.length || planted <= 0.001 || FOOT_LIFT_MAX <= 0) continue;   // only a planted shoe is kept out of the floor
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(turn).normalize();
    const tip = new THREE.Quaternion().slerp(clearFloor(pv, want, axis, FOOT_LIFT_MAX, set), planted);   // eased in and out with the plant
    set(tip.clone().multiply(want));
    extra[side] = tip;
  }
}
function matchSkeleton(body, src, order, index, desired, stretch) {
  const pose = src.pose; if (!pose?.length) return;
  const k = body.scaleMatch;
  const drop = body.rootDrop || 0; // the doll lowered so a floor contact its shorter arm cannot reach still lands
  const at = soma => { const p = pose[index[soma]]; return new THREE.Vector3(p[0], p[1] - drop, p[2]); };
  const target = {};
  for (const soma of order) target[soma] = at(soma);
  if (target.LeftLeg && target.RightLeg && body.rest.LeftLeg && body.rest.RightLeg && desired.Hips) {
    const mid = target.LeftLeg.clone().add(target.RightLeg).multiplyScalar(.5);
    const restMid = body.rest.LeftLeg.p.clone().add(body.rest.RightLeg.p).multiplyScalar(.5);
    const delta = desired.Hips.clone().multiply(body.rest.Hips.q.clone().invert());
    target.Hips = mid.add(body.rest.Hips.p.clone().sub(restMid).multiplyScalar(k).applyQuaternion(delta));
  }
  // Feet: a doll's ankle sits higher above its sole than SOMA's ankle joint does, so the
  // foot is lifted by that difference along its own up axis; the sole lands where the
  // clip's foot is, and the shin aims at the lifted ankle.
  for (const soma of stretch ? ['LeftFoot', 'RightFoot'] : []) {
    if (!target[soma] || !desired[soma] || !body.rest[soma]) continue;
    const lift = body.rest[soma].p.y * k - body.somaAnkleY;
    if (Math.abs(lift) < 1e-3) continue;
    const up = new THREE.Vector3(0, lift, 0).applyQuaternion(desired[soma].clone().multiply(body.rest[soma].q.clone().invert()));
    target[soma].add(up);
  }
  const finalQ = {};
  const torsoRatio = target.Neck1 && target.Hips && body.rest.Neck1 ? target.Neck1.clone().sub(target.Hips).length() / (body.rest.Neck1.p.clone().sub(body.rest.Hips.p).length() * k) : 1;
  for (const soma of order) {
    const bone = body.bones[soma], parent = bone.parent;
    if (MATCH_FOLLOW.has(soma)) { bone.matrixAutoUpdate = true; bone.scale.set(1, 1, 1); bone.updateMatrix(); continue; }
    const q = (desired[soma] || bone.getWorldQuaternion(new THREE.Quaternion())).clone();
    let carrier = MATCH_SOCKET[soma] || MATCH_TORSO[soma];
    if (!stretch && soma !== 'Hips') carrier = parentSoma(soma, body); // doll proportions: every joint rides on its parent shell
    if (carrier && finalQ[carrier] && target[carrier] && body.rest[carrier]) {
      const delta = finalQ[carrier].clone().multiply(body.rest[carrier].q.clone().invert());
      if (MATCH_TORSO[soma]) {
        target[soma] = target[carrier].clone().add(body.rest[soma].p.clone().sub(body.rest[carrier].p).multiplyScalar(k * torsoRatio).applyQuaternion(delta));
      } else {
        // Sockets ride on the carrier's finished shell (its stretch included), so the cup and the ball stay together.
        const local = body.rest[soma].p.clone().sub(body.rest[carrier].p).applyQuaternion(body.rest[carrier].q.clone().invert());
        target[soma] = local.applyMatrix4(body.bones[carrier].matrixWorld);
      }
      // Clavicles turn with the chest only: the doll's shoulder cap is part of the chest shell.
      if ((soma === 'LeftShoulder' || soma === 'RightShoulder') && !body.exact) q.copy(delta).multiply(body.rest[soma].q);
      // Upper arms and thighs keep only their swing from the carrier: the twist Kimodo puts on
      // them would spin the ball's cup, and the forearm/shin get their own rotation anyway.
      if (SWING_ONLY.has(soma) && body.axis[soma] && !body.exact) {
        const unit = body.axis[soma].unit, carried = delta.clone().multiply(body.rest[soma].q);
        const restDir = unit.clone().applyQuaternion(carried).normalize(), curDir = unit.clone().applyQuaternion(q).normalize();
        q.copy(new THREE.Quaternion().setFromUnitVectors(restDir, curDir).multiply(carried));
      }
    }
    const scale = new THREE.Vector3(k, k, k);
    const ax = stretch ? body.axis[soma] : null;
    if (ax && target[ax.next]) {
      const want = target[ax.next].clone().sub(target[soma]), len = want.length();
      if (len > 1e-4) {
        const cur = ax.unit.clone().applyQuaternion(q).normalize();
        q.premultiply(new THREE.Quaternion().setFromUnitVectors(cur, want.clone().normalize()));
        const f = Math.max(MATCH_STRETCH[0], Math.min(MATCH_STRETCH[1], len / (ax.restLen * k)));
        // length follows the skeleton; girth follows by √f so the shell keeps its character
        const g = Math.sqrt(f);
        scale.setScalar(k * g); scale.setComponent(ax.i, k * f);
      }
    }
    finalQ[soma] = q;
    parent.updateWorldMatrix(true, false);
    tmpWorld.compose(target[soma], q, scale);
    // The local matrix is written directly: under a stretched parent it holds a
    // shear that position/quaternion/scale cannot, and three.js honours bone.matrix
    // as long as matrixAutoUpdate is off.
    bone.matrixAutoUpdate = false;
    bone.matrix.copy(parent.matrixWorld).invert().multiply(tmpWorld);
    bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
  }
  if (!stretch && !body.exact) { retargetLegs(body, pose, index, target, finalQ, k); retargetArms(body, pose, index, target, finalQ, k); }
  body.model.updateMatrixWorld(true);
}
// Doll proportions, hands where the motion puts them. With its own (shorter) arms and lower
// head, plain FK leaves the doll's hands 10–16 cm from the clip's wrists — a guard at the chin
// reads as a hand in the face. So each arm is re-solved (two-bone IK on the doll's own
// lengths, elbow in the clip's plane) toward a wrist target that is the clip's wrist relative
// to the skull when the hand is near the head, and relative to the shoulder (scaled by the
// arm-length ratio) when it is away. Nothing stretches: the silhouette is the doll's.
// Two-bone placement of a doll limb on its own lengths: the end lands on T (or as close as the limb
// reaches), the middle joint in the clip's own limb plane; the end piece keeps its clip rotation.
function solveLimb(body, [u, l, e], A, T, [As, Bs, Cs], target, finalQ, k) {
  const bu = body.bones[u], bl = body.bones[l], be = body.bones[e], au = body.axis[u], al = body.axis[l];
  if (!bu || !bl || !be || !au || !al) return;
  const l1 = au.restLen * k, l2 = al.restLen * k;
  const reach = T.clone().sub(A), d = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(l1 + l2 - 1e-3, reach.length()));
  if (reach.length() < 1e-5) return;
  const dir = reach.normalize();
  const uS = Cs.clone().sub(As).normalize();
  let n = Bs.clone().sub(As); n.sub(uS.clone().multiplyScalar(n.dot(uS)));
  if (n.length() < 1e-4) { n = target[l].clone().sub(A); n.sub(dir.clone().multiplyScalar(n.dot(dir))); }
  n.sub(dir.clone().multiplyScalar(n.dot(dir)));
  if (n.length() < 1e-4) n = new THREE.Vector3(0, -1, 0).sub(dir.clone().multiplyScalar(-dir.y));
  n.normalize();
  const cosA = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))), sinA = Math.sqrt(1 - cosA * cosA);
  const B = A.clone().add(dir.clone().multiplyScalar(l1 * cosA)).add(n.multiplyScalar(l1 * sinA));
  const C = A.clone().add(dir.clone().multiplyScalar(d));
  const aim = (soma, from, to) => {
    const q = finalQ[soma].clone(), unit = body.axis[soma].unit;
    const cur = unit.clone().applyQuaternion(q).normalize(), want = to.clone().sub(from).normalize();
    if (want.length() > 1e-6) q.premultiply(new THREE.Quaternion().setFromUnitVectors(cur, want));
    return q;
  };
  const place = (bone, soma, p, q) => {
    const parent = bone.parent; finalQ[soma] = q; target[soma] = p.clone();
    tmpWorld.compose(p, q, new THREE.Vector3(k, k, k));
    bone.matrixAutoUpdate = false;
    bone.matrix.copy(parent.matrixWorld).invert().multiply(tmpWorld);
    bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
  };
  place(bu, u, A, aim(u, A, B));
  place(bl, l, B, aim(l, B, C));
  place(be, e, C, finalQ[e]);
  // the end piece's children (toes, fingers) follow the moved end piece
  be.updateWorldMatrix(false, true);
}
// Legs: the doll's legs are scaled to the clip's, so each ankle lands where the clip's ankle is. A planted
// foot keeps its absolute place even while the doll is lowered for a hand plant; an airborne foot comes down
// with the body.
const LEG_SIDES = [['LeftLeg', 'LeftShin', 'LeftFoot'], ['RightLeg', 'RightShin', 'RightFoot']];
function retargetLegs(body, pose, index, target, finalQ, k) {
  body.dropReq = { want: 0, active: false };
  const at = soma => { const p = pose[index[soma]]; return p ? new THREE.Vector3(p[0], p[1], p[2]) : null; };
  const drop = body.rootDrop || 0, floorY = body.floorY ?? 0;
  for (const [u, l, e] of LEG_SIDES) {
    if (!body.bones[u] || !body.bones[l] || !body.bones[e] || !body.axis[u] || !body.axis[l] || !target[u] || !finalQ[u] || !finalQ[l] || !finalQ[e]) continue;
    const As = at(u), Bs = at(l), Cs = at(e); if (!As || !Bs || !Cs) continue;
    const A = target[u].clone();
    // the doll's ankle rests higher above its sole than the clip's: keep that lift so the sole, not the ankle, meets the floor
    const lift = body.rest[e] ? body.rest[e].p.y * k - body.somaAnkleY : 0;
    const planted = 1 - THREE.MathUtils.smoothstep(Cs.y - floorY, .05, .2);
    const T = new THREE.Vector3(Cs.x, Cs.y + lift - drop * (1 - planted), Cs.z);
    const l1 = body.axis[u].restLen * k, l2 = body.axis[l].restLen * k, reach = T.distanceTo(A);
    if (planted > .5) { body.dropReq.active = true; if (reach > l1 + l2) body.dropReq.want = Math.max(body.dropReq.want, reach - (l1 + l2)); }
    solveLimb(body, [u, l, e], A, T, [As, Bs, Cs], target, finalQ, k);
  }
}
const ARM_SIDES = [['LeftArm', 'LeftForeArm', 'LeftHand'], ['RightArm', 'RightForeArm', 'RightHand']];
function retargetArms(body, pose, index, target, finalQ, k) {
  const at = soma => { const p = pose[index[soma]]; return p ? new THREE.Vector3(p[0], p[1], p[2]) : null; };
  const headS = at('Head'), neckS = at('Neck1'), headBone = body.bones.Head;
  if (!headS || !neckS || !headBone) return;
  const skullS = headS.clone().add(headS.clone().sub(neckS).normalize().multiplyScalar(.1)); // the metrics' head capsule, centred
  const skullD = body.headCentre ? body.headCentre.clone().applyMatrix4(headBone.matrixWorld) : headBone.getWorldPosition(new THREE.Vector3()).add(skullS.clone().sub(headS));
  let wantDrop = body.dropReq?.want || 0, floorActive = !!body.dropReq?.active;
  // the clip's floor: the lowest foot over the clip (cached per clip)
  if (body.floorClip !== viewer.state.animation?.id) {
    body.floorClip = viewer.state.animation?.id; let lo = 9;
    const a = viewer.state.animation; const feet = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'].map(s => index[s]).filter(i => i != null);
    if (a) for (let f = 0; f < a.frames; f += 3) { const p = viewer.positionsAt(f); if (p) for (const i of feet) lo = Math.min(lo, p[i][1]); }
    body.floorY = lo < 9 ? lo : 0;
  }
  for (const [u, l, h] of ARM_SIDES) {
    const bu = body.bones[u], bl = body.bones[l], bh = body.bones[h], au = body.axis[u], al = body.axis[l];
    if (!bu || !bl || !bh || !au || !al || !target[u] || !finalQ[u] || !finalQ[l] || !finalQ[h]) continue;
    const As = at(u), Bs = at(l), Cs = at(h); if (!As || !Bs || !Cs) continue;
    const A = target[u].clone(), l1 = au.restLen * k, l2 = al.restLen * k;
    const skelArm = Bs.clone().sub(As).length() + Cs.clone().sub(Bs).length(); if (skelArm < 1e-4) continue;
    const tArm = A.clone().add(Cs.clone().sub(As).multiplyScalar((l1 + l2) / skelArm));
    const tHead = skullD.clone().add(Cs.clone().sub(skullS));
    const dist = Cs.clone().sub(skullS).length();
    const w = 1 - THREE.MathUtils.smoothstep(dist, .22, .42);
    const T = tArm.lerp(tHead, w);
    // at the floor the clip's wrist height is the truth (a cartwheel, a push-up): the doll's hand takes it
    const floorY = body.floorY ?? 0, wristAbove = Cs.y - floorY;
    const wFloor = 1 - THREE.MathUtils.smoothstep(wristAbove, .12, .3);
    if (wFloor > 0) T.y = THREE.MathUtils.lerp(T.y, Cs.y, wFloor);
    const reach = T.clone().sub(A);
    if (reach.length() < 1e-5) continue;
    if (wFloor > .5) { floorActive = true; if (reach.length() > l1 + l2) wantDrop = Math.max(wantDrop, reach.length() - (l1 + l2)); } // the doll comes down for a floor contact its arm cannot reach
    solveLimb(body, [u, l, h], A, T, [As, Bs, Cs], target, finalQ, k);
  }
  // ease the root drop toward what the floor contacts need (0 when nothing reaches for the floor)
  // while a hand reaches for the floor the drop grows by what is still missing and holds; otherwise it eases back to 0
  const desired = floorActive ? Math.min(.3, (body.rootDrop || 0) + wantDrop) : 0;
  body.rootDrop = THREE.MathUtils.lerp(body.rootDrop || 0, desired, floorActive ? .5 : .25);
  if (body.rootDrop < 1e-3) body.rootDrop = 0;
}
export function setFitMode(mode) {
  state.fitMode = mode === 'doll' ? 'doll' : 'match';

  localStorage.setItem('understudy.bodyFit', state.fitMode);
  const sel = $('#bodyFit'); if (sel && sel.value !== state.fitMode) sel.value = state.fitMode;
  viewer.draw();
}

// Mannequin: one shaded capsule per bone, sized from the skeleton's rest offsets.
const mannequin = { group: null, parts: [], skeletonKey: '' };
const UP = new THREE.Vector3(0, 1, 0);
function buildMannequin() {
  if (mannequin.group) { scene.remove(mannequin.group); mannequin.parts = []; }
  const { parents, offsets, names } = viewer.skeleton;
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: .65, metalness: 0 });
  const find = re => names.findIndex(n => re.test(n));
  const capsule = (radius, length) => new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(0, length), 6, 16), material);
  const add = (mesh, child, parent, extra = {}) => { group.add(mesh); mannequin.parts.push({ mesh, child, parent, ...extra }); };
  // Torso: one tapered trunk from the hips to the top of the chest, not a stack of spine capsules.
  const hips = find(/^hips$|^pelvis$/i), chest = find(/^chest$|^spine3$|spine_05/i), neck = find(/^neck1$|^neck$|neck_01/i), head = find(/^head$/i);
  const rest = somaRest(), dist = (a, b) => rest[names[a]].distanceTo(rest[names[b]]);
  if (hips >= 0 && chest >= 0) {
    const trunk = capsule(.13, Math.max(0, dist(hips, chest) - .1)); trunk.scale.set(1, 1, .72);
    add(trunk, chest, hips);
  }
  if (neck >= 0 && head >= 0) add(capsule(.05, Math.max(0, dist(neck, head) - .05)), head, neck);
  if (head >= 0) add(new THREE.Mesh(new THREE.SphereGeometry(.105, 20, 16), material), head, -1, { ball: true, lift: .06 });
  // Limbs: one capsule per bone, joints rounded by the caps.
  const limb = /shoulder|arm|hand$|leg|shin|foot|toe/i;
  for (let j = 1; j < parents.length; j++) {
    if (!limb.test(names[j]) || /end$/i.test(names[j])) continue;
    const o = offsets[j], length = Math.hypot(o[0], o[1], o[2]);
    const radius = Math.min(viewer.boneRadiusOf(names[j]), viewer.boneRadiusOf(names[parents[j]]));
    add(capsule(radius, Math.max(0, length - radius * .4)), j, parents[j]);
  }
  for (const h of names.map((n, i) => /^(left|right)hand$|^(left|right)_wrist$/i.test(n) ? i : -1).filter(i => i >= 0)) add(new THREE.Mesh(new THREE.SphereGeometry(.045, 14, 10), material), h, -1, { ball: true, lift: 0 });
  mannequin.group = group; mannequin.skeletonKey = names.join('|');
  scene.add(group);
}
function poseMannequin() {
  const { names } = viewer.skeleton;
  if (!mannequin.group || mannequin.skeletonKey !== names.join('|')) buildMannequin();
  const p = viewer.pose();
  if (!p.length) { mannequin.group.visible = false; return; }
  mannequin.group.visible = true;
  for (const part of mannequin.parts) {
    const c = p[part.child];
    if (part.ball) { part.mesh.position.set(c[0], c[1] + part.lift, c[2]); continue; }
    const a = p[part.parent];
    const dir = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    const len = dir.length() || 1e-4;
    part.mesh.position.set((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2);
    part.mesh.quaternion.setFromUnitVectors(UP, dir.clone().multiplyScalar(1 / len));
  }
}

// Body on/off: the figure is revealed from the ground up (a clipping plane
// rising through it) while fading in; hiding runs the same backwards.
const transition = { active: false, dir: 1, t0: 0, ms: 650, plane: new THREE.Plane(new THREE.Vector3(0, -1, 0), 0) };
renderer.localClippingEnabled = true;
function startTransition(dir) { transition.active = true; transition.dir = dir; transition.t0 = performance.now(); }
function applyTransition() {
  if (!state.model) return 1;
  let p = Math.min(1, (performance.now() - transition.t0) / transition.ms);
  if (!transition.active) p = 1;
  const e = p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // ease in-out
  const shown = transition.dir > 0 ? e : 1 - e;
  const box = new THREE.Box3().setFromObject(state.model);
  const h = box.min.y + (box.max.y - box.min.y + .2) * shown;
  transition.plane.constant = h;
  state.model.traverse(o => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue;
      // X-ray (skeleton through body): the shells stay translucent so the stick figure under the overlay shows through.
      const top = state.showSkeleton ? .55 : 1; // X-ray: shells stay readable so elbow/knee/head fit can be checked, the figure shows through
      m.clippingPlanes = shown < 1 ? [transition.plane] : null;
      m.transparent = shown < 1 || top < 1; m.opacity = Math.min(top, .35 + shown); m.needsUpdate = m.needsUpdate || shown === 1;
    }
  });
  if (p >= 1) transition.active = false;
  return shown;
}
let defaultBodyTried = false, defaultBodyLoading = false;
export let usingDefaultBody = false;
export const BODY_FILES = { mannequin: 'understudy_mannequin.glb' };
// Only Understudy's own body plays the clips; your own character loads through the Body panel.
export function bodyChoice() { return 'mannequin'; }
export async function setBodyChoice(choice) {
  if (choice !== 'mannequin' || state.model) return;
  localStorage.setItem('understudy.body.file', choice);
  const sel = $('#bodyChoice'); if (sel && sel.value !== choice) sel.value = choice;
  clear(); defaultBodyTried = false; usingDefaultBody = false; defaultGLB = null;
  if (viewer.isBodyShown()) await loadDefaultBody();
  viewer.draw();
}
async function loadDefaultBody() {
  if (defaultBodyTried || defaultBodyLoading) return;
  defaultBodyLoading = true;
  try {
    const file = BODY_FILES[bodyChoice()];
    const r = await fetch('/static/body/' + file);
    if (!r.ok) throw new Error('no default body');
    await load(new File([await r.blob()], file, { type: 'model/gltf-binary' }), { isDefault: true });
    usingDefaultBody = true;
    startTransition(1);
  } catch { defaultBodyTried = true; }
  defaultBodyLoading = false;
}
let hiding = false;
// The key light follows the character so its 12 m shadow map stays centred on it, but only in whole shadow-map
// texels (0.6 cm): moved by a fraction of a texel the whole map is re-sampled and the shadow edges and the shading on
// the feet crawl on every draw while the feet stand still (the owner saw planted feet "shaking"). The anchor is
// snapped along the shadow camera's own axes; a shift along the light direction changes nothing.
const SHADOW_OFFSET = new THREE.Vector3(2.5, 5, 3.5);
const shadowRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SHADOW_OFFSET).normalize();  // lookAt: x = up × (position − target)
const shadowUp = new THREE.Vector3().crossVectors(SHADOW_OFFSET.clone().normalize(), shadowRight).normalize();
function shadowAnchor(x, z) {
  const texel = (key.shadow.camera.right - key.shadow.camera.left) / key.shadow.mapSize.x;
  const t = new THREE.Vector3(x, 0, z), a = t.dot(shadowRight), b = t.dot(shadowUp);
  return t.addScaledVector(shadowRight, Math.round(a / texel) * texel - a).addScaledVector(shadowUp, Math.round(b / texel) * texel - b);
}
// The clip's props as solids: a dark matte box per prop, casting and receiving shadows, rebuilt when the clip's
// props change (key = JSON of the list).
const propGroup = new THREE.Group(); scene.add(propGroup); let propKey = '';
function syncProps() {
  const props = viewer.propsOf(); const key = JSON.stringify(props);
  if (key === propKey) return; propKey = key;
  while (propGroup.children.length) { const m = propGroup.children.pop(); m.geometry.dispose(); m.material.dispose(); }
  for (const b of props) {
    if (b.kind && b.kind !== 'box') continue;
    const m = new THREE.Mesh(new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]), new THREE.MeshStandardMaterial({ color: 0x8a7a55, roughness: .9, metalness: 0, side: THREE.DoubleSide }));
    m.position.set(b.pos[0], b.pos[1] + b.size[1] / 2, b.pos[2]); m.rotation.y = b.yaw || 0; m.castShadow = true; m.receiveShadow = true;
    propGroup.add(m);
  }
}
// Points (point.js) as tennis balls in the body layer, which covers the 2D stage where the overlay draws them: a
// felt-yellow ball (brighter when selected) and, when it floats, a thin stem down to the floor.
const pointGroup = new THREE.Group(); scene.add(pointGroup); let pointKey = '';
function syncPoints() {
  const pts = viewer.pointsOf(); const key = JSON.stringify(pts.map(p => [p.pos, !!p.selected]));
  if (key === pointKey) return; pointKey = key;
  while (pointGroup.children.length) { const m = pointGroup.children.pop(); m.geometry.dispose(); m.material.dispose(); }
  for (const p of pts) {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(.04, 24, 16), new THREE.MeshStandardMaterial({ color: 0xd7f24a, roughness: .85, metalness: 0, emissive: 0xd7f24a, emissiveIntensity: p.selected ? .55 : .2 }));
    ball.position.set(p.pos[0], p.pos[1] + (p.pos[1] < .04 ? .04 - p.pos[1] : 0), p.pos[2]); ball.castShadow = true; pointGroup.add(ball);
    if (p.pos[1] > .1) {
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(.004, .004, p.pos[1] - .04, 6), new THREE.MeshBasicMaterial({ color: 0xd7f24a, transparent: true, opacity: .45 }));
      stem.position.set(p.pos[0], (p.pos[1] - .04) / 2, p.pos[2]); pointGroup.add(stem);
    }
  }
}
export function render() {
  syncProps(); syncPoints();
  // a clean stage: no clip, no body (the mannequin stood in a T-pose on every fresh page: owner, 'the ghost skeleton all the time')
  if (!viewer.state.animation) { if (overlay.width) renderer.clear(); overlay.style.visibility = 'hidden'; return; }
  floor.position.y = (viewer.state.floorY || 0) + .002; // the shadow lands on the clip's own floor
  if (viewer.isBodyShown() && !state.model && !defaultBodyTried && !defaultBodyLoading) { loadDefaultBody(); return; }
  if (viewer.isBodyShown() && state.model && hiding) { hiding = false; startTransition(1); }
  if (!viewer.isBodyShown() && usingDefaultBody && state.model) {
    if (!hiding) { hiding = true; startTransition(-1); }
    if (!transition.active) { hiding = false; clear(); usingDefaultBody = false; return; }
  }
  // Capsules are a last resort (no doll file at all): while the doll is still
  // loading the stage shows nothing extra, then the doll reveals itself.
  const wantMannequin = viewer.isBodyShown() && !state.model && defaultBodyTried;
  if (mannequin.group) mannequin.group.visible = false;
  if (!state.model && !wantMannequin) { if (overlay.width) renderer.clear(); overlay.style.visibility = 'hidden'; return; }
  if (state.model && !viewer.isBodyShown() && !usingDefaultBody && !transition.active && hiding) { hiding = false; }
  overlay.style.visibility = 'visible';
  fitOverlay();
  syncCamera();
  { const r = viewer.rootPosition(); if (r) { const t = shadowAnchor(r[0], r[2]); key.target.position.copy(t); key.position.copy(t).add(SHADOW_OFFSET); key.target.updateMatrixWorld(); } }
  if (state.model) { poseRig(state, stageSource()); applyTransition(); if (state.showSkeleton) reportSync(); }
  else poseMannequin();
  // Other actors: a doll each, posed from their own clip at their placement.
  const live = new Set();
  for (const e of viewer.extras) {
    live.add(e.label);
    let body = actorBodies.get(e.label);
    if (!body) { spawnBody(e.label, e.colour); continue; }
    if (!body.model) continue;
    body.model.visible = viewer.isBodyShown();
    if (body.model.visible) poseRig(body, viewer.extraSource(e));
  }
  for (const label of [...actorBodies.keys()]) if (!live.has(label)) dropBody(label);
  renderer.render(scene, camera);
}
viewer.setExtraBodyCheck(hasActorBody);
viewer.onDraw(render);

// UI.
$('#characterFile').onchange = async () => {
  const file = $('#characterFile').files[0]; if (!file) return;
  try { await load(file); } catch (e) { $('#characterHint').textContent = e.message; $('#characterBar').hidden = false; }
};
$('#characterFit').onchange = e => setFit(e.target.checked);
$('#characterSkeleton').onchange = e => setShowSkeleton(e.target.checked);
$('#hands').value = hands.mode;
$('#hands').onchange = e => setHands(e.target.value);
if ($('#bodyFit')) $('#bodyFit').value = state.fitMode;
if ($('#bodyChoice')) { $('#bodyChoice').value = bodyChoice(); $('#bodyChoice').onchange = e => setBodyChoice(e.target.value); }
if ($('#bodyFit')) $('#bodyFit').onchange = e => setFitMode(e.target.value);
$('#xray').onchange = e => { setShowSkeleton(e.target.checked); if (e.target.checked && !viewer.isBodyShown()) viewer.setBody(true); };
$('#clearCharacter').onclick = () => { clear(); $('#characterFile').value = ''; defaultBodyTried = false; usingDefaultBody = false; viewer.setBody(false); };
