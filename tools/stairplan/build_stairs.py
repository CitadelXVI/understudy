"""Stair key poses from the standing starter pose, as Kimodo constraints (2026-11-08).

usage: build_stairs.py <up|down> <steps> <rise_m> <tread_m> <step_frames> <style: over|to|two> <out.json>

Kimodo knows only flat ground: "a person walks up a flight of stairs" steps in place. A real climb is a few key poses with
the model moving between them, as the turn plan does: at each footfall the lead foot lands on its tread (toes short of the
riser, at that tread's height) with the trailing leg nearly straight and the hips just over the lower foot's standing
height; mid-swing the hips have risen over the lead foot and the swinging foot passes over the stair it stands on. The
hips are pinned in 3-D (the climb), the feet by position and rotation; the arms are the model's.

Styles: over = one stair a step (step over step); to = both feet on every stair (the lead foot steps up, the other joins
it: an old, hurt or tired person's); two = two stairs a step (in a hurry).
Stairs start 0.22 m in front of the standing toes; the flight runs along +z. Heights are metres above the floor (y up).
"""
import os, sys, json, numpy as np
from scipy.spatial.transform import Rotation as R
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, 'tools', 'cleanup'))
import contact as C

sk = json.load(open(os.environ.get('SOMA30_JSON', os.path.join(REPO, 'soma30.json')))); ix = {n: i for i, n in enumerate(sk['names'])}
items = json.load(open(os.path.join(REPO, 'demo-output', 'poses.json')))
st = [p for p in items if p['name'].lower().endswith('standing') and p.get('skeleton_key') == 'soma30'][0]
ROOT = np.array(st['root'], float); ROTS = np.array(st['rotations'], float)
P0, G0 = C.fk(sk, ROOT[None], ROTS[None])
LF, RF = ix['LeftFoot'], ix['RightFoot']
FLOOR = min(P0[0, LF][1], P0[0, RF][1]) - 0.0      # ankle height of the standing pose (over a flat sole)
TOE = 0.19                                          # ankle to toe tip (m)
HEEL = 0.07                                         # ankle to heel back (m)
HIPS0 = ROOT[1]                                     # standing hips height


def world_rot(rots, root, j, Rw):
    _, G = C.fk(sk, root[None], rots[None])
    p = sk['parents'][j]
    Gp = G[p][0] if p >= 0 else R.identity()
    rots[j] = (Gp.inv() * Rw * G[j][0]).as_quat()


def foot_at(side, z, y, pitch=0.0):
    """the ankle at forward z, height y (over its sole's floor), flat or pitched (+ = toes down) by `pitch` radians"""
    f = LF if side == 'L' else RF
    p = P0[0, f].copy(); p[2] = z; p[1] = y
    q = G0[f][0]
    if pitch: q = R.from_rotvec([pitch, 0, 0]) * q
    return (p, q.as_quat())


def pose(hips_z, hips_y, feet, lean=0.0):
    """the standing pose with the hips moved to (hips_z, hips_y), the feet put where `feet` says (side -> (pos, quat)), and
    the chest leaning forward by `lean` radians"""
    rots = ROTS.copy()
    root = ROOT.copy(); root[2] = hips_z; root[1] = hips_y
    if lean: world_rot(rots, root, ix['Spine1'], R.from_rotvec(np.array([1.0, 0, 0]) * lean))
    for side, (p, q) in feet.items():
        name = 'Left' if side == 'L' else 'Right'
        rots = C.two_bone(sk, root[None], rots[None], C.LEG[name], p[None], [0], end_global=q[None])[0]
    return root, rots


