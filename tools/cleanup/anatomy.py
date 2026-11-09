"""Joint limits for Understudy's clean-up (the Go server holds the same numbers in understudy/anatomy.go).

Limits come from the library's own clips (99.9th percentile of every joint's turn from rest across all generated
clips) and human ranges. Ball-like joints are limited on their total turn from rest; knees and elbows are hinges:
limited in bend, backward bend, twist about the bone and side bend (swing-twist about the bone axis).
Kimodo's bend axes, measured on every generated clip: knees +X, left elbow -Y, right elbow +Y.
"""
import numpy as np
from scipy.spatial.transform import Rotation as R

LIMITS = {'Spine1': 60, 'Spine2': 40, 'Chest': 55, 'Neck1': 90, 'Neck2': 70, 'Head': 85,
          'LeftShoulder': 65, 'RightShoulder': 65, 'LeftFoot': 110, 'RightFoot': 110, 'LeftToeBase': 70, 'RightToeBase': 70}
# hinge: (bend axis, child joint giving the bone axis, max bend, max backward bend, max twist, max side bend)
# These catch broken poses only: each is above what the library's good clips reach (99.9th percentile + margin).
HINGES = {'LeftShin': ((1, 0, 0), 'LeftFoot', 165, 30, 60, 45), 'RightShin': ((1, 0, 0), 'RightFoot', 165, 30, 60, 45),
          'LeftForeArm': ((0, -1, 0), 'LeftHand', 165, 30, 120, 75), 'RightForeArm': ((0, 1, 0), 'RightHand', 165, 30, 120, 75)}


def _rotvec_continuous(q):
    """Rotation vectors [T,3] whose axis does not flip between frames: past 180° a joint's turn is written as
    the same rotation with an angle above π, so a clamp pulls the same way on every frame (no pop)."""
    rv = R.from_quat(q).as_rotvec()
    for f in range(1, len(rv)):
        a = np.linalg.norm(rv[f])
        if a > 1e-6 and rv[f] @ rv[f - 1] < 0 and np.linalg.norm(rv[f - 1]) > np.pi / 2:
            rv[f] = rv[f] * (1 - 2 * np.pi / a)
    return rv


def _bone(sk, child):
    ix = {n: i for i, n in enumerate(sk['names'])}; b = np.array(sk['offsets'][ix[child]], float)
    return b / np.linalg.norm(b)


def _swing_twist(q, bone):
    """q [T,4] xyzw -> (swing rotvec [T,3], twist angle [T] radians, twist quat [T,4]) about the bone axis."""
    proj = (q[:, :3] @ bone)[:, None] * bone
    tw = np.concatenate([proj, q[:, 3:]], 1)
    n = np.linalg.norm(tw, axis=1, keepdims=True); tw = np.where(n > 1e-9, tw / np.maximum(n, 1e-9), np.array([0, 0, 0, 1.0]))
    twist = R.from_quat(tw); swing = R.from_quat(q) * twist.inv()
    tv = twist.as_rotvec(); ang = tv @ bone
    return swing.as_rotvec(), ang, tw


def _hinge_parts(sk, q, spec):
    axis, child, *_ = spec; h = np.array(axis, float); bone = _bone(sk, child)
    sv, twist, _ = _swing_twist(q, bone)
    bend = sv @ h; side = np.linalg.norm(sv - np.outer(bend, h), axis=1)
    return h, bone, sv, twist, bend, side


def anatomy_report(sk, rots):
    """{joint: (frames over, worst frame, worst degrees past the limit)} for every joint outside its range."""
    ix = {n: i for i, n in enumerate(sk['names'])}; bad = {}
    for n, lim in LIMITS.items():
        if n not in ix: continue
        a = np.degrees(np.linalg.norm(_rotvec_continuous(rots[:, ix[n]]), axis=1)); over = a - lim; k = np.where(over > 0.5)[0]
        if len(k): bad[n] = (int(len(k)), int(k[np.argmax(over[k])]), round(float(over.max())))
    for n, spec in HINGES.items():
        if n not in ix: continue
        _, _, _, twist, bend, side = _hinge_parts(sk, rots[:, ix[n]], spec)
        _, _, mb, mh, mt, ms = spec
        over = np.max(np.stack([np.degrees(bend) - mb, -np.degrees(bend) - mh, np.degrees(np.abs(twist)) - mt, np.degrees(side) - ms]), axis=0)
        k = np.where(over > 0.5)[0]
        if len(k): bad[n] = (int(len(k)), int(k[np.argmax(over[k])]), round(float(over.max())))
    return bad


