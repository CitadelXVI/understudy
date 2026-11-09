"""Understudy clean-up: physics + anti-clipping for SOMA clips.

  python cleanup.py <in_dir> <out_dir> [--mode physics+declip|physics|declip] [--strength 0..1] [--report]

<in_dir> holds a clip's streams (root_positions.f32 [T,3], local_rotations_xyzw.f32 [T,J,4]) and skeleton.json
({names, parents, offsets}). <out_dir> receives the cleaned streams plus report.json (before/after numbers).

Physics: a MuJoCo body of capsules (the same capsules the server's clip check uses) with a floor and self-collision
is pulled toward the animation by soft weld constraints on every bone. Contacts are stiffer than the welds, so limbs
slide off the body instead of passing through it, feet stay on the floor, and the welds' softness filters
frame-to-frame shakes. Declip: whatever overlap is left after that is pushed out frame by frame with small
limb-rotation changes, eased in and out over neighbouring frames, so the result has no clipping by construction.
"""
import argparse, json, os, sys
import re
import numpy as np
from scipy.spatial.transform import Rotation as R
from anatomy import anatomy_report, enforce_anatomy, clamp_exact
from contact import proxy, contact_pass, lift_out, root_fit, touching, tip_over, plant_feet, foot_lock, lift_steps, hold_feet, surface_low, smooth_feet, ankle_guard, hand_lock, hand_keep_near_props, knee_lock

HERE = os.path.dirname(os.path.abspath(__file__))

# --- clip I/O --------------------------------------------------------------------------------------------------
def load_props(d):
    """Stage boxes the clip was made with: [{kind:'box', pos:[x,y,z] (base centre), size:[w,h,d], yaw}]."""
    p = os.path.join(d, 'props.json')
    return json.load(open(p)) if os.path.exists(p) else []


def load_clip(d):
    sk = json.load(open(os.path.join(d, 'skeleton.json')))
    J = len(sk['names'])
    roots = np.fromfile(os.path.join(d, 'root_positions.f32'), np.float32).reshape(-1, 3).astype(np.float64)
    rots = np.fromfile(os.path.join(d, 'local_rotations_xyzw.f32'), np.float32).reshape(-1, J, 4).astype(np.float64)
    return sk, roots, rots

def save_clip(d, roots, rots):
    os.makedirs(d, exist_ok=True)
    roots.astype(np.float32).tofile(os.path.join(d, 'root_positions.f32'))
    rots.astype(np.float32).tofile(os.path.join(d, 'local_rotations_xyzw.f32'))

# --- kinematics -------------------------------------------------------------------------------------------------
def fk(sk, roots, rots):
    """World positions [T,J,3] and world rotations (list of scipy Rotation, one per joint, vectorised over T)."""
    parents, off = sk['parents'], np.array(sk['offsets'], float)
    T, J = rots.shape[:2]
    G, P = [None] * J, np.zeros((T, J, 3))
    for j in range(J):
        q = R.from_quat(rots[:, j])
        if parents[j] < 0:
            G[j] = q; P[:, j] = roots
        else:
            G[j] = G[parents[j]] * q; P[:, j] = P[:, parents[j]] + G[parents[j]].apply(off[j])
    return P, G

def rest_positions(sk):
    parents, off = sk['parents'], np.array(sk['offsets'], float)
    P = np.zeros((len(parents), 3))
    for j, p in enumerate(parents):
        if p >= 0: P[j] = P[p] + off[j]
    return P

# --- body parts: the server's capsules (metrics.go partsOf / checkPair) -------------------------------------------
def parts_of(sk):
    ix = {n: i for i, n in enumerate(sk['names'])}
    parts = []
    def add(name, group, a, b, r, extend=0.0):
        if a in ix and b in ix: parts.append(dict(name=name, group=group, a=ix[a], b=ix[b], r=r, extend=extend))
    for tag, pre in (('l', 'Left'), ('r', 'Right')):
        add(pre + ' upper arm', 'arm-' + tag, pre + 'Arm', pre + 'ForeArm', 0.05)
        add(pre + ' forearm', 'arm-' + tag, pre + 'ForeArm', pre + 'Hand', 0.04)
        add(pre + ' hand', 'arm-' + tag, pre + 'Hand', pre + 'HandMiddleEnd', 0.03)
        add(pre + ' thigh', 'leg-' + tag, pre + 'Leg', pre + 'Shin', 0.07)
        add(pre + ' shin', 'leg-' + tag, pre + 'Shin', pre + 'Foot', 0.055)
        add(pre + ' foot', 'leg-' + tag, pre + 'Foot', pre + 'ToeBase', 0.04)
    add('torso', 'torso', 'Hips', 'Chest', 0.13)
    add('neck', 'head', 'Neck1', 'Head', 0.06)
    add('head', 'head', 'Neck1', 'Head', 0.10, 0.2)
    return parts

def check_pair(a, b):
    if a['group'] == b['group']: return False
    arm = lambda g: g.startswith('arm'); leg = lambda g: g.startswith('leg')
    ga, gb = a['group'], b['group']
    if arm(ga) and arm(gb): return not (a['name'].endswith(' hand') and b['name'].endswith(' hand'))
    if (arm(ga) and leg(gb)) or (leg(ga) and arm(gb)): return True
    if leg(ga) and leg(gb): return 'thigh' not in a['name'] and 'thigh' not in b['name']
    if (arm(ga) and gb == 'torso') or (ga == 'torso' and arm(gb)):
        armp = a if ga != 'torso' else b
        return 'upper' not in armp['name']
    if (arm(ga) and gb == 'head') or (ga == 'head' and arm(gb)): return True
    return False

def capsule_end(P, p):
    end = P[:, p['b']]
    if p['extend']:
        d = P[:, p['b']] - P[:, p['a']]
        end = end + d / np.maximum(np.linalg.norm(d, axis=-1, keepdims=True), 1e-9) * p['extend']
    return end

