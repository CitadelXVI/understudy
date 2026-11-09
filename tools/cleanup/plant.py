"""Plant, then step (2026-10-29): the feet-only fix for a generated clip's glides and spins, leaving the body's own motion
(the mocap feel) alone.

Kimodo often lets a foot that is down keep travelling along the floor (a glide: the gauntlet judges' first complaint) or
turns the body on planted feet (a spin: their second). A real foot does neither: it stays where it was put, then lifts
and steps to its new place. Per foot, per contact (the toe at its floor height for 5+ frames, as gait.go measures it):
  - while it is down, the TOE stays where it landed and the foot keeps the heading it landed with; the foot's own roll
    (heel lifting, toe pivoting) is Kimodo's, carried rigidly about the toe;
  - where the generator moved it further than a glide allows (4 cm, or turned it more than 25 degrees), the contact gets
    quick steps (7 frames, lifted on an arc) placed where the drift is half done, so a held foot never lags the
    generator's by more than half the drift, and the last step lands on the generator's own end-of-contact placement;
  - Kimodo stands on nearly straight legs (reach 0.99 of the leg), and no straight leg can hold a foot even 5 cm off its
    path: the hips sink just enough for the held foot (a few mm to ~3 cm, eased), and both legs are solved again so the
    other foot stays where it was. Nothing else moves.
Contacts that already hold still (most of a good walk) are left as they are."""
import numpy as np
from scipy.spatial.transform import Rotation as R
from scipy.ndimage import gaussian_filter1d, maximum_filter1d
from contact import fk, runs, two_bone, LEG

def _yaw(v):
    return np.arctan2(v[..., 0], v[..., 2])

def _wrap(a):
    return np.angle(np.exp(1j * a))

