"""Turn-in-place key poses from the standing starter pose, as Kimodo constraints.

usage: build_turn.py <turn_deg (+left)> <variant: full|feet> <out.json>
Key poses (frames for 180; 90 is shorter): anticipation (head and chest lead, weight to the trailing foot), step 1
(lead foot opens to ~half the turn), step 2 (trailing foot comes round), square-up, then standing turned.
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
yaw = lambda h: R.from_rotvec([0, h, 0])


def world_rot(rots, j, Rw):
    """turn joint j's world rotation by Rw (its children follow)"""
    _, G = C.fk(sk, root_cur[None], rots[None])
    p = sk['parents'][j]
    Gp = G[p][0] if p >= 0 else R.identity()
    rots[j] = (Gp.inv() * Rw * G[j][0]).as_quat()


def world_yaw(rots, j, d):
    """turn joint j's world rotation by d about vertical (its children follow)"""
    _, G = C.fk(sk, root_cur[None], rots[None])
    p = sk['parents'][j]
    Gp = G[p][0] if p >= 0 else R.identity()
    Gj = G[j][0]
    rots[j] = (Gp.inv() * yaw(d) * Gj).as_quat()


def pose(body, lh, rh, drop=0.0, shift=None, chest=0.0, head=0.0, lift=None, arms=0.0, chin=None, place=None, at=None):
    """body heading, left/right foot headings (radians, + = left); drop: hips lower (m); shift: (side, m) weight over
    that foot; chest/head: extra yaw leading the turn"""
    global root_cur
    rots = ROTS.copy()
    root = yaw(body).apply(ROOT); rots[0] = (yaw(body) * R.from_quat(ROTS[0])).as_quat()
    root[1] -= drop
    if at is not None: root = root + np.array([at[0], 0.0, at[1]])   # the body moves; feet stay where placed
    tgt = {}
    for side, h in (('Left', lh), ('Right', rh)):
        f = ix[side + 'Foot']
        pos = yaw(h).apply(P0[0, f])
        if lift and lift[0] == side[0]:
            pos = pos.copy(); pos[1] += lift[1]
            pos[0] *= 0.8; pos[2] *= 0.8          # the swinging foot passes a little under the body
        tgt[side] = (pos, (yaw(h) * G0[f][0]).as_quat())
        if place and side[0] in place:
            tgt[side] = place[side[0]]
    if shift:
        side, m = shift; side = {'L': 'Left', 'R': 'Right'}[side]
        fx = tgt[side][0]; d = np.array([fx[0] - root[0], 0, fx[2] - root[2]]); n = np.linalg.norm(d)
        if n > 1e-6: root = root + d / n * min(m, n)
    root_cur = root
    if chest: world_yaw(rots, ix['Chest'], chest)
    if head: world_yaw(rots, ix['Neck1'], head)
    chin = CHIN if chin is None else chin  # chin up: the starter pose looks at the floor; a turn spots the new direction on the horizon
    if chin: world_rot(rots, ix['Neck2'], R.from_rotvec((yaw(body + head + chest).apply([1.0, 0, 0])) * -chin))
    # arms lag the turn a little (they hung glued to the sides)
    if arms:
        for side in ('Left', 'Right'): world_yaw(rots, ix[side + 'Arm'], arms)
    for side in ('Left', 'Right'):
        p, q = tgt[side]
        rots = C.two_bone(sk, root[None], rots[None], C.LEG[side], p[None], [0], end_global=q[None])[0]
    return root, rots