def seg_dist(p1, q1, p2, q2):
    """Closest distance between segments p1q1 and p2q2, vectorised over the leading axis."""
    d1, d2, r = q1 - p1, q2 - p2, p1 - p2
    a = (d1 * d1).sum(-1); e = (d2 * d2).sum(-1); f = (d2 * r).sum(-1)
    c = (d1 * r).sum(-1); b = (d1 * d2).sum(-1); den = a * e - b * b
    s = np.where(den > 1e-12, np.clip((b * f - c * e) / np.where(den > 1e-12, den, 1), 0, 1), 0)
    t = (b * s + f) / np.where(e > 1e-12, e, 1)
    s = np.where(t < 0, np.clip(-c / np.where(a > 1e-12, a, 1), 0, 1), np.where(t > 1, np.clip((b - c) / np.where(a > 1e-12, a, 1), 0, 1), s))
    t = np.clip(t, 0, 1)
    c1 = p1 + d1 * s[..., None]; c2 = p2 + d2 * t[..., None]
    return np.linalg.norm(c1 - c2, axis=-1), c1, c2

CLIP_DEPTH = 0.04   # the server's flag depth; contact shallower than this is skin touching

def clip_report(sk, P, depth=CLIP_DEPTH):
    parts = parts_of(sk); T = P.shape[0]
    worst = np.zeros(T); pairs = {}
    for i, a in enumerate(parts):
        for b in parts[i + 1:]:
            if not check_pair(a, b): continue
            d, _, _ = seg_dist(P[:, a['a']], capsule_end(P, a), P[:, b['a']], capsule_end(P, b))
            pen = a['r'] + b['r'] - d
            worst = np.maximum(worst, pen)
            n = int((pen > depth).sum())
            if n: pairs[a['name'] + ' x ' + b['name']] = n
    return dict(frames=int((worst > depth).sum()), max_cm=round(float(max(0, worst.max()) * 100), 1),
                pairs=dict(sorted(pairs.items(), key=lambda kv: -kv[1])[:5]))

# --- jitter: the server's check (jitter.go) ----------------------------------------------------------------------
def jitter_report(sk, roots, rots, flag=15.0):
    J = rots.shape[1]; peak, hits, worst = 0.0, 0, None
    for j, n in enumerate(sk['names']):
        ln = n.lower()
        if ln.endswith('end') or 'eye' in ln or 'jaw' in ln: continue
        q0, q1 = R.from_quat(rots[:-1, j]), R.from_quat(rots[1:, j])
        v = (q1 * q0.inv()).as_rotvec()
        a1, a2 = v[1:-1] - v[:-2], v[2:] - v[1:-1]
        rev = np.degrees(np.sqrt(np.maximum(-(a1 * a2).sum(-1), 0)))
        hits += int((rev > flag).sum())
        if rev.max() > peak: peak, worst = float(rev.max()), (n, int(rev.argmax()) + 1)
    return dict(peak_deg=round(peak, 1), frames_over=hits, worst=worst)

def root_jitter_cm(roots):
    v = roots[1:] - roots[:-1]; a1, a2 = v[1:-1] - v[:-2], v[2:] - v[1:-1]
    return round(float(np.sqrt(np.maximum(-(a1 * a2).sum(-1), 0)).max() * 100), 2)

def foot_skate_cm(sk, P):
    """Mean slide of a toe while it is on the floor (within 3 cm of its clip's low point)."""
    ix = {n: i for i, n in enumerate(sk['names'])}; total, n = 0.0, 0
    for name in ('LeftToeBase', 'RightToeBase'):
        p = P[:, ix[name]]; floor = np.percentile(p[:, 1], 5)
        down = (p[:-1, 1] < floor + 0.03) & (p[1:, 1] < floor + 0.03)
        slide = np.linalg.norm((p[1:] - p[:-1])[:, [0, 2]], axis=-1)
        total += slide[down].sum(); n += int(down.sum())
    return round(total / max(n, 1) * 100, 2)

def deviation(sk, P0, P1):
    """How far the cleaned motion strays: mean / 95th-percentile joint distance (cm), root-relative."""
    d = np.linalg.norm((P1 - P1[:, :1]) - (P0 - P0[:, :1]), axis=-1)
    return dict(mean_cm=round(float(d.mean() * 100), 1), p95_cm=round(float(np.percentile(d, 95) * 100), 1))

def snap_kept(sk, P0, P1):
    """Peak hand/foot speed (vs hips) after / before, single-frame spikes ignored (3-frame median first)."""
    from scipy.signal import medfilt
    ix = {n: i for i, n in enumerate(sk['names'])}; ratios = []
    for n in ('LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'):
        sp = []
        for P in (P0, P1):
            p = P[:, ix[n]] - P[:, 0]; v = np.linalg.norm(p[1:] - p[:-1], axis=1); v = medfilt(v, 3)
            sp.append(np.sort(v)[-5:].mean())
        if sp[0] > 1e-3: ratios.append(sp[1] / sp[0])
    return round(float(np.mean(ratios)), 3)

def report(sk, roots, rots, P0=None):
    P, _ = fk(sk, roots, rots)
    r = dict(clip=clip_report(sk, P), jitter=jitter_report(sk, roots, rots), root_jitter_cm=root_jitter_cm(roots), skate_cm=foot_skate_cm(sk, P), anatomy=anatomy_report(sk, rots))
    if P0 is not None: r['deviation'] = deviation(sk, P0, P); r['snap_kept'] = snap_kept(sk, P0, P)
    return r

# --- physics (MuJoCo) --------------------------------------------------------------------------------------------
FIXED = lambda n: n.lower().endswith('end') or 'eye' in n.lower() or 'jaw' in n.lower()

def collision_geoms(sk):
    """Capsules for physics: one per bone segment the clip check uses, plus spine pieces so the torso bends."""
    rest = rest_positions(sk); ix = {n: i for i, n in enumerate(sk['names'])}; geoms = []
    def cap(body, a, b, r, name, extend=0.0):
        pa, pb = rest[ix[a]] - rest[ix[body]], rest[ix[b]] - rest[ix[body]]
        if extend:
            d = pb - pa; pb = pb + d / np.linalg.norm(d) * extend
        geoms.append((body, name, pa, pb, r))
    for pre in ('Left', 'Right'):
        cap(pre + 'Arm', pre + 'Arm', pre + 'ForeArm', 0.05, pre + ' upper arm')
        cap(pre + 'ForeArm', pre + 'ForeArm', pre + 'Hand', 0.04, pre + ' forearm')
        cap(pre + 'Hand', pre + 'Hand', pre + 'HandMiddleEnd', 0.03, pre + ' hand')
        cap(pre + 'Leg', pre + 'Leg', pre + 'Shin', 0.07, pre + ' thigh')
        cap(pre + 'Shin', pre + 'Shin', pre + 'Foot', 0.055, pre + ' shin')
        cap(pre + 'Foot', pre + 'Foot', pre + 'ToeBase', 0.04, pre + ' foot')
    cap('Hips', 'Hips', 'Spine2', 0.13, 'pelvis')
    cap('Spine2', 'Spine2', 'Chest', 0.13, 'belly')
    cap('Chest', 'Chest', 'Neck1', 0.12, 'chest')
    cap('Neck1', 'Neck1', 'Head', 0.06, 'neck')
    cap('Head', 'Neck1', 'Head', 0.10, 'head', 0.2)
    return geoms