def _clamped(sk, name, q):
    """One joint's turns [T,4] brought inside its range, frame by frame (no easing)."""
    if name in LIMITS:
        lim = np.radians(LIMITS[name]); rv = _rotvec_continuous(q); a = np.linalg.norm(rv, axis=1); over = a > lim
        if not over.any(): return q
        rv[over] *= (lim / a[over])[:, None]; return R.from_rotvec(rv).as_quat()
    spec = HINGES[name]; h, bone, sv, twist, bend, side = _hinge_parts(sk, q, spec)
    _, _, mb, mh, mt, ms = spec
    b2 = np.clip(bend, -np.radians(mh), np.radians(mb))
    sidev = sv - np.outer(bend, h); s2 = sidev * np.minimum(1, np.radians(ms) / np.maximum(side, 1e-9))[:, None]
    t2 = np.clip(twist, -np.radians(mt), np.radians(mt))
    return (R.from_rotvec(np.outer(b2, h) + s2) * R.from_rotvec(np.outer(t2, bone))).as_quat()


def _limited(sk):
    """Joints with a range, parents before children (a clamp is carried down, so a parent goes first)."""
    return [(j, n) for j, n in enumerate(sk['names']) if n in LIMITS or n in HINGES]


def clamp_exact(sk, rots):
    """Every joint inside its range, frame by frame (no easing). Everything beyond the joint turns with it (a joint
    really bent too far is unbent, the body past it following; spin merely written in the wrong joint is moved first,
    without moving anything, by retwist)."""
    out = rots.copy()
    for j, n in _limited(sk):
        if joint_over(sk, n, out[:, j]).max() <= 0: continue
        out[:, j] = _clamped(sk, n, out[:, j])
    return out


def enforce_anatomy(sk, rots, ease=4):
    """Pull every joint back inside its range. Spin in the wrong joint is moved first (retwist: no position changes);
    what is still out is clamped, the correction spread over ±ease frames (the larger correction wins where two
    overlap), so the fix has no pop. A final exact clamp catches what the easing leaves over. Joints already inside
    their range are not touched at all."""
    if not anatomy_report(sk, rots): return rots
    out = retwist(sk, rots, ease=ease); T = len(rots)
    w = np.hanning(2 * ease + 3)[1:-1]; w /= w.max()
    for j, n in _limited(sk):
        if joint_over(sk, n, out[:, j]).max() <= 0.5: continue
        d = (R.from_quat(_clamped(sk, n, out[:, j])) * R.from_quat(out[:, j]).inv()).as_rotvec()
        hit = np.where(np.linalg.norm(d, axis=1) > 1e-5)[0]
        spread = np.zeros((T, 3))
        for f in hit:
            for k, wk in enumerate(w):
                g = f + k - ease
                if 0 <= g < T and np.linalg.norm(d[f] * wk) > np.linalg.norm(spread[g]): spread[g] = d[f] * wk
        out[:, j] = (R.from_rotvec(spread) * R.from_quat(out[:, j])).as_quat()
    return clamp_exact(sk, out)


# --- spin bookkeeping ---------------------------------------------------------------------------------------------
# Kimodo sometimes writes a pose with its turns in the wrong joints: a waist twisted 166° one way and the chest 166° back
# (the pose is right, the mesh between is wrung like a towel), or an elbow bent sideways with the upper arm spun to make
# up for it (the arm is where it should be, but the elbow "bends" off its hinge). Clamping such a joint on its own moves
# the body (a push-up torso turned 40°, a backflip arm flung out sideways). The fix moves spin about a bone between that
# joint and its child: the parent turns about its own bone (which moves nothing below it) and the child turns back by
# the same amount, so every position and every other joint's orientation stays exactly as generated.

# (only joints whose one child is the pair's child: spinning the chest would move the shoulders, so it is not here)
RETWIST_PAIRS = [('Spine1', 'Spine2'), ('Spine2', 'Chest'), ('Neck1', 'Neck2'), ('Neck2', 'Head'),
                 ('LeftArm', 'LeftForeArm'), ('RightArm', 'RightForeArm'), ('LeftForeArm', 'LeftHand'), ('RightForeArm', 'RightHand'),
                 ('LeftLeg', 'LeftShin'), ('RightLeg', 'RightShin'), ('LeftShin', 'LeftFoot'), ('RightShin', 'RightFoot')]


def joint_over(sk, name, q):
    """Degrees past the joint's range per frame (0 inside it, or for joints without a limit). q [T,4]."""
    if name in LIMITS:
        return np.maximum(0, np.degrees(np.linalg.norm(R.from_quat(q).as_rotvec(), axis=1)) - LIMITS[name])
    if name in HINGES:
        _, _, _, twist, bend, side = _hinge_parts(sk, q, HINGES[name]); _, _, mb, mh, mt, ms = HINGES[name]
        return np.maximum(0, np.max(np.stack([np.degrees(bend) - mb, -np.degrees(bend) - mh,
                                              np.degrees(np.abs(twist)) - mt, np.degrees(side) - ms]), axis=0))
    return np.zeros(len(q))


