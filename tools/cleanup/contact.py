"""Contact pass for Understudy's clean-up: the body touches the floor where it should and nowhere goes through it.

Kimodo's clips often almost touch: a roll done 10 cm over the floor, a "sit" with the hips hovering, a standing
foot held 6 cm up while the other stands on its toes through the floor. Physics (MuJoCo, welded to the clip) does
not change any of that. This pass works on the body's real surface (body_proxy.json: the stage mannequin's
vertices per bone, in the bone's frame, convex hull), the same surface the server's checks use:

  1. floats   - a stretch with nothing touching that stays near the floor and is not a gravity arc settles down
                until its lowest part touches (the root moves; limbs keep their motion)
  2. settle   - nearly still, held by the feet alone, centre of mass outside them, with the hips/knees/hands near
                the floor: the body lowers onto that part (feet held where they were by leg IK)
  3. feet     - a foot that stays still near the floor is planted: its sole touches, toes pushed through the floor
                are rolled back over the ball of the foot (leg IK, foot turn kept otherwise)
  4. limbs    - a hand or knee through the floor is lifted out by arm/leg IK

Every correction is eased over a few frames. Floor = where planted toes stand (robust to a few sinking frames).
"""
import json, os
import numpy as np
from scipy.spatial.transform import Rotation as R