def plan(turn):
    s = 1.0 if turn >= 0 else -1.0; a = abs(turn)
    lead, trail = ('L', 'R') if s > 0 else ('R', 'L')
    def feet(lead_h, trail_h):
        return (lead_h, trail_h) if lead == 'L' else (trail_h, lead_h)
    T = np.radians
    if a >= np.radians(135):  # a turn-around: open step, cross-round, square up; a lifted swing between plants
        keys = [
            (12, dict(body=s * T(8), feet=feet(0, 0), drop=0.02, shift=(trail, 0.04), chest=s * T(14), head=s * T(35))),
            (17, dict(body=turn * 0.16, feet=feet(turn * 0.25, 0), drop=0.02, shift=(trail, 0.05), chest=s * T(18), head=s * T(35), lift=(lead, LIFT), arms=-s * T(10))),
            (22, dict(body=turn * 0.35, feet=feet(turn * 0.5, 0), drop=0.02, shift=(lead, 0.03), chest=s * T(16), head=s * T(30), arms=-s * T(14))),
            (27, dict(body=turn * 0.55, feet=feet(turn * 0.5, turn * 0.45), drop=0.02, shift=(lead, 0.05), chest=s * T(12), head=s * T(22), lift=(trail, LIFT), arms=-s * T(16))),
            (32, dict(body=turn * 0.75, feet=feet(turn * 0.5, turn), drop=0.02, shift=(trail, 0.03), chest=s * T(8), head=s * T(12), arms=-s * T(12))),
            (37, dict(body=turn * 0.9, feet=feet(turn * 0.75, turn), drop=0.018, shift=(trail, 0.05), chest=s * T(4), head=s * T(5), lift=(lead, LIFT * 0.85), arms=-s * T(8))),
            (42, dict(body=turn, feet=feet(turn, turn), drop=0.015, shift=None, chest=0, head=0, arms=s * T(4))),
        ]
        end = 48
    else:  # a quarter turn: open step, bring the other foot
        keys = [
            (10, dict(body=s * T(6), feet=feet(0, 0), drop=0.015, shift=(trail, 0.03), chest=s * T(12), head=s * T(28))),
            (15, dict(body=turn * 0.3, feet=feet(turn * 0.5, 0), drop=0.02, shift=(trail, 0.05), chest=s * T(12), head=s * T(22), lift=(lead, LIFT), arms=-s * T(10))),
            (20, dict(body=turn * 0.55, feet=feet(turn, 0), drop=0.02, shift=(lead, 0.03), chest=s * T(10), head=s * T(15), arms=-s * T(12))),
            (25, dict(body=turn * 0.85, feet=feet(turn, turn * 0.5), drop=0.018, shift=(lead, 0.05), chest=s * T(5), head=s * T(5), lift=(trail, LIFT * 0.85), arms=-s * T(8))),
            (30, dict(body=turn, feet=feet(turn, turn), drop=0.015, shift=None, chest=0, head=0, arms=s * T(3))),
        ]
        end = 35
    out = []
    for f, k in keys:
        lh, rh = k['feet']
        out.append((f, pose(k['body'], lh, rh, k['drop'], k['shift'], k['chest'], k['head'], k.get('lift'), k.get('arms', 0.0))))
    fin = pose(turn, turn, turn)
    out += [(end, fin), (end + 1, fin)]
    return out


def plan_side(direction, steps=2, stride=0.30):
    """Side steps (direction +1 = to the left, -1 = to the right): the lead foot (on that side) lifts and steps out a
    stride, the weight goes over it, the trailing foot lifts and closes to the usual stance; repeated. The body faces
    forward throughout; arms hang relaxed."""
    lead_s, trail_s = ('Left', 'Right') if direction > 0 else ('Right', 'Left')
    lk, tk = lead_s[0], trail_s[0]
    def foot(side_name, x, lift=0.0):
        f = ix[side_name + 'Foot']; p = P0[0, f].copy(); p[0] += x; p[1] += lift
        return (p, G0[f][0].as_quat())
    keys, f0 = [(10, dict(body=0.0, feet=(0, 0), drop=0.01, shift=(tk, 0.03), chest=0, head=direction * np.radians(12), place=None, at=None))], 10
    for i in range(steps):
        x0, x1 = direction * stride * i, direction * stride * (i + 1)
        b = f0 + 20 * i
        keys += [
            (b + 5, dict(body=0.0, feet=(0, 0), drop=0.015, shift=None, chest=0, head=direction * np.radians(10),
                         place={lk: foot(lead_s, (x0 + x1) / 2, LIFT * 0.8), tk: foot(trail_s, x0)}, at=(x0 - direction * 0.03, 0.0))),
            (b + 10, dict(body=0.0, feet=(0, 0), drop=0.02, shift=None, chest=0, head=direction * np.radians(8),
                          place={lk: foot(lead_s, x1), tk: foot(trail_s, x0)}, at=((x0 + x1) / 2, 0.0))),
            (b + 15, dict(body=0.0, feet=(0, 0), drop=0.015, shift=None, chest=0, head=direction * np.radians(8),
                          place={lk: foot(lead_s, x1), tk: foot(trail_s, (x0 + x1) / 2, LIFT * 0.6)}, at=(x1 + direction * 0.03, 0.0))),
            (b + 20, dict(body=0.0, feet=(0, 0), drop=0.01, shift=None, chest=0, head=direction * np.radians(5),
                          place={lk: foot(lead_s, x1), tk: foot(trail_s, x1)}, at=(x1, 0.0))),
        ]
    end = f0 + 20 * steps + 6
    xe = direction * stride * steps
    out = []
    for f, k in keys:
        out.append((f, pose(k['body'], 0, 0, k['drop'], k['shift'], k['chest'], k['head'], None, 0.0, place=k['place'], at=k['at'])))
    fin = pose(0, 0, 0, at=(xe, 0.0), place={lk: foot(lead_s, xe), tk: foot(trail_s, xe)})
    return out + [(end, fin), (end + 1, fin)]