def plan(direction, steps, rise, tread, P, style):
    """keys [(frame, (root, rots))] for a flight of `steps` stairs (the last one a landing) with `P` frames a step"""
    up = direction == 'up'
    z0 = (P0[0, LF][2] + TOE) + 0.22 if up else (P0[0, LF][2] + TOE) + 0.03   # the first riser (up) / the top edge (down)
    base = 0.0 if up else rise * steps     # going down, the walk starts on a platform the flight's height up
    def height(k):      # tread k's top above the floor (k = 0 where the walk starts)
        return base + (rise * k if up else -rise * k)
    def land_z(k):      # where an ankle stands on tread k: toes a centimetre short of its far edge (up) / heel on it (down)
        near = z0 + (k - 1) * tread if k > 0 else z0 - 0.5
        far = near + tread
        if k == 0: return P0[0, LF][2]
        if k >= steps: return near + 0.35       # the landing: a step onto it
        return max(far - TOE - 0.01, near + HEEL + 0.02) if up else min(near + HEEL + 0.05, far - TOE + 0.03)
    lean = np.radians(8) if up else np.radians(-2)
    # The footfalls: (foot, from tread, to tread), in order. Over: L to 1, R to 2, L to 3...; two: L to 2, R to 4...; to:
    # L to 1, R to 1, L to 2, R to 2... The flight ends on the landing (tread `steps`) with both feet on it.
    falls, on = [], {'L': 0, 'R': 0}
    side = 'L'
    while on['L'] < steps or on['R'] < steps:
        other = 'R' if side == 'L' else 'L'
        if style == 'to':
            k = on[other] if on[other] > on[side] else on[side] + 1
        else:
            k = on[other] + (2 if style == 'two' else 1)
        k = min(k, steps)
        if k == on[side]:
            side = other; continue
        falls.append((side, on[side], k))
        on[side] = k
        side = other
    keys, f = [], 10
    on = {'L': 0, 'R': 0}
    for n, (mover, k_from, k_to) in enumerate(falls):
        stand = 'R' if mover == 'L' else 'L'
        last = n == len(falls) - 1
        # mid-swing: the hips risen over the standing foot; the mover passing over the standing foot's stair, lifted clear
        zs, ys = land_z(on[stand]), FLOOR + height(on[stand])
        zm = (land_z(k_from) + land_z(k_to)) / 2
        ym = FLOOR + max(height(k_from), height(k_to), height(on[stand])) + (0.09 if up else 0.04)
        hips_mid_y = HIPS0 + height(on[stand]) - (0.05 if up else 0.09)
        keys.append((f + P // 2, pose(zs + (0.03 if up else -0.04), hips_mid_y,
                                      {stand: foot_at(stand, zs, ys), mover: foot_at(mover, zm, ym, 0.0 if up else np.radians(-10))}, lean)))
        on[mover] = k_to
        f += P
        # footfall: the mover down on its tread; going up the trailing leg nearly straight (hips over the lower foot),
        # going down the leading knee taking the drop (hips well down over the upper foot)
        lo, hi = (min, max) if up else (max, min)
        h_lo = lo(height(on['L']), height(on['R']))
        hips_y = HIPS0 + h_lo - (0.03 if up else 0.10)
        if on['L'] == on['R']: hips_y = HIPS0 + height(on['L']) - (0.02 if last else 0.04)
        hz = (land_z(on['L']) + land_z(on['R'])) / 2
        keys.append((f, pose(hz, hips_y, {s_: foot_at(s_, land_z(on[s_]), FLOOR + height(on[s_])) for s_ in ('L', 'R')}, lean * (0.3 if last else 1.0))))
    fin = keys[-1][1]
    keys += [(f + 16, fin), (f + 17, fin)]     # standing still on the landing, settled
    return keys


direction, steps, rise, tread, P, style, out = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5]), sys.argv[6], sys.argv[7]
keys = plan(direction, steps, rise, tread, P, style)
BASE = 0.0 if direction == 'up' else rise * steps
ROOT_START = ROOT.copy(); ROOT_START[1] += BASE
stand = [(fr, (ROOT_START, ROTS)) for fr in range(4)]
cons = [{'type': 'fullbody', 'frame_indices': [fr for fr, _ in stand], 'root_positions': [r.tolist() for _, (r, q) in stand],
         'local_joints_rot_xyzw': [q.tolist() for _, (r, q) in stand]},
        {'type': 'end-effector', 'joint_names': ['LeftFoot', 'RightFoot', 'Hips'], 'frame_indices': [fr for fr, _ in keys],
         'root_positions': [r.tolist() for _, (r, q) in keys], 'local_joints_rot_xyzw': [q.tolist() for _, (r, q) in keys]}]
# The stairs as stage boxes (one per tread, each from the floor up; the last a deep landing), for the sheets, the checks
# and Clean up: the floor is at y 0.02.
up = direction == 'up'
z0 = (P0[0, LF][2] + TOE) + (0.22 if up else 0.03)
props = []
for k in range(1, steps + 1):
    depth = tread if k < steps else 1.2
    zc = z0 + (k - 1) * tread + depth / 2
    h = rise * k if up else rise * (steps - k)
    if h > 0.01:
        props.append({'kind': 'box', 'name': 'stair%d' % k, 'pos': [float(ROOT[0]), 0.02, float(zc)], 'size': [1.0, float(h), float(depth)]})
if not up:
    # the platform the walk starts on, up to the top edge
    props.append({'kind': 'box', 'name': 'top', 'pos': [float(ROOT[0]), 0.02, float(z0 - 0.6)], 'size': [1.0, float(BASE), 1.2]})
json.dump({'frames': keys[-1][0] + 1, 'constraints': cons, 'props': props}, open(out, 'w'))
Pk, _ = C.fk(sk, np.array([r for _, (r, q) in keys]), np.array([q for _, (r, q) in keys]))
for (fr, _), p in zip(keys, Pk):
    l, r_ = p[LF], p[RF]
    print(f'frame {fr:3d}: hips y {p[0,1]:.2f} z {p[0,2]:+.2f}  L ({l[1]:.2f},{l[2]:+.2f})  R ({r_[1]:.2f},{r_[2]:+.2f})')
print(f'{len(keys)} keys, {keys[-1][0] + 1} frames')