def _spin_pair(sk, rots, p, c, k):
    """Parent p turned by -k about its bone (towards c), child c by +k before its own turn: positions unchanged."""
    a = _bone(sk, sk["names"][c]); tw = R.from_rotvec(np.outer(k, a))
    qp = (R.from_quat(rots[:, p]) * tw.inv()).as_quat(); qc = (tw * R.from_quat(rots[:, c])).as_quat()
    return qp, qc


def retwist(sk, rots, ease=4, step=5.0):
    """Frames where a pair's joints are out of range only because spin sits in the wrong one: the spin that brings
    both back (least total excess, least spin moved) is moved, eased over ±ease frames. Changes no position."""
    ix = {n: i for i, n in enumerate(sk['names'])}; out = rots.copy(); T = len(rots)
    w = np.hanning(2 * ease + 3)[1:-1]; w /= w.max()
    grid = np.radians(np.arange(-180, 180 + step / 2, step))
    for _ in range(3):
        for pn, cn in reversed(RETWIST_PAIRS):   # from the ends in: a wrung waist cancels into the chest, not the hips
            if pn not in ix or cn not in ix: continue
            p, c = ix[pn], ix[cn]
            base = joint_over(sk, pn, out[:, p]) + joint_over(sk, cn, out[:, c])
            bad = np.where(base > 0.5)[0]
            if not len(bad): continue
            # every candidate spin on every bad frame at once
            F, K = len(bad), len(grid)
            kk = np.tile(grid, F); ff = np.repeat(bad, K)
            sub = out[ff][:, [p, c]]
            a = _bone(sk, cn); tw = R.from_rotvec(np.outer(kk, a))
            qp = (R.from_quat(sub[:, 0]) * tw.inv()).as_quat(); qc = (tw * R.from_quat(sub[:, 1])).as_quat()
            cost = (joint_over(sk, pn, qp) + joint_over(sk, cn, qc)).reshape(F, K) + 0.02 * np.degrees(np.abs(grid))[None]
            best = grid[np.argmin(cost, axis=1)]
            gain = base[bad] - cost.min(axis=1)
            k = np.zeros(T)
            for f, b, g in zip(bad, best, gain):
                if g < 1.0: continue
                for i, wi in enumerate(w):
                    t = f + i - ease
                    if 0 <= t < T and abs(b * wi) > abs(k[t]): k[t] = b * wi
            if not np.any(k): continue
            # the best spin is picked per frame on a 5° grid: smoothed over time so it does not flicker (any spin
            # keeps every position; what the smoothing leaves out of range is clamped later)
            from scipy.ndimage import gaussian_filter1d
            k = gaussian_filter1d(np.unwrap(k), 2.0, mode='nearest')   # spin is periodic: unwrapped first
            out[:, p], out[:, c] = _spin_pair(sk, out, p, c, k)
    return out


def canonical_limbs(sk, rots, full=np.radians(30), none=np.radians(10)):
    """Every frame's arms and legs written one way: elbows and knees turn only on their hinge (bend, either sign); the
    rest of their turn goes to the upper arm / thigh (a spin about its own bone) and to the hand / foot (the forearm's
    or shin's spin). Positions and the hand's and foot's orientation stay exactly as they were.
    Kimodo splits these turns differently from frame to frame (an elbow bent sideways with the upper arm spun to make
    up for it, then not), so the joint tracks jump while the visible arm moves smoothly; smoothing such a track
    builds poses that never were (a backflip arm flung out). Near a straight elbow the hinge plane is undefined, so
    the swing's side part is moved fully only above `full` of bend and not at all below `none`."""
    ix = {n: i for i, n in enumerate(sk['names'])}; out = rots.copy()
    for side in ('Left', 'Right'):
        for upper, mid, low in (('Arm', 'ForeArm', 'Hand'), ('Leg', 'Shin', 'Foot')):
            p, c, g = ix[side + upper], ix[side + mid], ix[side + low]
            h, bone, sv, twist, bend, sidev = _hinge_parts(sk, out[:, c], HINGES[side + mid])
            mag = np.linalg.norm(sv, axis=1)
            # the swing axis (perpendicular to the bone) as an angle about the bone, measured from the hinge axis
            e2 = np.cross(bone, h)
            ang = np.arctan2(sv @ e2, sv @ h)
            k = -((ang + np.pi / 2) % np.pi - np.pi / 2)           # to the hinge line, nearer sign (no 180° flips)
            k *= np.clip((mag - none) / (full - none), 0, 1)
            out[:, p], out[:, c] = _spin_pair(sk, out, p, c, k)
            # the mid joint's own spin goes on to the hand / foot
            _, _, _, twist, _, _ = _hinge_parts(sk, out[:, c], HINGES[side + mid])
            out[:, c], out[:, g] = _spin_pair(sk, out, c, g, twist)
    return out