def plan_kneel(knee='Right', frames=120, rise=True):
    """Down on one knee: the kneeling leg's foot steps back onto its toes, the body lowers until that knee is on the
    floor (front shin leaning a little forward, the back foot on its toes), holds, and (rise) comes back up and steps the
    foot back in. Kimodo shuffled the feet 8-13 cm on the way down (2026-10-28)."""
    back, front = knee, ('Left' if knee == 'Right' else 'Right')
    bk, fk_ = back[0], front[0]
    def foot(side_name, dz, lift=0.0, toes=0.0, dx=0.0):
        """the standing foot moved dz back(-)/forward(+), lifted, and pitched heel-up by `toes` radians"""
        f = ix[side_name + 'Foot']; p = P0[0, f].copy(); p[2] += dz; p[0] += dx; p[1] += lift
        q = G0[f][0]
        if toes:
            q = R.from_rotvec([toes, 0, 0]) * q    # +x pitches the foot's toe down (heel up)
        return (p, q.as_quat())
    kneel_hip = (0.0, -0.27)       # body centre (x, z) while kneeling
    KD = 0.43                      # how far the hips come down
    back_toe_ankle = foot(back, -0.68, lift=0.12, toes=np.radians(55))
    keys = [
        (12, dict(place=None, at=None, drop=0.015, shift=(fk_, 0.04), head=0.0)),
        (18, dict(place={bk: foot(back, -0.30, lift=0.10)}, at=(0.0, -0.05), drop=0.04, shift=None, head=0.0)),
        (24, dict(place={bk: foot(back, -0.60, lift=0.06, toes=np.radians(40))}, at=(0.0, -0.18), drop=0.15, shift=None, head=0.0)),
        (34, dict(place={bk: back_toe_ankle}, at=kneel_hip, drop=KD, shift=None, head=0.0)),
    ]
    hold_end = frames - (36 if rise else 7)   # the plan ends 6+ frames before the clip does (room to settle)
    if rise:
        hold_end = min(hold_end, 34 + 30)       # about a second down there: a judge called the longer hold frozen
    if rise:
        keys += [
            (hold_end, dict(place={bk: back_toe_ankle}, at=kneel_hip, drop=KD, shift=None, head=0.0)),
            (hold_end + 10, dict(place={bk: foot(back, -0.60, lift=0.06, toes=np.radians(40))}, at=(0.0, -0.18), drop=0.15, shift=None, head=0.0)),
            (hold_end + 17, dict(place={bk: foot(back, -0.30, lift=0.10)}, at=(0.0, -0.05), drop=0.04, shift=None, head=0.0)),
            (hold_end + 23, dict(place=None, at=None, drop=0.01, shift=None, head=0.0)),
        ]
        end = hold_end + 23
    else:
        keys += [(hold_end, dict(place={bk: back_toe_ankle}, at=kneel_hip, drop=KD, shift=None, head=0.0))]
        end = hold_end
    out = [(f, pose(0, 0, 0, k['drop'], k['shift'], 0, k['head'], None, 0.0, place=k['place'], at=k['at'])) for f, k in keys]
    if rise:
        fin = pose(0, 0, 0)
        out += [(end + 3, fin), (end + 4, fin)]
    return out