def plant_steps(sk, roots, rots, slide_m=0.04, turn_deg=25.0, step_len=0.30, step_frames=7, lift_min=0.03, lift_max=0.08,
                reach_max=0.96, ease=4, window=None):
    ix = {n: i for i, n in enumerate(sk['names'])}; T = len(roots)
    P, G = fk(sk, roots, rots)
    tgt, q_end, touched, done = {}, {}, {}, []
    for side, chain in LEG.items():
        f, t = ix[side + 'Foot'], ix[side + 'ToeBase']
        toe, ank = P[:, t], P[:, f]
        rest = np.percentile(toe[:, 1], 5)
        vy = np.abs(np.r_[0.0, np.diff(toe[:, 1])])
        down = (toe[:, 1] < rest + 0.015) & (vy < 0.006)
        if window is not None:
            m = np.zeros(T, bool); m[max(0, window[0]):min(T, window[1] + 1)] = True; down &= m
        tg = ank.copy(); qe = G[f].as_quat().copy(); tc = np.zeros(T, bool)
        heading = _yaw(toe - ank)                                     # the foot's heading (ankle -> toe, on the floor)
        for a, b in runs(down):
            if b - a + 1 < 5: continue
            xz = toe[a:b + 1][:, [0, 2]]
            dist = np.linalg.norm(xz - xz[0], axis=1)
            turnc = np.degrees(np.abs(_wrap(heading[a:b + 1] - heading[a])))
            if dist.max() < slide_m and turnc.max() < turn_deg: continue   # already planted
            travel = float(np.linalg.norm(xz[-1] - xz[0])); turn = float(turnc[-1])
            n = int(max(1, np.ceil(travel / step_len), np.ceil(turn / 45.0)))
            # each step sits where its share of the drift (moved + turned) is half done
            prog = np.maximum(dist / max(travel, 1e-6) if travel >= slide_m else 0 * dist, turnc / max(turn, 1e-6) if turn >= turn_deg else 0 * dist)
            prog = np.maximum.accumulate(np.clip(prog, 0, 1))
            mids = [a + int(np.searchsorted(prog, (i + 0.5) / n)) for i in range(n)]
            ends = [a + int(np.searchsorted(prog, (i + 1.0) / n - 1e-6)) for i in range(n)]
            anchor, a_head, cur = toe[a].copy(), heading[a], a
            for i in range(n):
                k = step_frames
                # a whole arc, always: a step cut off by the contact's end dropped the lifted foot back in one frame
                s0 = int(max(cur, min(mids[i] - k // 2, b - k))); s1 = int(min(b, s0 + k))
                if s1 - s0 < 3: continue
                land = min(b, max(ends[i], s1))
                if i == n - 1 and b >= T - 3:
                    # the contact runs to the clip's end: the last step lands on the clip's own final stance. Landing
                    # a centimetre off it bent the near-straight standing leg 11 degrees (174 -> 163) in the end pose
                    land = b
                goal, g_head = toe[land].copy(), heading[land]
                for fr in range(cur, s1 + 1):
                    if fr < s0:
                        pos, hd, lift = anchor, a_head, 0.0
                    else:
                        u = (fr - s0) / max(1, s1 - s0); w = u * u * (3 - 2 * u)
                        pos = anchor + w * (goal - anchor); hd = a_head + w * _wrap(g_head - a_head)
                        d = float(np.linalg.norm((goal - anchor)[[0, 2]]))
                        lift = min(lift_max, max(lift_min, 0.35 * d)) * np.sin(np.pi * u)
                    rot = R.from_rotvec([0.0, _wrap(hd - heading[fr]), 0.0])
                    p = np.array([pos[0], toe[fr][1] + lift, pos[2]])
                    tg[fr] = p + rot.apply(ank[fr] - toe[fr]); qe[fr] = (rot * G[f][fr]).as_quat(); tc[fr] = True
                anchor, a_head, cur = goal, g_head, s1 + 1
            for fr in range(cur, b + 1):          # after the last step: planted on the landing until the contact ends
                rot = R.from_rotvec([0.0, _wrap(a_head - heading[fr]), 0.0])
                p = np.array([anchor[0], toe[fr][1], anchor[2]])
                tg[fr] = p + rot.apply(ank[fr] - toe[fr]); qe[fr] = (rot * G[f][fr]).as_quat(); tc[fr] = True
            done.append((side, int(a), int(b), round(float(dist.max()), 3), round(float(turnc.max()), 1), n))
        # the correction eases out after a contact and in before it (an edge where it switched off snapped the shin)
        if tc.any():
            idx = np.where(tc)[0]
            near = idx[np.abs(np.arange(T)[:, None] - idx[None, :]).argmin(axis=1)]
            gap = np.abs(np.arange(T) - near)
            w = np.clip(1 - gap / (ease + 1), 0, 1); w = w * w * (3 - 2 * w)
            edge = (~tc) & (w > 0)
            off = tg[near] - ank[near]
            dq = R.from_quat(qe[near]) * G[f][near].inv()
            for fr in np.where(edge)[0]:
                tg[fr] = ank[fr] + w[fr] * off[fr]
                qe[fr] = (R.from_rotvec(dq[fr].as_rotvec() * w[fr]) * G[f][fr]).as_quat()
            tc = tc | edge
        tgt[side], q_end[side], touched[side] = tg, qe, tc
    if not any(tc.any() for tc in touched.values()):
        return roots, rots, done
    # the hips sink as much as the held feet need (a straight leg cannot reach a foot off its path)
    need = np.zeros(T)
    for side, chain in LEG.items():
        h, k_, f = (ix[n] for n in chain)
        L = np.linalg.norm(P[:, k_] - P[:, h], axis=1) + np.linalg.norm(P[:, f] - P[:, k_], axis=1)
        # the reach allowed: the generator's own leg (a standing leg sits at ~0.99), at most 0.985 so IK never solves a
        # locked-straight leg; a lower cap sank the hips 3 cm on every touched foot and left walks ending in a squat
        own = np.linalg.norm(P[:, f] - P[:, h], axis=1) / np.maximum(L, 1e-9)
        cap = np.clip(own, reach_max, 0.985)
        # where the held foot is (almost) where the clip already has it, the leg keeps its own reach: capping a standing
        # leg sank every settled end into a 158-degree soft-kneed slump the judges marked down (raw 174 -> 158)
        moved_by = np.linalg.norm(tgt[side] - P[:, f], axis=1)
        cap = np.where(moved_by < 0.01, np.maximum(cap, own), cap)
        d = tgt[side] - P[:, h]; horiz2 = d[:, 0] ** 2 + d[:, 2] ** 2; vmax = np.sqrt(np.maximum((cap * L) ** 2 - horiz2, 0))
        need = np.maximum(need, np.where(touched[side], np.maximum(0, -d[:, 1] - vmax), 0))   # -d.y: how far the hip is above
    need = gaussian_filter1d(maximum_filter1d(need, 7), 2.5)
    roots2 = roots.copy(); roots2[:, 1] -= need
    out = rots.copy()
    moved = need > 1e-4
    for side, chain in LEG.items():
        fr = np.where(touched[side] | moved)[0]
        if len(fr): out = two_bone(sk, roots2, out, chain, tgt[side], fr, end_global=q_end[side])
    # leg IK near a straight leg can flip a knee for a frame (a 4-5 cm shin snap flagged as jitter): the changed legs'
    # own turns get a light smoothing over time (sign-continuous quaternions), only where this pass touched them
    span = np.zeros(T, bool)
    for side in LEG: span |= touched[side]
    span |= moved
    span = maximum_filter1d(span.astype(float), 5) > 0
    for side, chain in LEG.items():
        for n in chain:
            j = ix[n]; q = out[:, j].copy()
            for k in range(1, T):
                if np.dot(q[k], q[k - 1]) < 0: q[k] = -q[k]
            qs = gaussian_filter1d(q, 1.2, axis=0, mode='nearest'); qs /= np.linalg.norm(qs, axis=1, keepdims=True)
            out[span, j] = qs[span]
    return roots2, out, done