def group_of(name):
    if 'arm' in name or 'hand' in name: return 'arm-' + name.split()[0]
    if 'thigh' in name or 'shin' in name or 'foot' in name: return 'leg-' + name.split()[0]
    return 'head' if name in ('neck', 'head') else 'torso'

def mjcf(sk, floor_y, weld_tc, contact_tc, dt=1/600, props=()):
    names, parents = sk['names'], sk['parents']; off = np.array(sk['offsets'], float)
    geoms = collision_geoms(sk); by_body = {}
    for g in geoms: by_body.setdefault(g[0], []).append(g)
    children = {}
    for j, p in enumerate(parents): children.setdefault(p, []).append(j)
    f = lambda v: ' '.join('%.5f' % x for x in v)
    def body(j, indent):
        n = names[j]; pad = '  ' * indent
        s = f'{pad}<body name="{n}" pos="{f(off[j]) if parents[j] >= 0 else "0 0 0"}">\n'
        if parents[j] < 0: s += f'{pad}  <freejoint name="root"/>\n'
        elif not FIXED(n): s += f'{pad}  <joint name="{n}" type="ball" damping="2" armature="0.01"/>\n'
        for (_, gname, pa, pb, r) in by_body.get(n, []):
            s += f'{pad}  <geom name="{gname}" type="capsule" fromto="{f(pa)} {f(pb)}" size="{r}"/>\n'
        if not by_body.get(n): s += f'{pad}  <geom type="sphere" size="0.01" contype="0" conaffinity="0" mass="0.05"/>\n'
        for c in children.get(j, []): s += body(c, indent + 1)
        return s + f'{pad}</body>\n'
    root = children[-1][0]
    mocap = ''.join(f'    <body name="t_{n}" mocap="true"/>\n' for n in names)
    welds = ''.join(f'    <weld body1="t_{n}" body2="{n}" relpose="0 0 0 1 0 0 0" solref="{weld_tc} 1" solimp="0.9 0.95 0.001"/>\n' for n in names)
    gnames = [g[1] for g in geoms]
    excl = []
    for i, a in enumerate(gnames):
        for b in gnames[i + 1:]:
            ga, gb = group_of(a), group_of(b)
            if ga == gb or {ga, gb} <= {'torso', 'head'}: excl.append((a, b)); continue
            if ('upper arm' in a and gb == 'torso') or ('upper arm' in b and ga == 'torso'): excl.append((a, b)); continue
            if 'thigh' in a and 'thigh' in b: excl.append((a, b)); continue
            if ('thigh' in a and gb == 'torso') or ('thigh' in b and ga == 'torso'): excl.append((a, b)); continue
            if a.endswith(' hand') and b.endswith(' hand'): excl.append((a, b)); continue
            # hands resting on one's own trunk are normal (push-up under the chest, hands on hips, clapping the chest):
            # the fat trunk capsules shoved them away (a push-up's hands went 34 cm off the floor)
            if (a.endswith(' hand') and gb == 'torso') or (b.endswith(' hand') and ga == 'torso'): excl.append((a, b))
    body_of = {g[1]: g[0] for g in geoms}
    exclude = ''.join(f'    <exclude body1="{body_of[a]}" body2="{body_of[b]}"/>\n' for a, b in excl if body_of[a] != body_of[b])
    return f'''<mujoco model="understudy">
  <option timestep="{dt:.6f}" gravity="0 -9.81 0" iterations="50" ls_iterations="20"/>
  <default><geom density="1000" friction="1 0.05 0.01" solref="{contact_tc} 1" solimp="0.95 0.99 0.001" condim="3"/></default>
  <worldbody>
    <geom name="floor" type="plane" size="50 50 0.1" zaxis="0 1 0" pos="0 {floor_y:.4f} 0"/>
{''.join(f'    <geom name="prop{i}" type="box" size="{p["size"][0]/2:.4f} {p["size"][1]/2:.4f} {p["size"][2]/2:.4f}" pos="{p["pos"][0]:.4f} {p["pos"][1] + p["size"][1]/2:.4f} {p["pos"][2]:.4f}" axisangle="0 1 0 {p.get("yaw", 0.0):.5f}"/>{chr(10)}' for i, p in enumerate(props) if p.get("kind", "box") == "box")}{body(root, 2)}{mocap}  </worldbody>
  <equality>
{welds}  </equality>
  <contact>
{exclude}  </contact>
</mujoco>'''