def plan_walkstart(lead='Left', stride=0.36):
    """The first two steps of a walk from standing (Kimodo started gaits mid-stride; pinned standing, the first step
    dragged a foot): weight onto the trailing foot, the lead foot lifts and steps forward, the body follows, the other
    foot swings through to its first step. After that the model walks on its own."""
    trail = 'Right' if lead == 'Left' else 'Left'
    lk, tk = lead[0], trail[0]
    def foot(side_name, z, lift=0.0, toes=0.0):
        f = ix[side_name + 'Foot']; p = P0[0, f].copy(); p[2] += z; p[1] += lift
        q = G0[f][0]
        if toes: q = R.from_rotvec([toes, 0, 0]) * q
        return (p, q.as_quat())
    keys = [
        (8, dict(place=None, at=(0.0, 0.01), shift=(tk, 0.03))),
        (12, dict(place={lk: foot(lead, stride * 0.45, lift=0.09)}, at=(0.0, 0.06), shift=None)),
        (17, dict(place={lk: foot(lead, stride), tk: foot(trail, 0.0, lift=0.02, toes=np.radians(25))}, at=(0.0, stride * 0.5), shift=None)),
        (22, dict(place={lk: foot(lead, stride), tk: foot(trail, stride * 1.1, lift=0.09)}, at=(0.0, stride * 0.95), shift=None)),
        (27, dict(place={lk: foot(lead, stride, lift=0.02, toes=np.radians(25)), tk: foot(trail, stride * 2.2)}, at=(0.0, stride * 1.55), shift=None)),
    ]
    return [(f, pose(0, 0, 0, 0.015, k['shift'], 0, 0, None, 0.0, place=k['place'], at=k['at'])) for f, k in keys]



def plan_kick(leg='Right', height=0.95):
    """A front kick: weight onto the standing foot, the kicking knee comes up (chamber), the leg extends with the foot at
    `height` in front, the torso leaning back to balance, recoils to the chamber, and the foot comes down where it
    started. Kimodo's "kicks high" reached 69-73 cm (hip height is ~98) in 4 tries out of 4 (2026-10-28)."""
    stand = 'Left' if leg == 'Right' else 'Right'
    lk, sk_ = leg[0], stand[0]
    hipj = ix[leg + 'Leg']; f = ix[leg + 'Foot']
    hip0 = P0[0, hipj]
    def kick_foot(z, y, pitch):
        p = np.array([P0[0, f][0], y, hip0[2] + z])
        q = R.from_rotvec([pitch, 0, 0]) * G0[f][0]       # + pitches the toe down (pointed)
        return (p, q.as_quat())
    chamber = kick_foot(0.22, height * 0.55, np.radians(35))
    extend = kick_foot(0.72, height, np.radians(10))
    keys = [
        (10, dict(place=None, shift=(sk_, 0.05), chest=0.0)),
        (16, dict(place={lk: chamber}, shift=(sk_, 0.07), chest=0.0)),
        (21, dict(place={lk: extend}, shift=(sk_, 0.07), chest=0.0, lean=np.radians(12))),
        (26, dict(place={lk: chamber}, shift=(sk_, 0.06), chest=0.0, lean=np.radians(4))),
        (32, dict(place=None, shift=None, chest=0.0)),
    ]
    out = []
    for fr, k in keys:
        root, rots = pose(0, 0, 0, 0.01, k['shift'], 0, 0, None, 0.0, place=k['place'])
        if k.get('lean'):   # the upper body leans back to balance the leg (about the chest's own left axis)
            root_cur_save = root
            world_rot(rots, ix['Spine1'], R.from_rotvec(np.array([1.0, 0, 0]) * -k['lean']))
        out.append((fr, (root, rots)))
    fin = pose(0, 0, 0)
    return out + [(38, fin), (39, fin)]



