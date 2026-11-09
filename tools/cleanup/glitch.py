"""Thrash: a hand, foot or head whose orientation whips back and forth over a few frames while its joint stays put,
or a limb bone spinning about its own length at a rate no joint can (a forearm 111° in one frame). Kimodo writes
these now and then (a person falling over: the right hand turned 49°, 38°, 44°, 65° on consecutive frames,
fingertips jumping 20 cm, the wrist still). Smoothing cannot take them out (a 9-frame fit over a 250° thrash only
spreads it), so the burst is replaced with the straight path between the calm frames on each side: the net turn is
kept, the thrash lost. A hand, foot or head is re-laid relative to its parent (it keeps following the arm or leg);
a limb bone keeps its direction (every joint stays exactly where it was) and only its spin is re-laid. A burst is
only a thrash when its chord is much shorter than its path (a punch turns the hand 50°/frame too, but straight on).
Trunk joints are never touched."""
import numpy as np
from scipy.spatial.transform import Rotation as R

LIMB = {'LeftArm': 'LeftForeArm', 'LeftForeArm': 'LeftHand', 'RightArm': 'RightForeArm', 'RightForeArm': 'RightHand',
        'LeftLeg': 'LeftShin', 'LeftShin': 'LeftFoot', 'RightLeg': 'RightShin', 'RightShin': 'RightFoot'}
ENDS = ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'Head']


def _world(sk, rots):
    par = sk['parents']; G = [None] * len(par)
    for j, p in enumerate(par):
        q = R.from_quat(rots[:, j]); G[j] = q if p < 0 else G[p] * q
    return G


def _bursts(rate, jump, max_len, T):
    hot = rate > jump; out = []; i = 0
    while i < T:
        if not hot[i]: i += 1; continue
        a = i
        while i < T and (hot[i] or (i + 1 < T and hot[i + 1]) or (i + 2 < T and hot[i + 2])): i += 1
        b = i - 1
        a0, b1 = max(0, a - 2), min(T - 1, b + 2)            # calm frames on each side carry the chord
        if b1 - a0 <= max_len and a0 > 0 and b1 < T - 1: out.append((a0, b1))
    return out


def _is_thrash(q, a, b, ratio):
    """q [T,4] of one joint (any frame): the burst's chord over its path, below `ratio` = back-and-forth."""
    seg = R.from_quat(q[a:b + 1]); path = np.degrees((seg[1:] * seg[:-1].inv()).magnitude()).sum()
    chord = np.degrees((seg[-1] * seg[0].inv()).magnitude())
    return path > 1e-6 and chord / path < ratio, chord, path


def repair_flips(sk, rots, jump=35.0, max_len=14, ratio=0.6):
    """Returns (rots, repairs): repairs = [(joint, from, to, chord_deg, path_deg)]."""
    names = sk['names']; ix = {n: i for i, n in enumerate(names)}; par = sk['parents']; off = np.array(sk['offsets'], float)
    T = len(rots); out = rots.copy(); repairs = []
    # 1) hands, feet, head: relative to the parent (local), the burst replaced by the local slerp
    for n in ENDS:
        if n not in ix: continue
        j = ix[n]; q = out[:, j]; loc = R.from_quat(q)
        rate = np.r_[0, np.degrees((loc[1:] * loc[:-1].inv()).magnitude())]
        for a, b in _bursts(rate, jump, max_len, T):
            ok, chord, path = _is_thrash(q, a, b, ratio)
            if not ok: continue
            t = (np.arange(a, b + 1) - a) / (b - a); rel = (loc[b] * loc[a].inv()).as_rotvec()
            out[a:b + 1, j] = (R.from_rotvec(np.outer(t, rel)) * loc[a]).as_quat()
            repairs.append((n, int(a), int(b), round(chord), round(path)))
    # 2) limb bones: spin about the bone only, in the world; the bone's direction (and so every joint) stays
    G = _world(sk, out); W = {j: G[j] for j in range(len(names))}; changed = set()
    for n, child in LIMB.items():
        if n not in ix or child not in ix: continue
        j = ix[n]; g = W[j]; axis = off[ix[child]] / np.linalg.norm(off[ix[child]])
        d = (g[1:] * g[:-1].inv()).as_rotvec(); ax = g[:-1].apply(axis)
        spin = np.degrees((d * ax).sum(1)); rate = np.r_[0, np.abs(spin)]
        for a, b in _bursts(rate, jump, max_len, T):
            path = np.abs(spin[a:b]).sum(); chord = abs(spin[a:b].sum())
            if path < 1e-6 or chord / path >= ratio: continue
            t = (np.arange(a, b + 1) - a) / (b - a); rel = (g[b] * g[a].inv()).as_rotvec()
            new = R.from_rotvec(np.outer(t, rel)) * g[a]
            want = g[a:b + 1].apply(axis); have = new.apply(axis)
            cross = np.cross(have, want); s = np.linalg.norm(cross, axis=1); c = (have * want).sum(1)
            new = R.from_rotvec(cross / np.maximum(s, 1e-12)[:, None] * np.arctan2(s, c)[:, None]) * new
            qs = g.as_quat(); qs[a:b + 1] = new.as_quat(); W[j] = R.from_quat(qs); changed.add(j)
            repairs.append((n, int(a), int(b), round(chord), round(path)))
    if changed:
        for j in range(len(names)):   # back to parent-local; everything below a changed bone keeps its world orientation
            p = par[j]
            if p < 0: continue
            if j in changed or p in changed: out[:, j] = (W[p].inv() * W[j]).as_quat()
    return out, repairs