def physics(sk, roots, rots, strength=0.5, substeps=20, weld_tc=None, contact_tc=0.004, props=()):
    """Track the clip with a colliding body. strength 1 follows the clip tightly, 0 lets physics lead more."""
    import mujoco
    P, G = fk(sk, roots, rots)
    ix = {n: i for i, n in enumerate(sk['names'])}
    toes = P[:, [ix['LeftToeBase'], ix['RightToeBase']]][..., 1]
    floor_y = float(np.percentile(toes.min(axis=1), 5)) - 0.04   # toe joints sit ~4 cm above the sole
    if weld_tc is None: weld_tc = 0.012 + (1 - strength) * 0.05
    m = mujoco.MjModel.from_xml_string(mjcf(sk, floor_y, weld_tc, contact_tc, 1 / (30 * substeps), props=props))
    d = mujoco.MjData(m)
    names = sk['names']; T, J = rots.shape[:2]
    mocap_id = [m.body(f't_{n}').mocapid[0] for n in names]
    body_id = [m.body(n).id for n in names]
    # start in the first frame's pose: root free joint then ball joints in tree order
    def set_qpos(f):
        jid = m.joint('root').id; a = m.jnt_qposadr[jid]
        d.qpos[a:a + 3] = roots[f]; d.qpos[a + 3:a + 7] = rots[f, 0][[3, 0, 1, 2]]
        for j, n in enumerate(names):
            if j == 0 or FIXED(n): continue
            a = m.jnt_qposadr[m.joint(n).id]; d.qpos[a:a + 4] = rots[f, j][[3, 0, 1, 2]]
    set_qpos(0); mujoco.mj_forward(m, d)
    Gq = np.stack([g.as_quat() for g in G], 1)          # T,J,4 xyzw world
    out_P = np.zeros((T, J, 3)); out_Q = np.zeros((T, J, 4))
    for f in range(T):
        f2 = min(f + 1, T - 1)
        for s in range(substeps):
            t = (s + 1) / substeps
            if f == T - 1: t = 0
            pos = P[f] * (1 - t) + P[f2] * t
            for j in range(J):
                q0, q1 = Gq[f, j], Gq[f2, j]
                if np.dot(q0, q1) < 0: q1 = -q1
                q = q0 * (1 - t) + q1 * t; q /= np.linalg.norm(q)
                d.mocap_pos[mocap_id[j]] = pos[j]; d.mocap_quat[mocap_id[j]] = q[[3, 0, 1, 2]]
            mujoco.mj_step(m, d)
        out_P[f] = d.xpos[body_id]; out_Q[f] = d.xquat[body_id][:, [1, 2, 3, 0]]
    # world -> parent-local rotations
    parents = sk['parents']; new = np.zeros_like(rots)
    for j in range(J):
        if parents[j] < 0: new[:, j] = out_Q[:, j]
        else: new[:, j] = (R.from_quat(out_Q[:, parents[j]]).inv() * R.from_quat(out_Q[:, j])).as_quat()
    for j, n in enumerate(names):          # end sites / face keep the clip's own local turn
        if FIXED(n): new[:, j] = rots[:, j]
    return out_P[:, 0].copy(), new

# --- declip: push what overlaps out, eased --------------------------------------------------------------------------
def declip(sk, roots, rots, margin=0.005, ease=4, passes=4, arms_only=False):
    """Frame-by-frame: for each clipping pair, turn the moving limb's upper joint so its capsule leaves the other."""
    names = sk['names']; ix = {n: i for i, n in enumerate(names)}; parents = sk['parents']
    parts = parts_of(sk); T = rots.shape[0]
    rots = rots.copy()
    # which joint turns a part out of contact: a forearm/hand turns at the elbow then the shoulder; a shin at the knee then the hip
    lever = {}
    for pre in ('Left', 'Right'):
        lever[pre + ' hand'] = [pre + 'ForeArm', pre + 'Arm']; lever[pre + ' forearm'] = [pre + 'Arm']
        lever[pre + ' upper arm'] = [pre + 'Arm']; lever[pre + ' shin'] = [pre + 'Leg']
        lever[pre + ' foot'] = [pre + 'Shin', pre + 'Leg']; lever[pre + ' thigh'] = [pre + 'Leg']
    fixes = np.zeros((T, len(names), 3))   # rotation vectors added per frame (in parent-local terms), eased after
    for _ in range(passes):
        P, G = fk(sk, roots, rots); moved = False
        for i, a in enumerate(parts):
            for b in parts[i + 1:]:
                if not check_pair(a, b): continue
                if arms_only and not (a['group'].startswith('arm') or b['group'].startswith('arm')): continue   # after the foot lock: feet stay
                ea, eb = capsule_end(P, a), capsule_end(P, b)
                dist, ca, cb = seg_dist(P[:, a['a']], ea, P[:, b['a']], eb)
                pen = a['r'] + b['r'] - dist + margin
                hit = np.where(pen > margin)[0]
                if not len(hit): continue
                # move the limb part (arms before legs; the free part, not torso/head)
                # move the more distal limb part: it swings clear with the least change (a hand before a forearm,
                # any arm part before a leg part, never the torso or head)
                rank = lambda p: next((i for i, k in enumerate(('hand', 'forearm', 'foot', 'shin', 'upper arm', 'thigh')) if p['name'].endswith(k)), 99)
                mover, other, cm, co = (a, b, ca, cb) if rank(a) <= rank(b) else (b, a, cb, ca)
                if mover['name'] not in lever: continue
                for f in hit:
                    push = cm[f] - co[f]; nrm = np.linalg.norm(push)
                    push = push / nrm if nrm > 1e-6 else np.array([0, 0, 1.0])
                    target = cm[f] + push * pen[f]
                    for jn in lever[mover['name']][:1]:
                        j = ix[jn]; pj = P[f, j]
                        u, v = cm[f] - pj, target - pj
                        if np.linalg.norm(u) < 1e-4: continue
                        axis = np.cross(u, v); s = np.linalg.norm(axis)
                        if s < 1e-9: continue
                        ang = np.arctan2(s, np.dot(u, v))
                        rw = R.from_rotvec(axis / s * ang)                 # world turn about the joint
                        gp = G[parents[j]][f] if parents[j] >= 0 else R.identity()
                        local = gp.inv() * rw * gp * R.from_quat(rots[f, j])
                        delta = (local * R.from_quat(rots[f, j]).inv()).as_rotvec()
                        fixes[f, j] += delta
                        rots[f, j] = local.as_quat()
                        moved = True
        if not moved: break
    # ease: spread each frame's fix over ±ease frames so the push-out has no pop
    if ease > 0 and np.abs(fixes).max() > 0:
        out = rots.copy()
        P0 = None
        w = np.hanning(2 * ease + 3)[1:-1]; w = w / w.max()
        spread = np.zeros_like(fixes)
        for f in range(T):
            if not np.abs(fixes[f]).any(): continue
            for k, wk in enumerate(w):
                g = f + k - ease
                if 0 <= g < T:
                    mag_new = np.linalg.norm(fixes[f] * wk, axis=-1); mag_old = np.linalg.norm(spread[g], axis=-1)
                    take = mag_new > mag_old
                    spread[g][take] = (fixes[f] * wk)[take]
        base = rots_before = None
        return spread
    return fixes

def apply_fixes(rots, spread):
    out = rots.copy(); T, J = rots.shape[:2]
    for j in range(J):
        if not np.abs(spread[:, j]).any(): continue
        out[:, j] = (R.from_rotvec(spread[:, j]) * R.from_quat(rots[:, j])).as_quat()
    return out