def plan_stagger(first='Right', steps=2, back=0.28):
    """Hit and stagger back: the chest snaps back on the impact, the body falls back over its feet and catches itself
    with real steps backward (each foot lifted), then straightens up. Kimodo slid the feet back 19 cm (2/2)."""
    other = 'Left' if first == 'Right' else 'Right'
    fk1, fk2 = first[0], other[0]
    def foot(side_name, z, lift=0.0):
        f = ix[side_name + 'Foot']; pp = P0[0, f].copy(); pp[2] += z; pp[1] += lift
        return (pp, G0[f][0].as_quat())
    X = np.array([1.0, 0, 0])
    def bend(rots, chest, head):
        if chest: world_rot(rots, ix['Spine2'], R.from_rotvec(X * chest))
        if head: world_rot(rots, ix['Neck1'], R.from_rotvec(X * head))
        return rots
    zf1, zf2 = -back, -back * (2 if steps > 1 else 1)
    keys = [
        (10, None, None, 0.0, 0.0, (0.0, 0.0), 0.01),
        (13, None, None, -np.radians(18), -np.radians(14), (0.0, -0.05), 0.02),      # impact: chest and head thrown back
        (17, {fk1: foot(first, zf1 * 0.5, lift=0.08)}, None, -np.radians(14), -np.radians(8), (0.0, -0.12), 0.03),
        (21, {fk1: foot(first, zf1)}, None, -np.radians(10), -np.radians(4), (0.0, -0.18), 0.04),
    ]
    if steps > 1:
        keys += [
            (26, {fk1: foot(first, zf1), fk2: foot(other, (zf1 + zf2) / 2, lift=0.08)}, None, -np.radians(6), 0.0, (0.0, -0.32), 0.04),
            (31, {fk1: foot(first, zf1), fk2: foot(other, zf2 + back * 0.4)}, None, -np.radians(2), 0.0, (0.0, -0.40), 0.03),
        ]
    out = []
    for fr, place, _, chest, head, at, drop in keys:
        root, rots = pose(0, 0, 0, drop, None, 0, 0, None, 0.0, place=place, at=at)
        out.append((fr, (root, bend(rots, chest, head))))
    last = out[-1][0]
    zl1, zl2 = zf1, (zf2 + back * 0.4) if steps > 1 else 0.0
    cz = (P0[0, ix[first + 'Foot']][2] + zl1 + P0[0, ix[other + 'Foot']][2] + zl2) / 2 - (P0[0, ix['LeftFoot']][2] + P0[0, ix['RightFoot']][2]) / 2
    fin = pose(0, 0, 0, place={fk1: foot(first, zl1), fk2: foot(other, zl2)}, at=(0.0, cz))
    return out + [(last + 8, fin), (last + 9, fin)]


root_cur = ROOT
CHIN = np.radians(8)
LIFT = float(sys.argv[4]) if len(sys.argv) > 4 else 0.10
variant = sys.argv[2]
if sys.argv[1].startswith('stagger'):
    keys = plan_stagger()
elif sys.argv[1].startswith('kick'):
    _, leg_, h_ = sys.argv[1].split('_')
    keys = plan_kick(leg_.capitalize(), 1.18 if h_ == 'high' else 0.70)
elif sys.argv[1].startswith('walkstart'):
    keys = plan_walkstart('Left' if sys.argv[1].endswith('left') else 'Right')
elif sys.argv[1].startswith('kneel'):
    _, side_, fr_, rise_ = sys.argv[1].split('_')
    keys = plan_kneel(side_.capitalize(), int(fr_), rise_ == 'rise')
elif sys.argv[1].startswith('side'):
    keys = plan_side(1 if sys.argv[1] == 'side_left' else -1, int(sys.argv[5]) if len(sys.argv) > 5 else 2)
else:
    turn = np.radians(float(sys.argv[1])); keys = plan(turn)
stand = [(f, (ROOT, ROTS)) for f in range(4)]
cons = [{'type': 'fullbody', 'frame_indices': [f for f, _ in stand], 'root_positions': [r.tolist() for _, (r, q) in stand],
         'local_joints_rot_xyzw': [q.tolist() for _, (r, q) in stand]}]
if variant == 'full':
    cons.append({'type': 'fullbody', 'frame_indices': [f for f, _ in keys], 'root_positions': [r.tolist() for _, (r, q) in keys],
                 'local_joints_rot_xyzw': [q.tolist() for _, (r, q) in keys]})
else:  # feet and hips only: the arms are the model's
    cons.append({'type': 'end-effector', 'joint_names': ['LeftFoot', 'RightFoot', 'Hips'], 'frame_indices': [f for f, _ in keys],
                 'root_positions': [r.tolist() for _, (r, q) in keys], 'local_joints_rot_xyzw': [q.tolist() for _, (r, q) in keys]})
json.dump(cons, open(sys.argv[3], 'w'))
# a sheet of the key poses themselves, to check them before Kimodo sees them
Pk, _ = C.fk(sk, np.array([r for _, (r, q) in keys]), np.array([q for _, (r, q) in keys]))
for (f, _), p in zip(keys, Pk):
    l, r_ = p[ix['LeftFoot']], p[ix['RightFoot']]
    print(f'frame {f}: hips y {p[0,1]:.2f}  L foot ({l[0]:+.2f},{l[1]:.2f},{l[2]:+.2f})  R foot ({r_[0]:+.2f},{r_[1]:.2f},{r_[2]:+.2f})')