TOUCH = 0.025          # a surface this close to the floor touches it
FLOAT_BELOW = 0.15     # a no-contact stretch never higher than this over the floor is a float, not a jump
STILL = 0.012          # m per frame: a still foot
PLANT_HIGH = 0.12      # a still foot lower than this is meant to be on the floor
PLANT_RUN = 6
EASE = 4
SEAT = {'Hips', 'LeftLeg', 'RightLeg', 'LeftShin', 'RightShin'}   # sit / kneel only: lowering a push-up plank onto its chest wrecked it
ROLL_MAX = 0.0       # rolling a foot back over the ball curled feet back (ankle -17° -> -48° on a walk): toes out of the floor by lifting only
TRUNK = {'Hips', 'Spine1', 'Spine2', 'Chest', 'Neck1', 'Neck2', 'Head', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm'}

_proxy = None
def proxy():
    global _proxy
    if _proxy is None:
        p = json.load(open(os.path.join(os.path.dirname(__file__), 'body_proxy.json')))
        _proxy = {k: np.array(v, float) for k, v in p.items()}
    return _proxy

def fk(sk, roots, rots):
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

def surface_low(sk, P, G):
    """{bone: [T] lowest surface y}."""
    ix = {n: i for i, n in enumerate(sk['names'])}; out = {}
    for name, pts in proxy().items():
        if name not in ix: continue
        j = ix[name]; M = G[j].as_matrix()                      # [T,3,3]
        y = P[:, j, 1][:, None] + np.einsum('tk,nk->tn', M[:, 1, :], pts)
        out[name] = y.min(axis=1)
    return out

SOMA_FLOOR = 0.02      # Kimodo's world floor for SOMA (the server's nominalFloor): lowest surfaces rest at 1.8-2 cm

def support_at(props, floor, xz, margin=0.0):
    """[T] height of the surface under each (x, z): a box top where the point is inside the box's footprint (grown
    by margin), else the floor. The same rule as the server's height field."""
    xz = np.asarray(xz, float).reshape(-1, 2); h = np.full(len(xz), float(floor))
    for p in props or ():
        if p.get('kind', 'box') != 'box': continue
        c, s_ = np.cos(p.get('yaw', 0.0)), np.sin(p.get('yaw', 0.0)); dx, dz = xz[:, 0] - p['pos'][0], xz[:, 1] - p['pos'][2]
        lx, lz = dx * c + dz * s_, -dx * s_ + dz * c
        inside = (np.abs(lx) <= p['size'][0] / 2 + margin) & (np.abs(lz) <= p['size'][2] / 2 + margin)
        h = np.where(inside, np.maximum(h, p['pos'][1] + p['size'][1]), h)
    return h

def floor_of(sk, P):
    """The floor: Kimodo's own for SOMA clips; otherwise where planted toes stand (toe joints still and low)."""
    ix = {n: i for i, n in enumerate(sk['names'])}
    if len(sk['names']) == 30 and 'LeftToeBase' in ix:
        return SOMA_FLOOR
    hs = []
    for side in ('Left', 'Right'):
        t = P[:, ix[side + 'ToeBase']]
        sp = np.r_[np.inf, np.linalg.norm(np.diff(t[:, [0, 2]], axis=0), axis=1)]   # as the server's clipFloor
        low = np.percentile(t[:, 1], 5)
        hs += list(t[(sp < STILL) & (t[:, 1] < low + 0.04), 1])
    if not hs:
        return float(np.percentile(np.r_[P[:, ix['LeftToeBase'], 1], P[:, ix['RightToeBase'], 1]], 5))
    return float(np.median(hs))

def com_of(sk, P):
    w = []
    for n in sk['names']:
        w.append(0 if n.endswith('End') or 'Eye' in n or n == 'Jaw' else 3 if n in ('Hips', 'Spine1', 'Spine2', 'Chest') else 1.5 if n == 'Head' else 1)
    w = np.array(w, float)
    return (P * w[None, :, None]).sum(1) / w.sum()

def runs(mask):
    out, f, T = [], 0, len(mask)
    while f < T:
        if not mask[f]: f += 1; continue
        a = f
        while f < T and mask[f]: f += 1
        out.append((a, f - 1))
    return out

def eased(values, mask, ease=EASE):
    """values on masked frames, faded to 0 over `ease` frames outside them; the larger magnitude wins on overlap."""
    T = len(values); out = np.zeros_like(values)
    w = np.hanning(2 * ease + 3)[1:-1]; w /= w.max()
    for f in np.where(mask)[0]:
        out[f] = values[f] if abs(values[f]) > abs(out[f]) else out[f]
    base = out.copy()
    for f in np.where(mask)[0]:
        for k in range(1, ease + 1):
            for g in (f - k, f + k):
                if 0 <= g < T and not mask[g]:
                    v = base[f] * w[ease + k] if ease + k < len(w) else 0
                    if abs(v) > abs(out[g]): out[g] = v
    return out

def smooth_drop(drop, gap, ease=8, sigma=2.0):
    """A root drop eased in and out over `ease` frames and low-passed (no jolt in the hips), never deeper than the
    gap under the body on any frame (so it never pushes anything through the floor)."""
    d = eased(drop, drop > 0, ease)
    k = np.exp(-np.arange(-6, 7) ** 2 / (2 * sigma * sigma)); k /= k.sum()
    d = np.convolve(np.pad(d, 6, mode='edge'), k, mode='same')[6:-6]
    return np.clip(d, 0, np.maximum(gap - 0.003, 0))

def smooth_rise(req, half=2, sigma=1.5):
    """A root lift at least `req` on every frame, widened (max over ±half frames) and low-passed: no jolt."""
    from scipy.ndimage import maximum_filter1d, gaussian_filter1d
    r = gaussian_filter1d(maximum_filter1d(req, size=2 * half + 1), sigma, mode='nearest')
    return np.maximum(r, req)

# --- two-bone IK ---------------------------------------------------------------------------------------------
def two_bone(sk, roots, rots, chain, target, frames, end_global=None):
    """Move the end of chain (a, b, c) to target[f] on `frames`; c keeps its world turn (or end_global[f]).
    All frames at once (numpy), same maths as one at a time."""
    ix = {n: i for i, n in enumerate(sk['names'])}; parents = sk['parents']
    a, b, c = (ix[n] for n in chain)
    out = rots.copy()
    fr = np.asarray(list(frames), int)
    if fr.size == 0: return out
    P, G = fk(sk, roots, rots)
    pa, pb, pc, t = P[fr, a], P[fr, b], P[fr, c], np.asarray(target)[fr]
    u, v = pb - pa, pc - pb
    l1, l2 = np.linalg.norm(u, axis=1), np.linalg.norm(v, axis=1)
    d = np.linalg.norm(t - pa, axis=1)
    # soft limit near full extension: a nearly straight limb would snap its knee/elbow for a tiny target change
    # The softening starts past the reach the pose ALREADY has: a standing leg at 0.997 of its length was pulled back to
    # ~0.985 for a target it already touched, bending the knee 174 -> 163 degrees and lifting the foot 9 mm in every
    # settled end pose (the judges' "bent-knee, soft-kneed slump", 2026-10-30)
    L = l1 + l2; s0 = np.maximum(0.97 * L, np.minimum(np.linalg.norm(pc - pa, axis=1), 0.999 * L))
    over = d > s0
    d = np.where(over, s0 + (L - s0) * (1 - np.exp(-(d - s0) / np.maximum(L - s0, 1e-9))), d)
    d = np.clip(d, np.abs(l1 - l2) + 1e-4, L - 1e-4)
    # bend at b so |c - a| = d, about the current bend axis
    n = np.cross(u, v); nn = np.linalg.norm(n, axis=1)
    fallback = G[b][fr].apply([1.0, 0, 0])
    n = np.where((nn < 1e-6)[:, None], fallback, n / np.maximum(nn, 1e-12)[:, None])
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    cur_int = np.arccos(np.clip(np.einsum('ij,ij->i', -u, v) / (l1 * l2), -1, 1))
    want_int = np.arccos(np.clip((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1))
    Rb = R.from_rotvec(n * (cur_int - want_int)[:, None])
    pc2 = pb + Rb.apply(v)
    # swing the chain about a so c lands on t
    x, y = pc2 - pa, t - pa
    axis = np.cross(x, y); sa = np.linalg.norm(axis, axis=1)
    ang = np.arctan2(sa, np.einsum('ij,ij->i', x, y))
    Rs = R.from_rotvec(np.where((sa > 1e-9)[:, None], axis / np.maximum(sa, 1e-12)[:, None] * ang[:, None], 0.0))
    Ga, Gb = Rs * G[a][fr], Rs * Rb * G[b][fr]
    Gc = R.from_quat(np.asarray(end_global)[fr]) if end_global is not None else G[c][fr]
    par = parents[a]
    Gpar = G[par][fr] if par >= 0 else R.identity(len(fr))
    out[fr, a] = (Gpar.inv() * Ga).as_quat()
    out[fr, b] = (Ga.inv() * Gb).as_quat()
    out[fr, c] = (Gb.inv() * Gc).as_quat()
    return out

LEG = {'Left': ('LeftLeg', 'LeftShin', 'LeftFoot'), 'Right': ('RightLeg', 'RightShin', 'RightFoot')}
ARM = {'Left': ('LeftArm', 'LeftForeArm', 'LeftHand'), 'Right': ('RightArm', 'RightForeArm', 'RightHand')}

# --- passes --------------------------------------------------------------------------------------------------
def settle_floats(sk, roots, rots, floor, g=9.81, fps=30.0):
    P, G = fk(sk, roots, rots); low = surface_low(sk, P, G)
    gap = np.min(np.stack(list(low.values())), axis=0) - floor
    com = com_of(sk, P)[:, 1]; T = len(roots)
    drop = np.zeros(T); fixed = []
    lowest = [min(low, key=lambda k: low[k][f]) for f in range(T)]
    ix = {n: i for i, n in enumerate(sk['names'])}
    trunk_up = P[:, ix['Chest']] - P[:, ix['Hips']]
    inverted = trunk_up[:, 1] / np.maximum(np.linalg.norm(trunk_up, axis=1), 1e-9) < 0
    for a, b in runs(gap > TOUCH):
        n = b - a + 1
        if n < 3: continue
        # a real jump or flip: the centre of mass rides a gravity arc (fixed g, best take-off height and speed) — even
        # upside down (a flip's airtime has the back lowest; settling it turned a real flip into a roll)
        if n >= 5:
            t = np.arange(n) / fps; y = com[a:b + 1] + 0.5 * g * t * t
            A = np.c_[np.ones_like(t), t]; coef = np.linalg.lstsq(A, y, rcond=None)[0]
            if np.sqrt(np.mean((A @ coef - y) ** 2)) < 0.03 and gap[a:b + 1].max() > 0.05: continue
        # upside down in the air is a flip or a dive, never a float: settling it put the head down (a flip became a roll)
        if inverted[a:b + 1].mean() > 0.3: continue
        # lying, sitting or rolling (the trunk is the lowest part), not on a gravity arc: it floats, up to 30 cm
        if sum(lowest[f] in TRUNK for f in range(a, b + 1)) * 2 > n and gap[a:b + 1].max() < 0.30:
            drop[a:b + 1] = np.maximum(drop[a:b + 1], gap[a:b + 1] - 0.003); fixed.append((int(a), int(b))); continue
        # floating: the lowest point hangs near the floor (not rushing up or down) for a few frames
        rate = np.abs(np.gradient(gap[a:b + 1])) if n > 1 else np.zeros(n)
        hang = (gap[a:b + 1] < FLOAT_BELOW) & (rate < 0.02)
        for c, e in runs(hang):
            if e - c + 1 < 3: continue
            # settle the whole near-floor stretch around the hang, so the body comes down into it smoothly
            lo, hi = a + c, a + e
            while lo > a and gap[lo - 1] < FLOAT_BELOW: lo -= 1
            while hi < b and gap[hi + 1] < FLOAT_BELOW: hi += 1
            drop[lo:hi + 1] = np.maximum(drop[lo:hi + 1], gap[lo:hi + 1] - 0.003); fixed.append((int(lo), int(hi)))
    if not fixed: return roots, []
    d = smooth_drop(drop, gap)
    out = roots.copy(); out[:, 1] -= d
    return out, fixed

def settle_support(sk, roots, rots, floor, fps=30.0):
    """Nearly still, held by the feet only, centre of mass outside them. With the hips/knees/hands near the floor
    the body lowers onto that part (sitting on nothing becomes sitting); otherwise the hips shift over the feet (at
    most 15 cm). Feet stay where they were (leg IK)."""
    ix = {n: i for i, n in enumerate(sk['names'])}
    P, G = fk(sk, roots, rots); low = surface_low(sk, P, G); T = len(roots)
    names = list(low); L = np.stack([low[n] for n in names]) - floor          # [B,T]
    feet = np.array(['Foot' in n or 'Toe' in n for n in names])
    com = com_of(sk, P)
    speed = np.r_[0, np.linalg.norm(np.diff(roots[:, [0, 2]], axis=0), axis=1)] * fps
    drop, shift = np.zeros(T), np.zeros((T, 2))
    for f in range(T):
        if speed[f] > 0.6: continue
        touch = L[:, f] < TOUCH
        if not touch.any(): continue
        # support: every surface point on the floor (feet, shins, knees, hips, hands) — the server's balance check
        pts = []
        for n in np.array(names)[touch]:
            j = ix[n]; pw = P[f, j] + G[j][f].apply(proxy()[n])
            pts += list(pw[pw[:, 1] - floor < TOUCH][:, [0, 2]])
        if len(pts) < 3: continue
        pts = np.array(pts); out_d = _outside(pts, com[f, [0, 2]])
        if out_d <= 0.12: continue      # the server flags 15 cm; a kick leans ~13 cm for a moment
        free = L[:, f].copy(); free[touch] = np.inf      # the nearest part not yet on the floor
        # only what one sits, kneels or lies on (hips, thighs, knees, back): lowering a cartwheel onto a hand while
        # holding its feet curled the ankles and snapped a knee
        seat = np.array([n in SEAT for n in names])
        body_near = free[seat].min() if (seat & ~touch).any() else np.inf
        if body_near <= 0.10:
            drop[f] = body_near - 0.003       # sit / kneel on it (at most 10 cm: a bigger drop is a different pose)
        # (shifting the hips over the feet was dropped: holding the feet while the hips moved curled the ankles back,
        # and it overruled moves the judges found fine — an off-balance pose now stays flagged instead)
    m_drop, m_shift = drop > 0, np.linalg.norm(shift, axis=1) > 0
    spans = [(int(a), int(b), 'sit') for a, b in runs(m_drop) if b - a >= 7]   # as the balance check: 8+ frames + [(int(a), int(b), 'lean') for a, b in runs(m_shift) if b - a >= 3]
    if not spans: return roots, rots, []
    keep = np.zeros(T, bool)
    for a, b, _ in spans: keep[a:b + 1] = True
    d = smooth_drop(np.where(keep, drop, 0), np.full(T, 9.0)) if (keep & m_drop).any() else np.zeros(T)
    sx = eased(np.where(keep, shift[:, 0], 0), keep & m_shift, 8); sz = eased(np.where(keep, shift[:, 1], 0), keep & m_shift, 8)
    out_roots = roots.copy(); out_roots[:, 1] -= d; out_roots[:, 0] += sx; out_roots[:, 2] += sz
    out = rots.copy(); frames = np.where((d > 1e-4) | (np.abs(sx) + np.abs(sz) > 1e-4))[0]
    for side, chain in LEG.items():          # the feet stay where they were
        foot = ix[chain[2]]
        touching = np.minimum(low[side + 'Foot'], low[side + 'ToeBase']) - floor < TOUCH + 0.02
        fr = [f for f in frames if touching[f]]
        if fr:
            out = two_bone(sk, out_roots, out, chain, P[:, foot], fr, end_global=G[foot].as_quat())
    return out_roots, out, spans

def _outside(pts, p):
    from scipy.spatial import ConvexHull, QhullError
    try:
        h = ConvexHull(pts); poly = pts[h.vertices]
    except Exception:
        poly = pts
    inside = True; best = np.inf
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        if (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0: inside = False
        ab = b - a; t = np.clip(np.dot(p - a, ab) / max(np.dot(ab, ab), 1e-12), 0, 1)
        best = min(best, np.linalg.norm(p - a - t * ab))
    return 0.0 if inside and len(poly) >= 3 else best

def straight_fade(P, hip, knee, foot, tgt, lo=0.88, hi=0.95, sigma=1.5):
    """How much of a foot move a leg can take (0..1 per frame): all of it while the reach stays under `lo` of the leg's
    length, none past `hi` (IK on a nearly straight leg snaps the knee), faded in between and smoothed over time. A hard
    cut (move this frame, not the next) shook the foot at every edge."""
    from scipy.ndimage import gaussian_filter1d
    L = np.linalg.norm(P[:, knee] - P[:, hip], axis=1) + np.linalg.norm(P[:, foot] - P[:, knee], axis=1)
    ratio = np.linalg.norm(tgt - P[:, hip], axis=1) / np.maximum(L, 1e-9)
    from scipy.ndimage import minimum_filter1d
    k = np.clip((hi - ratio) / (hi - lo), 0, 1)
    # the straight frames widened before smoothing, and smoothing may only lower a frame's share, never raise it
    # (a little IK leaking onto a straight leg threw the knee 3 cm)
    return np.minimum(k, gaussian_filter1d(minimum_filter1d(k, 5, mode='nearest'), sigma, mode='nearest'))

def plant_feet(sk, roots, rots, floor, sink_only=False):
    """Still feet near the floor are put on it: sole touching, toes through the floor rolled back over the ball."""
    ix = {n: i for i, n in enumerate(sk['names'])}; T = len(roots); planted = []
    out = rots.copy()
    for side, chain in LEG.items():
        P, G = fk(sk, roots, out); low = surface_low(sk, P, G)
        foot, toe = ix[side + 'Foot'], ix[side + 'ToeBase']
        sole = np.minimum(low[side + 'Foot'], low[side + 'ToeBase']) - floor
        toe_low = low[side + 'ToeBase'] - floor
        ball = P[:, toe]
        sp = np.r_[0, np.linalg.norm(np.diff(P[:, foot][:, [0, 2]], axis=0), axis=1)]
        # only feet that are wrong: a still foot hovering over the touch band (feet already on the floor, as in
        # every walking stance, are left alone: re-planting them made IK snap the knee at heel-off)
        still = (sp < STILL) & (sole > TOUCH) & (sole < PLANT_HIGH)
        spans = [(a, b) for a, b in runs(still) if b - a + 1 >= PLANT_RUN]
        plant = np.zeros(T, bool)
        if not sink_only:
            for a, b in spans: plant[a:b + 1] = True
        sink = sole < -0.005                       # through the floor on any frame, planted or not
        mask = plant | sink
        if not mask.any(): continue
        # 1) toes through the floor: roll the foot back over the ball until the toe surface is on the floor
        roll = np.zeros(T)
        for f in np.where(mask & (toe_low < -0.005))[0]:
            roll[f] = _roll_to_floor(sk, P, G, side, f, floor)
        # one smooth roll over time (a per-frame solve can flip sides between frames: the foot shook)
        from scipy.ndimage import gaussian_filter1d
        roll = gaussian_filter1d(eased(roll, mask & (roll != 0)), 2.0, mode='nearest')
        target_ankle = P[:, foot].copy(); Gc = G[foot].as_quat().copy()
        for f in np.where(np.abs(roll) > 1e-5)[0]:
            lat = G[foot][f].apply([1.0, 0, 0]); lat[1] = 0; lat /= max(np.linalg.norm(lat), 1e-9)
            Rr = R.from_rotvec(lat * roll[f])
            target_ankle[f] = ball[f] + Rr.apply(P[f, foot] - ball[f])
            Gc[f] = (Rr * G[foot][f]).as_quat()
        # 2) the sole onto the floor (after the roll): lower or lift the ankle by the remaining gap
        tmp = out.copy()
        fr = list(np.where(np.abs(roll) > 1e-5)[0])
        if fr: tmp = two_bone(sk, roots, out, chain, target_ankle, fr, end_global=Gc)
        P2, G2 = fk(sk, roots, tmp); low2 = surface_low(sk, P2, G2)
        sole2 = np.minimum(low2[side + 'Foot'], low2[side + 'ToeBase']) - floor
        lift = eased(np.where(plant, 0.003 - sole2, np.where(sink, np.maximum(-sole2, 0), 0)), mask & ((plant) | (sole2 < 0)))
        if sink_only:   # a toes-out-of-the-floor lift on its own: widened and smoothed like the body's (a sharp ramp snapped the knee)
            lift = smooth_rise(np.maximum(lift, 0))
        tgt = P2[:, foot].copy(); tgt[:, 1] += lift
        # a leg nearly straight (a push-off) takes little or none of the lift: lifting its foot 2 cm forces a sudden
        # knee bend (a pop), far worse to see than toes a little in the floor
        hip, knee = ix[chain[0]], ix[chain[1]]
        k = straight_fade(P2, hip, knee, foot, tgt)
        tgt = P2[:, foot] + k[:, None] * (tgt - P2[:, foot])
        fr = list(np.where((np.abs(k * lift) > 1e-4) | (np.abs(roll) > 1e-5))[0])
        if fr:
            out = two_bone(sk, roots, tmp, chain, tgt, fr, end_global=G2[foot].as_quat())
        planted.append((side, [(int(a), int(b)) for a, b in spans], int(sink.sum())))
    return out, planted

def _roll_to_floor(sk, P, G, side, f, floor):
    """Angle (about the foot's side axis, through the ball) that brings the toe surface up to the floor."""
    ix = {n: i for i, n in enumerate(sk['names'])}
    foot, toe = ix[side + 'Foot'], ix[side + 'ToeBase']
    ball = P[f, toe]; lat = G[foot][f].apply([1.0, 0, 0]); lat[1] = 0; lat /= max(np.linalg.norm(lat), 1e-9)
    pts_t = P[f, toe] + G[toe][f].apply(proxy()[side + 'ToeBase'])
    pts_f = P[f, foot] + G[foot][f].apply(proxy()[side + 'Foot'])
    def low_after(a):
        Rr = R.from_rotvec(lat * a)
        return min((ball + Rr.apply(pts_t - ball))[:, 1].min(), (ball + Rr.apply(pts_f - ball))[:, 1].min()) - floor
    # the way that lifts the toes (from the slope at no roll), bisected to the floor, at most ROLL_MAX
    eps = 0.02
    sign = 1.0 if low_after(eps) >= low_after(-eps) else -1.0
    if low_after(sign * ROLL_MAX) < 0:
        return sign * ROLL_MAX
    lo, hi = 0.0, sign * ROLL_MAX
    for _ in range(20):
        mid = (lo + hi) / 2
        if low_after(mid) < 0: lo = mid
        else: hi = mid
    return hi

def lift_limbs(sk, roots, rots, floor, widen=2):
    """Hands (arm IK) and knees/shins (leg IK) through the floor are lifted out."""
    ix = {n: i for i, n in enumerate(sk['names'])}; T = len(roots); out = rots.copy(); fixed = []
    for side in ('Left', 'Right'):
        for part, chain in ((side + 'Hand', ARM[side]), ):
            P, G = fk(sk, roots, out); low = surface_low(sk, P, G)
            sink = floor - low[part]
            mask = sink > 0.005
            if not mask.any(): continue
            lift = eased(np.where(mask, sink + 0.002, 0), mask)
            end = ix[chain[2]]; tgt = P[:, end].copy(); tgt[:, 1] += lift
            fr = list(np.where(lift > 1e-4)[0])
            out = two_bone(sk, roots, out, chain, tgt, fr, end_global=G[end].as_quat())
            fixed.append((part, int(mask.sum())))
    # anything else through the floor (knees, hips, back, head): the whole body rises by the deepest sink there
    P, G = fk(sk, roots, out); low = surface_low(sk, P, G)
    other = np.min(np.stack([v for k, v in low.items() if 'Foot' not in k and 'Toe' not in k and 'Hand' not in k]), axis=0) - floor
    mask = other < -0.005
    out_roots = roots
    if mask.any():
        rise = smooth_rise(np.where(mask, -other + 0.002, 0), half=widen) if widen else eased(np.where(mask, -other + 0.002, 0), mask, 3)
        out_roots = roots.copy(); out_roots[:, 1] += rise; fixed.append(('body', int(mask.sum())))
    return out_roots, out, fixed

def contact_pass(sk, roots, rots):
    P, _ = fk(sk, roots, rots)
    floor = floor_of(sk, P)
    info = {'floor': round(floor, 4)}
    # twice: a flattened foot on a straight leg can end short of the floor; the second round lowers the body to it
    for k in range(2):
        roots, info[f'floats{k}'] = settle_floats(sk, roots, rots, floor)
        rots, info[f'planted{k}'] = plant_feet(sk, roots, rots, floor)        # feet down first: balance needs them
        roots, rots, info[f'settled{k}'] = settle_support(sk, roots, rots, floor)
        roots, rots, info[f'lifted{k}'] = lift_limbs(sk, roots, rots, floor)
    return roots, rots, info

def lift_out(sk, roots, rots, floor):
    """Last word: nothing ends under the floor (after any smoothing that ran since the contact pass), and a lift
    here only lifts the frames that need it (no widening: these lifts are small, and widening left neighbours
    floating)."""
    rots, _ = plant_feet(sk, roots, rots, floor, sink_only=True)
    rots, tucked = tuck_head(sk, roots, rots, floor)
    roots, rots, fixed = lift_limbs(sk, roots, rots, floor, widen=2)
    return roots, rots, fixed + ([('head tucked', tucked)] if tucked else [])

def tuck_head(sk, roots, rots, floor, cap=0.9):
    """A head through the floor tucks (the neck turns it up out of the floor) rather than lifting the whole body."""
    from scipy.ndimage import gaussian_filter1d
    ix = {n: i for i, n in enumerate(sk['names'])}; T = len(roots)
    P, G = fk(sk, roots, rots); low = surface_low(sk, P, G)
    sink = floor - low['Head']; frames = np.where(sink > 0.005)[0]
    if not len(frames): return rots, 0
    n1, hd = ix['Neck1'], ix['Head']; pts = proxy()['Head']
    ang = np.zeros(T)
    for f in frames:
        axis = G[ix['Chest']][f].apply([1.0, 0, 0])
        def head_low(a):
            Rr = R.from_rotvec(axis * a)            # turn the neck (and the head with it) about the chest's side axis
            return (P[f, n1] + Rr.apply(P[f, hd] - P[f, n1] + G[hd][f].apply(pts)))[:, 1].min() - floor
        sign = 1.0 if head_low(0.02) >= head_low(-0.02) else -1.0
        lo, hi = 0.0, sign * cap
        if head_low(hi) < 0: ang[f] = hi; continue
        for _ in range(18):
            mid = (lo + hi) / 2
            if head_low(mid) < 0: lo = mid
            else: hi = mid
        ang[f] = hi
    ang = gaussian_filter1d(eased(ang, ang != 0, 3), 1.5, mode='nearest')
    out = rots.copy()
    for f in np.where(np.abs(ang) > 1e-4)[0]:
        axis = G[ix['Chest']][f].apply([1.0, 0, 0])
        Gn = R.from_rotvec(axis * ang[f]) * G[n1][f]
        out[f, n1] = (G[sk['parents'][n1]][f].inv() * Gn).as_quat()
    return out, int(len(frames))

def root_fit(sk, roots, rots, floor, touch_mask, lam=0.01, pull_mask=None, pull=0.3):
    """The body's height, last: the smoothest curve (least squared second difference, staying near the clip) with
    nothing under the floor on any frame and the lowest part on the floor on every frame in touch_mask (the frames
    the contact pass put on the floor). Smoothing and settling stop fighting: one bounded least squares, exact."""
    from scipy.optimize import lsq_linear
    P, G = fk(sk, roots, rots); low = surface_low(sk, P, G)
    gap = np.min(np.stack(list(low.values())), axis=0) - floor
    T = len(roots)
    lb = -gap                                   # c >= -gap: nothing below the floor
    ub = np.full(T, np.inf)
    ub[touch_mask] = -gap[touch_mask] + TOUCH - 0.004   # the lowest part stays touching the floor
    ub = np.maximum(ub, lb + 1e-6)
    D = np.zeros((T - 2, T))
    for i in range(T - 2): D[i, i:i + 3] = [1, -2, 1]
    A = np.vstack([D, np.sqrt(lam) * np.eye(T)]); b = np.zeros(A.shape[0])
    if pull_mask is not None and pull_mask.any():   # soft: lying/rolling frames are drawn to the floor, not forced
        idx = np.where(pull_mask)[0]; Pm = np.zeros((len(idx), T)); Pm[np.arange(len(idx)), idx] = pull
        A = np.vstack([A, Pm]); b = np.r_[b, pull * (-gap[idx] + 0.005)]
    c = lsq_linear(A, b, bounds=(lb, ub), method='bvls').x
    out = roots.copy(); out[:, 1] += c
    return out, float(np.abs(c).max())

def touching(sk, roots, rots, floor, trunk_only=False):
    """Frames with something on the floor (trunk_only: the body itself, not a foot or hand, is the lowest part)."""
    P, G = fk(sk, roots, rots); low = surface_low(sk, P, G)
    names = list(low); L = np.stack([low[n] for n in names])
    t = L.min(axis=0) - floor <= TOUCH
    if trunk_only:
        t &= np.array([names[i] in TRUNK for i in L.argmin(axis=0)])
    return t

def tip_over(sk, roots, rots, floor, fps=30.0, cap=1.2):
    """Nearly still, centre of mass outside everything on the floor, and no part close enough to settle onto: the
    body tips over its support edge (a rigid turn of the whole body about the floor line nearest the centre of mass)
    until the next part lands, as gravity would make it. Turn smoothed over time."""
    from scipy.ndimage import gaussian_filter1d
    ix = {n: i for i, n in enumerate(sk['names'])}
    P, G = fk(sk, roots, rots); T = len(roots); com = com_of(sk, P)
    names = list(proxy())
    speed = np.r_[0, np.linalg.norm(np.diff(roots[:, [0, 2]], axis=0), axis=1)] * fps
    ang = np.zeros(T); axes = np.zeros((T, 3)); pivots = np.zeros((T, 3))
    # cheap screen first: only frames where something other than a foot touches can tip (most frames stand on feet)
    low = surface_low(sk, P, G)
    nonfoot = np.min(np.stack([v for k, v in low.items() if 'Foot' not in k and 'Toe' not in k]), axis=0) - floor
    for f in range(T):
        if speed[f] > 0.6 or nonfoot[f] >= TOUCH: continue
        W = np.concatenate([P[f, ix[n]] + G[ix[n]][f].apply(proxy()[n]) for n in names if n in ix])
        on = W[:, 1] - floor < TOUCH
        if on.sum() < 3: continue
        # only a body resting on something other than its feet (lying, on its shins or knees) tips; one standing
        # on its feet is left to the balance check (tipping a dancer shook her)
        part_of = np.concatenate([[n] * len(proxy()[n]) for n in names if n in ix])
        if all(('Foot' in n or 'Toe' in n) for n in set(part_of[on])): continue
        sup = W[on][:, [0, 2]]
        if _outside(sup, com[f, [0, 2]]) <= 0.15: continue
        # pivot: the support point nearest the centre of mass; tip toward the centre of mass
        k = np.argmin(np.linalg.norm(sup - com[f, [0, 2]], axis=1)); p2 = sup[k]
        d = com[f, [0, 2]] - p2; d /= max(np.linalg.norm(d), 1e-9)
        axis = np.array([d[1], 0.0, -d[0]])                  # horizontal, across the tipping direction
        piv = np.array([p2[0], floor, p2[1]])
        # it tips until something beyond the centre of mass lands, so the new support spans the weight
        side = (((W[:, [0, 2]] - p2) @ d) > (com[f, [0, 2]] - p2) @ d) & ~on
        def low_after(a):
            Wr = piv + R.from_rotvec(axis * a).apply(W[side] - piv)
            return Wr[:, 1].min() - floor
        sign = 1.0 if low_after(0.02) < low_after(-0.02) else -1.0
        if low_after(0) <= TOUCH or not side.any(): continue
        lo, hi = 0.0, sign * cap
        if low_after(hi) > 0: continue
        for _ in range(20):
            mid = (lo + hi) / 2
            if low_after(mid) > 0.003: lo = mid
            else: hi = mid
        ang[f], axes[f], pivots[f] = lo, axis, piv
    m = ang != 0
    if m.sum() < 8: return roots, rots, []
    spans = [(int(a), int(b)) for a, b in runs(m) if b - a >= 7]   # as the balance check: 8+ frames, not a moment
    if not spans: return roots, rots, []
    keep = np.zeros(T, bool)
    for a, b in spans: keep[a:b + 1] = True
    # fill axes/pivots across the eased edges from the nearest tipped frame, then ease and smooth the angle
    idx = np.where(keep)[0]
    near = idx[np.abs(np.arange(T)[:, None] - idx[None, :]).argmin(axis=1)]
    axes, pivots = axes[near], pivots[near]
    a = gaussian_filter1d(eased(np.where(keep, ang, 0), keep, 6), 1.5, mode='nearest')
    out_r, out_q = roots.copy(), rots.copy()
    for f in np.where(np.abs(a) > 1e-4)[0]:
        Rt = R.from_rotvec(axes[f] * a[f])
        out_r[f] = pivots[f] + Rt.apply(roots[f] - pivots[f])
        out_q[f, 0] = (Rt * R.from_quat(rots[f, 0])).as_quat()
    return out_r, out_q, spans

def foot_lock(sk, raw_roots, raw_rots, roots, rots, floor, still=0.015, ease=3):
    """Last word on feet: wherever the clip as generated had a foot planted (still, sole within 3 cm of the floor, 4+
    frames), the foot stays in one place for the whole plant — where the generator put it — with its sole on the floor;
    leg IK absorbs whatever the clean-up did to the body (physics, settling, tipping, the hips' height fit). The foot's
    own turn is left as it is (a changed turn made feet snap). Planted feet do not slide, bob or sink."""
    ix = {n: i for i, n in enumerate(sk['names'])}; T = len(roots)
    P0, G0 = fk(sk, raw_roots, raw_rots); low0 = surface_low(sk, P0, G0)
    out = rots.copy(); locked = []
    for side, chain in LEG.items():
        f = ix[side + 'Foot']
        sole0 = np.minimum(low0[side + 'Foot'], low0[side + 'ToeBase']) - floor
        sp = np.r_[np.inf, np.linalg.norm(np.diff(P0[:, f][:, [0, 2]], axis=0), axis=1)]
        plant = (sole0 < 0.03) & (sp < still)
        spans = [(a, b) for a, b in runs(plant) if b - a >= 3]
        if not spans: continue
        w = np.zeros(T); xz = np.zeros((T, 2))
        for a, b in spans:
            xz[a:b + 1] = np.median(P0[a:b + 1, f][:, [0, 2]], axis=0)     # one place for the whole plant
            w[a:b + 1] = 1.0
        # the eased edges carry the nearest plant's place
        idx = np.where(w > 0)[0]
        near = idx[np.abs(np.arange(T)[:, None] - idx[None, :]).argmin(axis=1)]
        xz = xz[near]
        w = eased(w, w > 0, ease)
        from scipy.ndimage import gaussian_filter1d
        for _ in range(2):          # place, then set the height so the sole (with the foot's own turn) is on the floor
            P, G = fk(sk, roots, out); low = surface_low(sk, P, G)
            sole = np.minimum(low[side + 'Foot'], low[side + 'ToeBase']) - floor
            # only what is wrong moves: drift under 1 cm stays, a sole within 4 mm of the floor stays (IK on a leg that
            # did not need it shook the knee); corrections smoothed over time
            d = xz - P[:, f][:, [0, 2]]; n = np.linalg.norm(d, axis=1, keepdims=True)
            d = d * np.clip(1 - 0.01 / np.maximum(n, 1e-9), 0, None)
            dy = np.where(sole > 0.004, 0.002 - sole, np.where(sole < -0.002, -sole, 0.0))
            d = gaussian_filter1d(d * w[:, None], 1.5, axis=0, mode='nearest'); dy = gaussian_filter1d(dy * w, 1.5, mode='nearest')
            dy = np.where(sole < 0, np.maximum(dy, -sole * w), dy)              # never into the floor
            tgt = P[:, f].copy(); tgt[:, [0, 2]] += d; tgt[:, 1] += dy
            # a leg that would have to stretch nearly straight to reach takes little or none of it (that is where IK
            # snaps a knee)
            hip, knee = ix[chain[0]], ix[chain[1]]
            k = straight_fade(P, hip, knee, f, tgt)
            tgt = P[:, f] + k[:, None] * (tgt - P[:, f])
            moved = np.where(np.linalg.norm(tgt - P[:, f], axis=1) > 1e-4)[0]
            if len(moved): out = two_bone(sk, roots, out, chain, tgt, list(moved), end_global=G[f].as_quat())
        locked.append((side, [(int(a), int(b)) for a, b in spans]))
    return out, locked

def knee_lock(sk, raw_roots, raw_rots, roots, rots, floor, still=0.015, ease=3, hips_tol=0.02):
    """Knees down in the clip as generated (kneeling: a shin's surface within 3 cm of the floor, the knee still, 4+
    frames) stay down: on those frames the leg (hip, knee, ankle, toes) goes back to the clip's own turns, eased in and
    out, wherever the hips are within `hips_tol` of where the clip had them (elsewhere the raw leg would land the knee
    somewhere else, and the foot lock's IK rules). Physics lifted a kneeling body's knees 3-4 cm off the floor while
    the foot lock held the toes: held up by the toes alone it leaned 21 cm past its support (`balance`)."""
    ix = {n: i for i, n in enumerate(sk['names'])}; T = len(roots)
    P0, G0 = fk(sk, raw_roots, raw_rots); low0 = surface_low(sk, P0, G0)
    out = rots.copy(); locked = []
    near_hips = np.linalg.norm(np.asarray(roots) - np.asarray(raw_roots), axis=1) < hips_tol
    for side in ('Left', 'Right'):
        if side + 'Shin' not in low0: continue
        knee = ix[side + 'Shin']
        sp = np.r_[np.inf, np.linalg.norm(np.diff(P0[:, knee], axis=0), axis=1)]
        down = (low0[side + 'Shin'] - floor < 0.03) & (sp < still) & near_hips
        spans = [(a, b) for a, b in runs(down) if b - a >= 3]
        if not spans: continue
        w = np.zeros(T)
        for a, b in spans: w[a:b + 1] = 1.0
        w = eased(w, w > 0, ease)
        for name in (side + 'Leg', side + 'Shin', side + 'Foot', side + 'ToeBase'):
            j = ix[name]
            for k in np.where(w > 0)[0]:
                out[k, j] = R.from_quat([out[k, j], raw_rots[k, j]]).mean(weights=[1 - w[k], w[k]]).as_quat() if w[k] < 1 else raw_rots[k, j]
        # a blend of two leg poses on the ease frames, or the clip's leg with the hips 1 cm off, can dip the toes (2.5 cm):
        # those feet go back up by leg IK, turn kept
        ease_fr = np.where(w > 0)[0]   # every locked frame: the clip's leg with the hips a little off can dip a toe too
        if len(ease_fr):
            P, G = fk(sk, roots, out); low = surface_low(sk, P, G); f = ix[side + 'Foot']
            dip = floor - np.minimum(low[side + 'Foot'], low[side + 'ToeBase'])
            fix = [int(k) for k in ease_fr if dip[k] > 0.002]
            if fix:
                tgt = P[:, f].copy(); tgt[fix, 1] += dip[fix] + 0.002
                out = two_bone(sk, roots, out, LEG[side], tgt, fix, end_global=G[f].as_quat())
        locked.append((side, [(int(a), int(b)) for a, b in spans]))
    return out, locked


def hold_feet(sk, roots, rots, floor, lift=0.04, ease=4, max_drift=0.15):
    """In-place moves (crouch, squat, pick up): a foot whose toe is on the floor stays there. Each stretch of the toe
    down (within `lift` of the floor, 4+ frames; a real step lifts the toe more) holds the toe where that stretch began; the heel may rise (the ankle
    follows the toe, keeping the foot's own turn); leg IK does the rest, eased in and out over `ease` frames. Kimodo let
    crouching feet drift 8-13 cm (2026-10-28); pinning the feet in generation froze the hips instead."""
    ix = {n: i for i, n in enumerate(sk['names'])}
    P, G = fk(sk, roots, rots)
    out = rots.copy(); held = []
    for side, chain in LEG.items():
        f, t = ix[side + 'Foot'], ix[side + 'ToeBase']
        toe, ank = P[:, t], P[:, f]
        spans = [(a, b) for a, b in runs(toe[:, 1] - floor < lift) if b - a >= 3]
        if not spans: continue
        tgt = ank.copy(); fr = []
        for a, b in spans:
            anchor = toe[a:min(b + 1, a + 3)].mean(axis=0)
            # a foot that goes further than drift (a low step or a slide out into a wide stance) is a move the
            # generator meant: held back, the leg folded into a tangle (2026-10-28 crouch). Drift is 8-13 cm.
            if np.linalg.norm((toe[a:b + 1] - anchor)[:, [0, 2]], axis=1).max() > max_drift:
                continue
            for k in range(a, b + 1):
                w = min(1.0, (k - a + 1) / ease, (b - k + 1) / ease) if b - a >= 2 * ease else 1.0
                d = np.array([anchor[0] - toe[k, 0], 0.0, anchor[2] - toe[k, 2]]) * w
                tgt[k] = ank[k] + d; fr.append(k)
            held.append((side, int(a), int(b)))
        out = two_bone(sk, roots, out, chain, tgt, fr, end_global=G[f].as_quat())
    return out, held

def lift_steps(sk, roots, rots, floor, fast=0.01, travel_min=0.10, lift_max=0.10, window=None):
    """Tracked motion: a foot that travels along the floor at speed is a step whose lift the tracker missed (monocular
    tracking keeps a swinging foot at floor height: a 36 cm side step came out as a glide). Where a sole is at the
    floor and moving over 0.3 m/s for 4+ frames with 10 cm or more of travel, the foot is lifted on an arc (a third
    of its travel, up to 10 cm) by leg IK, its turn kept. Returns (rots, [(side, from, to, travel_m)])."""
    ix = {n: i for i, n in enumerate(sk['names'])}; T = len(roots); out = rots.copy(); lifted = []
    for side, chain in LEG.items():
        f = ix[side + 'Foot']
        P, G = fk(sk, roots, out); low = surface_low(sk, P, G)
        sole = np.minimum(low[side + 'Foot'], low[side + 'ToeBase']) - floor
        sp = np.r_[0.0, np.linalg.norm(np.diff(P[:, f][:, [0, 2]], axis=0), axis=1)]
        glide = (sole < 0.03) & (sp > fast)
        dy = np.zeros(T)
        if window is not None:   # only the stretch a check flagged (a generated clip's glide; its other steps are fine)
            m = np.zeros(T, bool); m[max(0, window[0]):min(T, window[1] + 1)] = True; glide &= m
        for a, b in runs(glide):
            if b - a + 1 < 4: continue
            travel = float(np.linalg.norm(P[b, f][[0, 2]] - P[a, f][[0, 2]]))
            if travel < travel_min: continue
            amp = min(lift_max, 0.3 * travel)
            dy[a:b + 1] = np.maximum(dy[a:b + 1], amp * np.sin(np.pi * np.linspace(0, 1, b - a + 1)))
            lifted.append((side, int(a), int(b), travel))
        if not dy.any(): continue
        tgt = P[:, f].copy(); tgt[:, 1] += dy
        hip, knee = ix[chain[0]], ix[chain[1]]
        k = straight_fade(P, hip, knee, f, tgt); tgt = P[:, f] + k[:, None] * (tgt - P[:, f])
        out = two_bone(sk, roots, out, chain, tgt, np.where(dy > 1e-4)[0])
    return out, lifted


def smooth_feet(sk, rots, sigma=1.5):
    """Physics and IK tilt the feet a little every frame (foot jerk 2-4x the generated clip's); the feet's and toes'
    own turns are smoothed lightly over time (Gaussian, sign-continuous quaternions). Nothing else is touched."""
    from scipy.ndimage import gaussian_filter1d
    ix = {n: i for i, n in enumerate(sk['names'])}; out = rots.copy()
    for n in ('LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'):
        q = out[:, ix[n]].copy()
        for k in range(1, len(q)):
            if np.dot(q[k], q[k - 1]) < 0: q[k] = -q[k]
        q = gaussian_filter1d(q, sigma, axis=0, mode='nearest')
        out[:, ix[n]] = q / np.linalg.norm(q, axis=1, keepdims=True)
    return out

def ankle_guard(sk, raw_rots, rots, extra=12.0):
    """Clean-up may not curl a foot back: on every frame each ankle bends at most `extra` degrees further (toes up,
    toward the shin) than the generated clip had it. Holding planted feet while the body moved flexed ankles 20-50°.
    The correction is eased over neighbouring frames and smoothed (a per-frame clamp popped the knee)."""
    from scipy.ndimage import gaussian_filter1d, maximum_filter1d
    ix = {n: i for i, n in enumerate(sk['names'])}; out = rots.copy()
    for s_ in ('Left', 'Right'):
        j = ix[s_ + 'Foot']
        r0 = R.from_quat(raw_rots[:, j]).as_rotvec(); r1 = R.from_quat(out[:, j]).as_rotvec()
        need = np.maximum(0.0, (r0[:, 0] - np.radians(extra)) - r1[:, 0])      # how far past the allowance (radians)
        if not need.any(): continue
        add = np.maximum(gaussian_filter1d(maximum_filter1d(need, 7), 2.0, mode='nearest'), need)
        r1[:, 0] += add
        out[:, j] = R.from_rotvec(r1).as_quat()
    return out

def hand_keep_near_props(sk, raw_roots, raw_rots, roots, rots, props, dist=0.15, ease=3, skip=None):
    """Near a box, a hand goes back to where the clip as given had it (place and turn; arm IK absorbs the body's
    changes): the frames where the given hand's surface is within `dist` of a box and not inside it. Physics lag
    pulled a hand rising over a table edge 4 cm low, into the edge (sequences already route hands around boxes)."""
    ix = {n: i for i, n in enumerate(sk['names'])}; T = len(roots); out = rots.copy(); kept = []
    boxes = [b for b in props or () if b.get('kind', 'box') == 'box']
    if not boxes: return out, kept
    P0, G0 = fk(sk, raw_roots, raw_rots); pts = proxy()
    for side, chain in ARM.items():
        h = ix[side + 'Hand']; M = G0[h].as_matrix()
        W = P0[:, h][:, None, :] + np.einsum('tij,nj->tni', M, pts[side + 'Hand'])
        near = np.zeros(T, bool); inside = np.zeros(T, bool)
        for b in boxes:
            c, s_ = np.cos(b.get('yaw', 0.0)), np.sin(b.get('yaw', 0.0)); top = b['pos'][1] + b['size'][1]
            dx, dz = W[..., 0] - b['pos'][0], W[..., 2] - b['pos'][2]
            lx, lz = np.abs(dx * c + dz * s_), np.abs(-dx * s_ + dz * c); hx, hz = b['size'][0] / 2, b['size'][2] / 2
            ex, ez, ey = np.maximum(lx - hx, 0), np.maximum(lz - hz, 0), np.maximum(W[..., 1] - top, 0) + np.maximum(b['pos'][1] - W[..., 1], 0)
            gap = np.sqrt(ex * ex + ez * ez + ey * ey)                       # 0 inside, else distance to the box
            near |= (gap < dist).any(axis=1)
            inside |= ((lx < hx) & (lz < hz) & (W[..., 1] < top - 0.005) & (W[..., 1] > b['pos'][1])).any(axis=1)
        keep = near & ~inside
        # not where the given hand was in the body (a seated hand on the thigh beside the box): putting it back there
        # undid the arm push-out, and the push-out then threw the hand 27 cm in a frame
        if skip is not None and side in skip: keep &= ~skip[side]
        spans = [(a, b_) for a, b_ in runs(keep) if b_ - a >= 1]
        if not spans: continue
        w = np.zeros(T)
        for a, b_ in spans: w[a:b_ + 1] = 1.0
        w = eased(w, w > 0, ease)
        P, G = fk(sk, roots, out)
        tgt = P[:, h] + (P0[:, h] - P[:, h]) * w[:, None]
        tq = np.array([(R.from_quat([G[h][k].as_quat(), G0[h][k].as_quat()]).mean(weights=[1 - w[k], w[k]])).as_quat() if 0 < w[k] < 1 else (G0[h][k].as_quat() if w[k] >= 1 else G[h][k].as_quat()) for k in range(T)])
        out = two_bone(sk, roots, out, chain, tgt, list(np.where(w > 0)[0]), end_global=tq)
        kept.append((side, [(int(a), int(b_)) for a, b_ in spans]))
    return out, kept

def hand_lock(sk, raw_roots, raw_rots, roots, rots, floor, still=0.015, ease=3, skip=None, props=()):
    """Hands planted on the floor in the clip as generated (push-ups, cartwheels, crawls, getting up) go back exactly
    where the generator put them, turned as it turned them; arm IK absorbs the body's changes. Physics shoved a
    push-up's hands 34 cm off the floor (they sit under the chest, and the chest is a fat collision capsule).
    With props, a hand resting on a box top (a vault, a lean on a table) is planted the same way."""
    ix = {n: i for i, n in enumerate(sk['names'])}; T = len(roots)
    P0, G0 = fk(sk, raw_roots, raw_rots); low0 = surface_low(sk, P0, G0)
    out = rots.copy(); locked = []
    for side, chain in ARM.items():
        h = ix[side + 'Hand']
        lowh = low0[side + 'Hand'] - (support_at(props, floor, P0[:, h][:, [0, 2]]) if props else floor)
        sp = np.r_[np.inf, np.linalg.norm(np.diff(P0[:, h][:, [0, 2]], axis=0), axis=1)]
        plant = (lowh < 0.03) & (sp < still)
        # a raw hand that sat inside the body (a crumpled fall, a hand through the thigh) is not a placement to
        # keep: putting it back undid the push-out (10 cm of arm through the head on a lying body)
        if skip is not None and side in skip: plant &= ~skip[side]
        spans = [(a, b) for a, b in runs(plant) if b - a >= 3]
        if not spans: continue
        w = np.zeros(T)
        for a, b in spans: w[a:b + 1] = 1.0
        w = eased(w, w > 0, ease)
        P, G = fk(sk, roots, out)
        goal = P0[:, h].copy(); goal[:, 1] += np.maximum(0.0, -lowh) + 0.002 * (lowh < 0)   # the generator's place, out of the floor
        tgt = P[:, h] + (goal - P[:, h]) * w[:, None]
        tq = np.array([(R.from_quat([G[h][k].as_quat(), G0[h][k].as_quat()]).mean(weights=[1 - w[k], w[k]])).as_quat() if 0 < w[k] < 1 else (G0[h][k].as_quat() if w[k] >= 1 else G[h][k].as_quat()) for k in range(T)])
        out = two_bone(sk, roots, out, chain, tgt, list(np.where(w > 0)[0]), end_global=tq)
        locked.append((side, [(int(a), int(b)) for a, b in spans]))
    return out, locked