def declip_eased(sk, roots, rots, rounds=3, arms_only=False):
    """Push-out fixes computed on the current motion, spread smoothly, applied; repeated until nothing clips."""
    for _ in range(rounds):
        P, _ = fk(sk, roots, rots)
        if clip_report(sk, P, depth=0.0)['frames'] == 0: break
        spread = declip(sk, roots, rots, arms_only=arms_only)
        rots = apply_fixes(rots, spread)
    return rots


def hand_clip_mask(sk, roots, rots, depth=0.01):
    """Per side: frames where the hand or forearm as generated overlaps the torso, head or a leg by more than
    `depth` (a hand through the thigh in a crumpled fall). The hand lock leaves those frames alone."""
    P, _ = fk(sk, roots, rots); parts = parts_of(sk); T = len(roots); out = {'Left': np.zeros(T, bool), 'Right': np.zeros(T, bool)}
    for i, a in enumerate(parts):
        for b in parts[i + 1:]:
            if not check_pair(a, b): continue
            for arm, other in ((a, b), (b, a)):
                m = re.match(r'(Left|Right) (hand|forearm)$', arm['name'])
                if not m or other['group'].startswith('arm'): continue
                ea, eb = capsule_end(P, a), capsule_end(P, b)
                dist, _, _ = seg_dist(P[:, a['a']], ea, P[:, b['a']], eb)
                out[m.group(1)] |= (a['r'] + b['r'] - dist) > depth
    return out

# --- residual: keep the clip's own detail, take only the physics corrections (slow by nature) -------------------
# the trunk's bones and the child that sets each one's direction. Only the trunk: its spin drifts in the simulation and
# drags what hangs off it (the shoulders sit 5 cm off the chest's axis). Arms and legs keep physics' spin: there it is
# the better one (Kimodo's own limb spins flip now and then, a thigh 175° in one frame, and physics smooths them)
SPIN_CHILD = {'Spine1': 'Spine2', 'Spine2': 'Chest', 'Chest': 'Neck1', 'Neck1': 'Neck2', 'Neck2': 'Head',
              'LeftShoulder': 'LeftArm', 'RightShoulder': 'RightArm'}

def despin(sk, roots0, rots0, rots1):
    """The simulated body is capsules, and a capsule is the same however it is spun about its own length, so physics
    never holds that spin and on the trunk it drifts (a lying chest turned 161° over a clip, dragging the shoulders
    12 cm). Each trunk bone keeps the direction physics gave it and the spin about it the clip had: the smallest turn
    from the clip's bone to physics' bone. Joints along the spine stay exactly where physics put them."""
    names, parents = sk['names'], sk['parents']; ix = {n: i for i, n in enumerate(names)}
    off = np.array(sk['offsets'], float)
    _, G0 = fk(sk, roots0, rots0); _, G1 = fk(sk, roots0, rots1)
    Gn = [None] * len(names); out = rots1.copy()
    for j, n in enumerate(names):
        p = parents[j]
        if n in SPIN_CHILD and p >= 0:
            a = off[ix[SPIN_CHILD[n]]]; a = a / np.linalg.norm(a)
            b0, b1 = G0[j].apply(a), G1[j].apply(a)              # the bone in the world: clip, physics
            ax = np.cross(b0, b1); sn = np.linalg.norm(ax, axis=1); cs = (b0 * b1).sum(1)
            ang = np.arctan2(sn, cs); ax = ax / np.maximum(sn, 1e-12)[:, None]
            Gn[j] = R.from_rotvec(ax * ang[:, None]) * G0[j]
            out[:, j] = (Gn[p].inv() * Gn[j]).as_quat()
        else:
            Gn[j] = G1[j] if p < 0 else Gn[p] * R.from_quat(rots1[:, j])
    return out

def on_prop_mask(sk, roots, rots, props, tol=0.06):
    """Per frame: some body surface sits on a box top (inside its footprint, within tol of the top)."""
    P, G = fk(sk, roots, rots); T = len(roots); mask = np.zeros(T, bool)
    pts = proxy()
    for name, loc in pts.items():
        if name not in sk['names']: continue
        j = sk['names'].index(name); M = G[j].as_matrix()
        W = P[:, j][:, None, :] + np.einsum('tij,nj->tni', M, np.asarray(loc))      # [T, n, 3]
        for p in props:
            if p.get('kind', 'box') != 'box': continue
            c, s_ = np.cos(p.get('yaw', 0.0)), np.sin(p.get('yaw', 0.0))
            dx, dz = W[..., 0] - p['pos'][0], W[..., 2] - p['pos'][2]
            lx, lz = dx * c + dz * s_, -dx * s_ + dz * c
            inside = (np.abs(lx) <= p['size'][0] / 2) & (np.abs(lz) <= p['size'][2] / 2)
            top = p['pos'][1] + p['size'][1]
            near = np.abs(W[..., 1] - top) <= tol
            mask |= (inside & near).any(axis=1)
    return mask


def residual_blend(roots0, rots0, roots1, rots1, sigma=2.0):
    """out = original + smoothed(physics - original). Collision and floor corrections vary slowly and survive the
    smoothing; the physics lag that blunts a strike is high-frequency and is dropped, so peaks keep their snap."""
    from scipy.ndimage import gaussian_filter1d
    dr = gaussian_filter1d(roots1 - roots0, sigma, axis=0, mode='nearest')
    out = rots0.copy(); T, J = rots0.shape[:2]
    for j in range(J):
        d = (R.from_quat(rots0[:, j]).inv() * R.from_quat(rots1[:, j])).as_rotvec()
        d = gaussian_filter1d(d, sigma, axis=0, mode='nearest')
        out[:, j] = (R.from_quat(rots0[:, j]) * R.from_rotvec(d)).as_quat()
    return roots0 + dr, out

# --- denoise: tracked motion's frame-to-frame flicker, every joint, lightly ----------------------------------------
def denoise(roots, rots, sigma):
    """A gaussian over time (sigma in frames) on each joint's turn (as a rotation vector from its first frame) and the
    root. Light (0.6) it takes the tracker's flicker and keeps most of a strike; the deshake can't reach this noise
    (it refuses to move a fast limb)."""
    from scipy.ndimage import gaussian_filter1d
    out = rots.copy()
    for j in range(rots.shape[1]):
        q = R.from_quat(rots[:, j]); ref = q[0]
        rv = gaussian_filter1d((ref.inv() * q).as_rotvec(), sigma, axis=0, mode='nearest')
        out[:, j] = (ref * R.from_rotvec(rv)).as_quat()
    return gaussian_filter1d(roots, sigma, axis=0, mode='nearest'), out

# --- deshake: refit only the joints and frames that shake (like the server's smoother, finer) -------------------
def reversal_series(q):
    """Per-frame reversal (degrees) of a joint's turn track, aligned so index f is the frame where it reverses."""
    v = (R.from_quat(q[1:]) * R.from_quat(q[:-1]).inv()).as_rotvec()
    a1, a2 = v[1:-1] - v[:-2], v[2:] - v[1:-1]
    rev = np.zeros(len(q)); rev[1:-2] = np.degrees(np.sqrt(np.maximum(-(a1 * a2).sum(-1), 0)))
    return rev

def _subtree(sk, j):
    par = sk['parents']; out = [j]
    for c in range(len(par)):
        p = par[c]
        while p >= 0 and p not in out: p = par[p]
        if p in out and c not in out: out.append(c)
    return out


def _side_marks(sk):
    """Per joint, a point 5 cm off its bone's axis (in the joint's frame): a bone rolling about its own length moves
    no joint (a foot rolling onto its edge leaves the toe joint in place) but moves this point."""
    off = np.array(sk['offsets'], float); par = sk['parents']; marks = np.zeros((len(par), 3))
    for j in range(len(par)):
        kids = [c for c, p in enumerate(par) if p == j and np.linalg.norm(off[c]) > 1e-6]
        a = off[kids[0]] / np.linalg.norm(off[kids[0]]) if kids else np.array([0, 1.0, 0])
        side = np.cross(a, [0, 0, 1.0]) if abs(a[2]) < 0.9 else np.cross(a, [1.0, 0, 0])
        marks[j] = side / np.linalg.norm(side) * 0.05
    return marks


def _window_pos(sk, roots, rots, a, b, joints):
    """Hips-relative positions [b-a, 2*len(joints), 3] of a frame window, joints and their side marks (what a shake
    looks like on screen, a bone's roll included)."""
    P, G = fk(sk, roots[a:b], rots[a:b]); marks = _side_marks(sk)
    pts = [P[:, j] for j in joints] + [P[:, j] + G[j].apply(marks[j]) for j in joints]
    return np.stack(pts, 1) - P[:, :1]


def _reversal_cm(B):
    v = np.diff(B, axis=0); a1, a2 = v[1:-1] - v[:-2], v[2:] - v[1:-1]
    return np.sqrt(np.maximum(-(a1 * a2).sum(-1), 0)).max() * 100 if len(v) > 2 else 0.0


def deshake(sk, roots, rots, flag=12.0, window=4, passes=4, max_move=0.04, keep_snap=False, skip_legs=False):
    """Smooth a joint's track where it shakes (turn reverses by more than `flag` degrees frame to frame). A smoothing
    is kept only when it does what it is for, judged on what is seen (positions of the joint and everything below it):
    the back-and-forth must drop, and nothing may move further than `max_move` metres or the shake itself. Kimodo
    sometimes writes an arm's turn split differently between upper arm and forearm from one frame to the next: the
    track jumps while the arm moves smoothly, and smoothing it flings the arm (a backflip arm thrown out 45 cm)."""
    from scipy.signal import savgol_filter
    rots = rots.copy(); T, J = rots.shape[:2]
    subtree = {j: _subtree(sk, j) for j in range(J)}
    for _ in range(passes):
        changed = False
        for j, n in enumerate(sk['names']):
            ln = n.lower()
            if ln.endswith('end') or 'eye' in ln or 'jaw' in ln: continue
            if skip_legs and (ln == 'hips' or any(k in ln for k in ('leg', 'shin', 'foot', 'toe'))): continue
            rev = reversal_series(rots[:, j]); hits = np.where(rev > flag)[0]
            if not len(hits): continue
            spd = np.zeros(T); spd[1:] = np.degrees(np.linalg.norm((R.from_quat(rots[1:, j]) * R.from_quat(rots[:-1, j]).inv()).as_rotvec(), axis=1))   # the joint's turn per frame
            for f in hits:
                # a shake is a back-and-forth: more than one reversal within a few frames. A lone reversal of a fast
                # limb is it changing direction (a kick snapping out and back): smoothing it blunted a 5.6 m/s kick
                # to 4.7. A lone reversal of a slow limb is still a shake (a tracked clip's noise) and is smoothed.
                lone = (rev[max(0, f - 3):f + 4] > flag * 0.75).sum() < 2
                if keep_snap and lone and spd[max(0, f - 1):f + 2].max() > 8.0: continue
                a, b = max(0, f - window - 2), min(T, f + window + 3)
                if b - a < 7: continue
                ref = R.from_quat(rots[f, j])
                rv = (ref.inv() * R.from_quat(rots[a:b, j])).as_rotvec()          # small angles around this frame
                sm = savgol_filter(rv, min(9, (b - a) // 2 * 2 - 1), 2, axis=0)
                w = np.ones(b - a); taper = 2
                for k in range(taper): w[k] = w[-1 - k] = (k + 1) / (taper + 1)
                new = rv * (1 - w[:, None]) + sm * w[:, None]
                q = (ref * R.from_rotvec(new)).as_quat()
                sub = subtree[j]; before = _window_pos(sk, roots, rots, a, b, sub)
                trial = rots[a:b].copy(); trial[:, j] = q
                after = _window_pos(sk, roots[a:b], trial, 0, b - a, sub)
                shake0, shake1 = _reversal_cm(before), _reversal_cm(after)
                moved = np.linalg.norm(after - before, axis=-1).max()
                if shake1 >= shake0 - 0.05 or moved > max(max_move, shake0 / 100): continue
                rots[a:b, j] = q; changed = True
        if skip_legs:   # legs and root left alone (planted feet stay exactly where the foot passes put them)
            if not changed: break
            continue
        # the root's travel, in centimetres per frame squared
        v = roots[1:] - roots[:-1]; acc1, acc2 = v[1:-1] - v[:-2], v[2:] - v[1:-1]
        rr = np.sqrt(np.maximum(-(acc1 * acc2).sum(-1), 0)) * 100
        for f in np.where(rr > 0.8)[0] + 1:       # the server flags the root above 1.2 cm/frame²
            a, b = max(0, f - window - 3), min(T, f + window + 4)
            if b - a >= 7:
                sm = savgol_filter(roots[a:b], min(11, (b - a) // 2 * 2 - 1), 2, axis=0)
                w = np.ones(b - a); w[0] = w[-1] = 0.33; w[1] = w[-2] = 0.66
                roots[a:b] = roots[a:b] * (1 - w[:, None]) + sm * w[:, None]; changed = True
        if not changed: break
    return roots, rots

# --- main ---------------------------------------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('in_dir'); ap.add_argument('out_dir')
    ap.add_argument('--mode', default='physics+deshake+declip+contact')
    ap.add_argument('--strength', type=float, default=0.95)
    ap.add_argument('--shake', type=float, default=12.0)
    ap.add_argument('--weldtc', type=float, default=0.0)
    ap.add_argument('--substeps', type=int, default=20)
    ap.add_argument('--residual', type=float, default=0.0)  # >0: keep the clip's detail, take the physics corrections smoothed by this sigma (frames). Right for tracked motion (its detail is the truth: a 5.6 m/s kick lagged to 4.1 without it); wrong for generated clips (it keeps Kimodo's shakes: 5 of 24 bench clips gained a jitter flag)
    ap.add_argument('--no-plant', action='store_true')  # skip plant.py (glides held, then stepped)
    ap.add_argument('--no-gaze', action='store_true')   # skip gaze.py (a head held staring at the floor or the sky, levelled)
    ap.add_argument('--loose', action='store_true')     # loose.py: follow-through springs on the arms (the server asks for it on everyday moves)
    ap.add_argument('--hold-feet', action='store_true')  # in-place moves (crouch, pick up): planted toes stay put
    ap.add_argument('--plant-only', action='store_true')  # only plant.py: glides held, then stepped (the Checks fix for a slide)
    ap.add_argument('--lift-only', default='')  # 'FROM:TO': only lift the glides in those frames into steps, nothing else (a generated clip's flagged slide)
    ap.add_argument('--keep-snap', action='store_true')  # tracked motion: a lone fast reversal (a kick snapping back) is not smoothed as a shake
    ap.add_argument('--denoise', type=float, default=0.0)  # tracked motion: a gaussian (sigma frames) over every joint's turn and the root first, for the tracker's frame-to-frame flicker (0.6: a spell cast's hand reversals 8 -> 1, a kick's peak 77 % kept)
    ap.add_argument('--no-report', action='store_true')    # the server computes its own checks: skip the diagnostics (~1.7 s)
    a = ap.parse_args(argv)
    global report
    if a.no_report:
        report = lambda *args, **kw: {}
    sk, roots, rots = load_clip(a.in_dir)
    if a.plant_only:
        from plant import plant_steps
        roots, rots, done = plant_steps(sk, roots, rots)
        save_clip(a.out_dir, roots, rots)
        json.dump(sk, open(os.path.join(a.out_dir, 'skeleton.json'), 'w'))
        json.dump({'plant_steps': [list(d) for d in done]}, open(os.path.join(a.out_dir, 'report.json'), 'w'))
        return
    if a.lift_only:
        f0, f1 = (int(x) for x in a.lift_only.split(':'))
        P_, G_ = fk(sk, roots, rots); low_ = surface_low(sk, P_, G_)
        floor_ = float(np.percentile(np.minimum(low_['LeftToeBase'], low_['RightToeBase']), 5))
        rots, lifted = lift_steps(sk, roots, rots, floor_, fast=0.005, travel_min=0.06, window=(f0, f1))
        save_clip(a.out_dir, roots, rots)
        json.dump(sk, open(os.path.join(a.out_dir, 'skeleton.json'), 'w'))
        json.dump({'lifted': [list(map(lambda v: v if not isinstance(v, float) else round(v, 3), l)) for l in lifted]}, open(os.path.join(a.out_dir, 'report.json'), 'w'))
        return
    if a.denoise > 0: roots, rots = denoise(roots, rots, a.denoise)
    props = load_props(a.in_dir)
    roots0, rots0 = roots.copy(), rots.copy()      # the clip as generated: the foot lock puts planted feet back here
    # frames where the body rests on a prop (a seat, a ledge): the floor-based contact passes do not apply there
    on_prop = on_prop_mask(sk, roots, rots, props) if props else None
    P0, _ = fk(sk, roots, rots)
    rep = {'before': report(sk, roots, rots)}
    rots = enforce_anatomy(sk, rots)          # a contorted pose is pulled back first, so physics starts from a body
    if 'physics' in a.mode:
        r0, q0 = roots, rots
        roots, rots = physics(sk, roots, rots, strength=a.strength, substeps=a.substeps, weld_tc=a.weldtc or None, contact_tc=min(0.004, (a.weldtc or 0.012) * 0.5), props=props)
        rots = despin(sk, r0, q0, rots)      # physics' bones, the clip's spin about them
        if a.residual > 0:
            roots, rots = residual_blend(r0, q0, roots, rots, a.residual)
        rep['after_physics'] = report(sk, roots, rots, P0)
    for _ in range(2):        # smoothing can nudge a limb back in, the push-out can add a small bump: alternate
        if 'deshake' in a.mode:
            roots, rots = deshake(sk, roots, rots, flag=a.shake, passes=6, keep_snap=a.keep_snap)
        if 'declip' in a.mode:
            rots = declip_eased(sk, roots, rots)
    if 'contact' in a.mode:   # the body touches the floor where it should, nowhere through it (contact.py)
        rots = enforce_anatomy(sk, rots)      # first, so a neck clamped later cannot drop the head back into the floor
        pre_y = roots[:, 1].copy()
        keep_r, keep_q = roots.copy(), rots.copy()
        roots, rots, rep['contact'] = contact_pass(sk, roots, rots)
        if on_prop is not None and on_prop.any():   # resting on a prop: the floor passes' edits do not apply there
            roots[on_prop], rots[on_prop] = keep_r[on_prop], keep_q[on_prop]
            rep['contact']['on_prop_frames'] = int(on_prop.sum())
        # the frames the contact pass lowered onto the floor (floats, sitting on nothing) must stay down
        # and a body lying or rolling on the floor (the trunk lowest) stays on it; feet stay free (a walk's bounce)
        fl = rep['contact']['floor']
        touch_mask = touching(sk, roots, rots, fl) & (roots[:, 1] < pre_y - 1e-3)
        pull_mask = touching(sk, roots, rots, fl, trunk_only=True)
        if 'deshake' in a.mode:   # contact edits (IK, settling) can shake a knee or the hips: the targeted smoothing again
            roots, rots = deshake(sk, roots, rots, flag=a.shake, passes=3, keep_snap=a.keep_snap)
    rots = enforce_anatomy(sk, rots)          # and nothing the passes did may leave a joint outside its range
    if 'declip' in a.mode:    # a joint pulled back inside its range can land an arm in the body (a crumpled fall): out again
        rots = declip_eased(sk, roots, rots)
    if 'contact' in a.mode:   # last word: nothing ends under the floor (the joint limits can pull a head or hand down)
        rots = smooth_feet(sk, rots)   # physics and IK tilt the feet a little every frame: a light smoothing of feet only
        rots = ankle_guard(sk, rots0, rots)   # and no foot curled back past the generated clip's own bend
        roots, rots, rep['contact']['lifted_last'] = lift_out(sk, roots, rots, rep['contact']['floor'])
        if 'deshake' in a.mode:   # the lift's leg IK can pop a knee on the frames it touches: smooth those once more
            roots, rots = deshake(sk, roots, rots, flag=a.shake, passes=2, keep_snap=a.keep_snap)
        rots = clamp_exact(sk, rots)          # the lift's IK may bend an elbow or knee a degree past its range
        if on_prop is not None:
            touch_mask = touch_mask & ~on_prop; pull_mask = pull_mask & ~on_prop
        roots, rep['contact']['root_fit_m'] = root_fit(sk, roots, rots, rep['contact']['floor'], touch_mask, pull_mask=pull_mask)
        # (tipping a body over its support edge was removed: it rotated whole clips — a push-up plank moved 39 cm)
        # feet last: planted feet back exactly where the generator put them (leg IK absorbs the body's changes)
        if a.keep_snap:   # tracked motion: a foot gliding at speed is a step whose lift the tracker missed
            rots, rep['contact']['steps_lifted'] = lift_steps(sk, roots, rots, rep['contact']['floor'])
        rots, rep['contact']['feet_locked'] = foot_lock(sk, roots0, rots0, roots, rots, rep['contact']['floor'])
        if a.hold_feet:   # in-place moves: a planted toe stays where it landed (the foot lock follows the generator's drift)
            rots, rep['contact']['feet_held'] = hold_feet(sk, roots, rots, rep['contact']['floor'])
        if not a.keep_snap and not a.no_plant:   # generated motion: a foot that glides or spins while down is held, then steps
            from plant import plant_steps     # (plant.py: blind A/B on 7 sliding takes, correctness 5.3 -> 7.4, feel 6.4 -> 7.0)
            roots, rots, rep['contact']['plant_steps'] = plant_steps(sk, roots, rots, window=None)
        if not a.keep_snap:   # a glide with both feet in the air and flat hips is a hover, not a jump: grounded (hover.py)
            from hover import ground_hovers
            roots, rots, rep['contact']['hovers'] = ground_hovers(sk, roots, rots, rep['contact']['floor'])
        # after the feet: the foot lock holds one place per plant and would move a kneeling leg's foot (and lift the knee)
        rots, rep['contact']['knees_locked'] = knee_lock(sk, roots0, rots0, roots, rots, rep['contact']['floor'])
        rots, rep["contact"]["hands_locked"] = hand_lock(sk, roots0, rots0, roots, rots, rep["contact"]["floor"], skip=hand_clip_mask(sk, roots0, rots0), props=props)
        if props:   # near a box the hands follow the clip as given (physics lag pulled a hand into a table edge)
            rots, rep["contact"]["hands_near_props"] = hand_keep_near_props(sk, roots0, rots0, roots, rots, props, skip=hand_clip_mask(sk, roots0, rots0))
        if a.loose and not a.keep_snap:   # arms that lag and swing past as the body moves (loose.py; blind A/B: walks and turns won)
            from loose import loosen
            rots = loosen(sk, roots, rots, 0.5)
        if not a.keep_snap and not a.no_gaze:   # generated motion: the head's sustained floor-stare / sky-gaze levelled (gaze.py), before the
            # arms' push-out so a lifted head never ends up inside a raised hand
            from gaze import level_gaze
            rots, rep['contact']['gaze'] = level_gaze(sk, roots, rots, skip=on_prop)
        if 'declip' in a.mode:   # the hand lock can bring an arm back into the body: arms pushed out once more, feet untouched
            rots = declip_eased(sk, roots, rots, arms_only=True)
        if 'deshake' in a.mode:   # the hand lock and the arm push-out run after every smoothing: their per-frame IK can
            # snap an arm (a pick-up's hands against the shins, 25 cm). Arms, spine and head once more; legs and root untouched
            roots, rots = deshake(sk, roots, rots, flag=a.shake, passes=2, keep_snap=a.keep_snap, skip_legs=True)
        rots = clamp_exact(sk, rots)          # the locks' IK may turn an ankle, knee or elbow a degree past its range
    rep['after'] = report(sk, roots, rots, P0)
    save_clip(a.out_dir, roots, rots)
    json.dump(sk, open(os.path.join(a.out_dir, 'skeleton.json'), 'w'))
    json.dump(rep, open(os.path.join(a.out_dir, 'report.json'), 'w'), indent=1)
    if not a.no_report:
        print(json.dumps(rep))
    return rep

def serve():
    """The server keeps one clean-up process: libraries load once (~2.4 s saved per clip). One job per line on stdin
    (a JSON list of command-line arguments), one reply line: OK, or ERR and the reason."""
    import sys, traceback
    real_report = report
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            globals()['report'] = real_report
            main(json.loads(line))
            sys.stdout.write('OK' + chr(10))
        except BaseException as e:   # argparse exits on bad arguments: report, keep serving
            msg = (traceback.format_exc().strip().splitlines() or [repr(e)])[-1]
            sys.stdout.write('ERR ' + msg.replace(chr(10), ' ') + chr(10))
        sys.stdout.flush()

if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == '--serve':
        serve()
    else:
        main()
