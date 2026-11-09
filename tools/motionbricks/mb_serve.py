"""MotionBricks worker for the Understudy server (one kept process, like cleanup.py --serve).

One job per line on stdin, a JSON object: {"in": dir, "out": dir, "op": "regen"|"settle"|"loop", "from": a, "to": b,
"tokens": n|null}. The in dir holds root_positions.f32, local_rotations_xyzw.f32 and skeleton.json; the out dir
receives the new streams and report.json. One reply line: OK, or ERR and the reason.

regen   : frames a..b (0-based, inclusive) are replaced by motion generated from the 4 frames before a to the frames
          after b. The length stays the same when the model's choices allow it (tokens = gap+2+6 over 4, clamped to
          6..16), or tokens forces a length (valid frames = 4*tokens - 6 including both ends).
settle  : the clip's last 4 frames bridge to a standing pose (the clip's own first frame, turned to the current
          heading, placed where the body is), so a move cut off mid-motion comes to rest.
loop    : the clip's last 4 frames bridge back to its first 4 frames (turned to the current heading, placed where
          the body is), so the clip loops; the root carries on forward (root-motion loop).
"""
import json, os, sys, traceback
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'cleanup'))
from scipy.spatial.transform import Rotation as R

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mb

J = mb.J


def load(d):
    sk = json.load(open(os.path.join(d, 'skeleton.json')))
    rp, qp = os.path.join(d, 'root_positions.f32'), os.path.join(d, 'local_rotations_xyzw.f32')
    if not os.path.exists(rp):
        return sk, np.zeros((0, 3)), np.zeros((0, J, 4))
    roots = np.fromfile(rp, np.float32).reshape(-1, 3).astype(float)
    rots = np.fromfile(qp, np.float32).reshape(-1, J, 4).astype(float)
    return sk, roots, rots


def save(d, roots, rots, report):
    os.makedirs(d, exist_ok=True)
    np.asarray(roots, np.float32).tofile(os.path.join(d, 'root_positions.f32'))
    np.asarray(rots, np.float32).tofile(os.path.join(d, 'local_rotations_xyzw.f32'))
    json.dump(report, open(os.path.join(d, 'report.json'), 'w'))


def heading_of(sk, roots, rots, f):
    roots = np.asarray(roots, float); rots = np.asarray(rots, float)
    P, _ = mb.fk(sk, roots[[f]], rots[[f]]); ix = {n: i for i, n in enumerate(sk['names'])}
    return mb.heading(P[0, ix['RightLeg']], P[0, ix['LeftLeg']])


def stepping_stages(session, sk, ctxr, ctxq, goal_r, goal_q, ixp, k, step_deg=50, step_m=0.30, tokens=(6, 7, 8)):
    """Walk and turn from the context to the standing pose (goal_r, goal_q) with real steps: short stages, each to a
    pose with one foot lifted and ahead mid-step (alternating feet), along the arc from here to the goal; the last stage
    lands both feet in the goal pose. One stage straight to a turned standing pose made the model glide the body round
    on planted feet (owner, 2026-10-27: "they just rotate as if some force was applied"; 182 deg with no step, 38 cm of
    toe travel). Returns (frames_r, frames_q, ctxr, ctxq, stages)."""
    import contact as C
    start = ctxr[3].copy(); h0 = heading_of(sk, ctxr, ctxq, 3); h1 = heading_of(sk, goal_r[None], goal_q[None], 0)
    dturn = (h1 - h0 + np.pi) % (2 * np.pi) - np.pi
    dist = float(np.hypot(goal_r[0] - start[0], goal_r[2] - start[2]))
    n = int(max(2, np.ceil(abs(dturn) / np.radians(step_deg)), np.ceil(dist / step_m)))
    out_r, out_q, stages = [], [], []
    for i in range(1, n + 1):
        t = i / n
        if i == n:
            tr, tq = goal_r.copy(), goal_q.copy()
        else:
            h = h0 + dturn * t
            tr = start + (goal_r - start) * t; tr[1] = start[1]
            tq = ctxq[3].copy(); tq[0] = (R.from_rotvec([0, dturn * t, 0]) * R.from_quat(tq[0])).as_quat()
            side = 'Left' if i % 2 else 'Right'                 # the swing foot, alternating
            Pm, _ = C.fk(sk, tr[None], tq[None]); fwdv = np.array([np.sin(h), 0.0, np.cos(h)])
            tgt = Pm[:, ixp[side + 'Foot']].copy(); tgt[0] += fwdv * 0.12; tgt[0, 1] += 0.08
            tq = C.two_bone(sk, tr[None], tq[None], C.LEG[side], tgt, [0])[0]
        mid_r = np.concatenate([ctxr, tr[None]]); mid_q = np.concatenate([ctxq, tq[None]])
        gr, gq, contacts, nt = mb.inbetween(session, sk, mid_r, mid_q, [0, 1, 2, 3], [4], tokens=list(tokens))
        out_r += list(gr[1:]); out_q += list(gq[1:]); stages.append({'pose': k, 'tokens': nt, 'frames': int(len(gr) - 1), 'approach': True, 'step': i, 'of': n})
        ctxr = np.array(out_r[-4:]); ctxq = np.array(out_q[-4:])
    return out_r, out_q, ctxr, ctxq, stages


def placed(sk, roots, rots, frames, at_root, at_heading):
    """Copies of the given frames turned about Y to at_heading (at the first frame) and moved so the first frame's
    root sits at at_root (x, z); the height is kept."""
    turn = at_heading - heading_of(sk, roots, rots, frames[0]); q = R.from_rotvec([0, turn, 0])
    base = roots[frames[0]].copy(); r_out = []; q_out = []
    for f in frames:
        p = q.apply(roots[f] - base); p[0] += at_root[0]; p[2] += at_root[2]; p[1] += base[1]
        r_out.append(p); rq = rots[f].copy(); rq[0] = (q * R.from_quat(rots[f, 0])).as_quat(); q_out.append(rq)
    return np.array(r_out), np.array(q_out)


def run(job, session):
    sk, roots, rots = load(job['in']); T = len(roots); op = job['op']; tokens = job.get('tokens')
    if op == 'regen':
        a, b = int(job['from']), int(job['to'])
        if a < 4 or b >= T - 1 or b < a:
            raise ValueError(f'regenerate needs 4 frames before the range and 1 after it (range {a + 1}-{b + 1} of {T})')
        ctx = [a - 4, a - 3, a - 2, a - 1]; tgt = [f for f in (b + 1, b + 2, b + 3, b + 4) if f < T]
        gap = b - a + 1
        tok = int(tokens) if tokens else max(6, min(16, int(round((gap + 2 + 6) / 4))))
        gr, gq, contacts, nt = mb.inbetween(session, sk, roots, rots, ctx, tgt, tokens=tok)
        mid_r, mid_q = gr[1:-1], gq[1:-1]
        R_ = np.concatenate([roots[:a], mid_r, roots[b + 1:]]); Q_ = np.concatenate([rots[:a], mid_q, rots[b + 1:]])
        rep = {'op': op, 'from': a, 'to': b, 'replaced': gap, 'generated': int(len(mid_r)), 'tokens': nt, 'frames_before': T, 'frames_after': int(len(R_))}
    elif op == 'step':
        # a range rebuilt as real steps: from the 4 frames before it to the frame after it, one foot lifted mid-step
        # per stage, alternating (a turn the model did by spinning the body on planted feet, a glide). step_deg /
        # step_m size each step; tokens bounds each stage (6 = 18 frames, about a step's length)
        a, b = int(job['from']), int(job['to'])
        if a < 4 or b >= T - 1 or b < a:
            raise ValueError(f'stepping needs 4 frames before the range and 1 after it (range {a + 1}-{b + 1} of {T})')
        ixp = {n: i for i, n in enumerate(sk['names'])}
        ctxr, ctxq = roots[a - 4:a].copy(), rots[a - 4:a].copy()
        sr, sq, _, _, st = stepping_stages(session, sk, ctxr, ctxq, roots[b + 1].copy(), rots[b + 1].copy(), ixp, 0,
                                           step_deg=float(job.get('step_deg', 70)), step_m=float(job.get('step_m', 0.35)),
                                           tokens=job.get('stage_tokens') or (6, 7))
        sr, sq = np.array(sr), np.array(sq)
        R_ = np.concatenate([roots[:a], sr, roots[b + 2:]]); Q_ = np.concatenate([rots[:a], sq, rots[b + 2:]])
        rep = {'op': op, 'from': a, 'to': b, 'replaced': b - a + 1, 'generated': int(len(sr)), 'steps': len(st), 'frames_before': T, 'frames_after': int(len(R_))}
    elif op in ('settle', 'loop'):
        if T < 8:
            raise ValueError('the clip is too short to bridge')
        ctx = [T - 4, T - 3, T - 2, T - 1]; h = heading_of(sk, roots, rots, T - 1)
        first = [0, 1, 2, 3] if op == 'loop' else [0]
        pr, pq = placed(sk, roots, rots, first, roots[T - 1], h)
        ext_r = np.concatenate([roots, pr]); ext_q = np.concatenate([rots, pq])
        tgt = list(range(T, T + len(first)))
        # the model's own length choice is unreliable for a small move (11 tokens of near-stillness to settle a guard
        # stance into itself): a settle gets 0.6-1.0 s, a loop bridge 0.6-1.1 s
        allowed = [int(tokens)] if tokens else list(range(6, 10 if op == 'settle' else 11))
        gr, gq, contacts, nt = mb.inbetween(session, sk, ext_r, ext_q, ctx, tgt, tokens=allowed)
        if op == 'settle':
            add_r, add_q = gr[1:], gq[1:]       # ends in the standing pose
        else:
            add_r, add_q = gr[1:-1], gq[1:-1]   # the clip's own first frame follows on the wrap
        R_ = np.concatenate([roots, add_r]); Q_ = np.concatenate([rots, add_q])
        rep = {'op': op, 'generated': int(len(add_r)), 'tokens': nt, 'frames_before': T, 'frames_after': int(len(R_))}
    elif op == 'sequence':
        # key poses in order, each (root [3], rotations [30][4]); the clip starts standing in the first pose for 4
        # frames (the context), then MotionBricks generates through each pose in turn. Each pose is placed where the
        # body is when it gets there, turned to the heading it has, unless the pose carries its own "place" (dx back
        # along the facing, metres) and "turn" (degrees). A pose may set "tokens" (list) to bound its stage length.
        poses = job['poses']; props = job.get('props') or []
        if len(poses) < 2:
            raise ValueError('a sequence needs at least two poses')
        def snap_to_props(root, rots, hands='near'):
            """A pose whose hips are over a box top is lifted so its lowest body surface rests on that top (a seat, a
            ledge); a pose standing beside the box is left alone. A hand held over a box top and near it (15 cm below
            to 30 cm above: a lean, a vault, a push-off) is put onto the top by arm IK, the hand's turn kept. With
            hands='force' (the pose was asked onto the box by its hands) each hand goes onto the nearest box top
            whatever the distance, pulled inside the top's edges if it hangs past them."""
            root = np.asarray(root, float).copy(); rots = np.asarray(rots, float).copy(); planted = []
            if not props: return root, rots, planted
            import contact as C
            ix = {n: i for i, n in enumerate(sk['names'])}
            P, G = C.fk(sk, root[None], rots[None]); low = C.surface_low(sk, P, G)
            hx, hz = P[0, 0, 0], P[0, 0, 2]
            for b in props:
                if b.get('kind', 'box') != 'box': continue
                c, s_ = np.cos(b.get('yaw', 0.0)), np.sin(b.get('yaw', 0.0)); dx, dz = hx - b['pos'][0], hz - b['pos'][2]
                lx, lz = dx * c + dz * s_, -dx * s_ + dz * c
                if abs(lx) <= b['size'][0] / 2 and abs(lz) <= b['size'][2] / 2:
                    top = b['pos'][1] + b['size'][1]
                    # a low pose (hips under 0.65 m) sits: its hips/thighs go onto the top, the feet hang or reach the
                    # floor; a tall pose stands on it by its feet. (Taking the lowest of all parts put a seated pose's
                    # feet on the top: the body stood crouched on the box instead of sitting.)
                    parts = ('Hips', 'LeftLeg', 'RightLeg') if root[1] < 0.65 else ('LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase')
                    rest = min(low[n][0] for n in parts if n in low)
                    lift = top - rest; root[1] += lift
                    feet_were = {side: min(low[side + 'Foot'][0], low[side + 'ToeBase'][0]) for side in ('Left', 'Right')}
                    P, G = C.fk(sk, root[None], rots[None]); low = C.surface_low(sk, P, G)
                    if parts[0] == 'Hips' and lift > 0.005:
                        # a seat lifted onto a taller box keeps its feet on the floor (leg IK brings each foot that
                        # stood on the floor back down, as far as the leg reaches): lifted with the body they hovered
                        for side in ('Left', 'Right'):
                            if feet_were[side] > C.SOMA_FLOOR + 0.03: continue
                            f = ix[side + 'Foot']; tgt = P[:, f].copy(); tgt[0, 1] -= lift
                            rots = C.two_bone(sk, root[None], rots[None], C.LEG[side], tgt, [0])[0]
                        P, G = C.fk(sk, root[None], rots[None]); low = C.surface_low(sk, P, G)
                    break
            if hands == 'face':
                # a push: each hand goes onto the nearest box's face that the body looks at, 4 cm off it (the palm's
                # thickness), kept inside the face's edges and between 15 cm up and 8 cm under the top; turn kept
                hd = heading_of(sk, root[None], rots[None], 0); fwd = np.array([np.sin(hd), 0.0, np.cos(hd)])
                # the hands at least 32 cm apart across the body, centred where they were: a lean-in push brought
                # them together, the right hand 3 cm into the left forearm, and Clean up's arm push-out then shoved
                # that palm 2 cm into the wall
                left_dir = np.array([np.cos(hd), 0.0, -np.sin(hd)])
                sep = float((P[0, ix['LeftHand']] - P[0, ix['RightHand']]) @ left_dir)
                spread = {'Left': left_dir * max(0.0, 0.32 - sep) / 2, 'Right': -left_dir * max(0.0, 0.32 - sep) / 2}
                for side in ('Left', 'Right'):
                    h = ix[side + 'Hand']; tgt = P[:, h].copy(); tgt[0] += spread[side]
                    bx = min((b for b in props if b.get('kind', 'box') == 'box'), key=lambda b: (b['pos'][0] - tgt[0, 0]) ** 2 + (b['pos'][2] - tgt[0, 2]) ** 2)
                    c, s_ = np.cos(bx.get('yaw', 0.0)), np.sin(bx.get('yaw', 0.0)); dx, dz = tgt[0, 0] - bx['pos'][0], tgt[0, 2] - bx['pos'][2]
                    lx, lz = dx * c + dz * s_, -dx * s_ + dz * c; flx, flz = fwd[0] * c + fwd[2] * s_, -fwd[0] * s_ + fwd[2] * c
                    hx, hz = bx['size'][0] / 2, bx['size'][2] / 2
                    # palm flat on the face: in the hand bone's frame the fingers run along x (+x left hand, -x
                    # right) and the palm faces -y (the thumb's side). The turn: palm into the face, fingers up; the
                    # wrist 2.5 cm off the face so the palm touches (kept, the pose's own turn touched with the
                    # fingertips, palms down: it read as reaching, not pushing)
                    if abs(flz) >= abs(flx):
                        lz = -np.sign(flz) * (hz + 0.012); lx = float(np.clip(lx, -hx + 0.05, hx - 0.05)); nl = np.array([0.0, np.sign(flz)])
                    else:
                        lx = -np.sign(flx) * (hx + 0.012); lz = float(np.clip(lz, -hz + 0.05, hz - 0.05)); nl = np.array([np.sign(flx), 0.0])
                    tgt[0, 0] = bx['pos'][0] + lx * c - lz * s_; tgt[0, 2] = bx['pos'][2] + lx * s_ + lz * c
                    into = np.array([nl[0] * c - nl[1] * s_, 0.0, nl[0] * s_ + nl[1] * c])          # the face's inward normal, world
                    fingers = np.array([0.0, 1.0, 0.0]); xw = fingers if side == 'Left' else -fingers
                    yw = -into; zw = np.cross(xw, yw)
                    hand_q = R.from_matrix(np.stack([xw, yw, zw], axis=1)).as_quat()
                    # the wrist sits 7 cm under the palm's centre with the fingers up: aim the palm at the pose's hand height
                    tgt[0, 1] = float(np.clip(tgt[0, 1] - 0.07, bx['pos'][1] + 0.15, bx['pos'][1] + bx['size'][1] - 0.15))
                    rots = C.two_bone(sk, root[None], rots[None], C.ARM[side], tgt, [0], end_global=hand_q[None])[0]
                    # then the palm exactly on the face: how far the hand's surface reaches past the face plane, backed
                    # out by that + 2 mm (a fixed wrist offset left one palm 1.1 cm inside a wall at a leaning angle)
                    half = hz if abs(flz) >= abs(flx) else hx
                    face_pt = np.array([bx['pos'][0], 0.0, bx['pos'][2]]) - into * half
                    for _ in range(2):
                        P, G = C.fk(sk, root[None], rots[None])
                        W = P[0, h] + G[h][0].apply(C.proxy()[side + 'Hand'])
                        pen = float(np.max((W - face_pt) @ into))
                        if abs(pen + 0.002) < 0.001: break
                        tgt = P[:, h].copy(); tgt[0] -= into * (pen + 0.002)
                        rots = C.two_bone(sk, root[None], rots[None], C.ARM[side], tgt, [0], end_global=hand_q[None])[0]
                    P, G = C.fk(sk, root[None], rots[None]); low = C.surface_low(sk, P, G); planted.append((side, None))
                return root, rots, planted
            for side in ('Left', 'Right'):
                h = ix[side + 'Hand']; tgt = P[:, h].copy()
                sup = float(C.support_at(props, C.SOMA_FLOOR, P[:, h][:, [0, 2]], margin=0.03)[0])
                if hands == 'force':
                    bx = min((b for b in props if b.get('kind', 'box') != 'none'), key=lambda b: (b['pos'][0] - tgt[0, 0]) ** 2 + (b['pos'][2] - tgt[0, 2]) ** 2)
                    c, s_ = np.cos(bx.get('yaw', 0.0)), np.sin(bx.get('yaw', 0.0)); dx, dz = tgt[0, 0] - bx['pos'][0], tgt[0, 2] - bx['pos'][2]
                    lx, lz = dx * c + dz * s_, -dx * s_ + dz * c
                    lx = float(np.clip(lx, -bx['size'][0] / 2 + 0.02, bx['size'][0] / 2 - 0.02)); lz = float(np.clip(lz, -bx['size'][2] / 2 + 0.02, bx['size'][2] / 2 - 0.02))
                    tgt[0, 0] = bx['pos'][0] + lx * c - lz * s_; tgt[0, 2] = bx['pos'][2] + lx * s_ + lz * c
                    sup = bx['pos'][1] + bx['size'][1]
                elif sup <= C.SOMA_FLOOR + 1e-6: continue
                d = sup - float(low[side + 'Hand'][0])
                if hands == 'force' or -0.15 <= d <= 0.30:
                    tgt[0, 1] += d + 0.005
                    rots = C.two_bone(sk, root[None], rots[None], C.ARM[side], tgt, [0])[0]
                    P, G = C.fk(sk, root[None], rots[None]); low = C.surface_low(sk, P, G); planted.append((side, sup))
            return root, rots, planted

        def out_of_boxes(p, margin, below):
            """p moved horizontally out of any box footprint (grown by margin) it is inside, if it is lower than `below`
            (that box's top + a little): by the shortest way out."""
            p = np.asarray(p, float).copy()
            for b in props:
                if b.get('kind', 'box') != 'box' or p[1] >= min(below, b['pos'][1] + b['size'][1] + 0.06): continue
                c, s_ = np.cos(b.get('yaw', 0.0)), np.sin(b.get('yaw', 0.0)); dx, dz = p[0] - b['pos'][0], p[2] - b['pos'][2]
                lx, lz = dx * c + dz * s_, -dx * s_ + dz * c; hx, hz = b['size'][0] / 2 + margin, b['size'][2] / 2 + margin
                if abs(lx) >= hx or abs(lz) >= hz: continue
                if hx - abs(lx) < hz - abs(lz): lx = np.sign(lx or 1) * hx
                else: lz = np.sign(lz or 1) * hz
                p[0] = b['pos'][0] + lx * c - lz * s_; p[2] = b['pos'][2] + lx * s_ + lz * c
            return p

        def hands_out_of_boxes(roots, rots, held=(), sigma=1.5):
            """No hand surface (fingers included) inside a box on any frame: per frame the smallest way out of each
            box a hand is in (up over the top, or out through the nearest side), spread over neighbouring frames
            (max filter, then gaussian, so a correction is never cut short) and applied by arm IK. Frames in `held`
            (hand, frame) are left alone: the hand is placed there on purpose."""
            import contact as C
            from scipy.ndimage import maximum_filter1d, minimum_filter1d, gaussian_filter1d
            ix = {n: i for i, n in enumerate(sk['names'])}; T = len(roots); out = np.asarray(rots, float).copy()
            pts = C.proxy()
            for side in ('Left', 'Right'):
                h = ix[side + 'Hand']; P, G = C.fk(sk, roots, out); M = G[h].as_matrix()
                W = P[:, h][:, None, :] + np.einsum('tij,nj->tni', M, pts[side + 'Hand'])   # [T, n, 3]
                D = np.zeros((T, 3))
                for b in props:
                    if b.get('kind', 'box') != 'box': continue
                    c, s_ = np.cos(b.get('yaw', 0.0)), np.sin(b.get('yaw', 0.0)); top = b['pos'][1] + b['size'][1]
                    dx, dz = W[..., 0] - b['pos'][0], W[..., 2] - b['pos'][2]
                    lx, lz = dx * c + dz * s_, -dx * s_ + dz * c; hx, hz = b['size'][0] / 2, b['size'][2] / 2
                    inside = (np.abs(lx) < hx) & (np.abs(lz) < hz) & (W[..., 1] < top) & (W[..., 1] > b['pos'][1])
                    for t in np.where(inside.any(axis=1))[0]:
                        if any(hs == side and hf == t for hs, hf in held): continue
                        m = inside[t]
                        up = float(np.max(top + 0.005 - W[t, m, 1]))
                        ox = float(np.max(hx + 0.005 - np.abs(lx[t, m]))); oz = float(np.max(hz + 0.005 - np.abs(lz[t, m])))
                        sx = np.sign(np.mean(lx[t, m]) or 1); sz = np.sign(np.mean(lz[t, m]) or 1)
                        if up <= min(ox, oz): d = np.array([0.0, up, 0.0])
                        elif ox < oz: d = np.array([sx * ox * c, 0.0, sx * ox * s_])
                        else: d = np.array([-sz * oz * s_, 0.0, sz * oz * c])
                        D[t] = np.where(np.abs(d) > np.abs(D[t]), d, D[t])
                if not D.any(): continue
                for k in range(3):
                    hi = maximum_filter1d(np.maximum(D[:, k], 0), 5); lo = minimum_filter1d(np.minimum(D[:, k], 0), 5)
                    D[:, k] = gaussian_filter1d(hi, sigma) + gaussian_filter1d(lo, sigma)
                fr = np.where(np.linalg.norm(D, axis=1) > 1e-4)[0]
                tq = np.array([G[h][k].as_quat() for k in range(T)])
                out = C.two_bone(sk, roots, out, C.ARM[side], P[:, h] + D, list(fr), end_global=tq)
                hands_moved.append({'hand': side, 'frames': int(len(fr)), 'max_cm': round(float(np.linalg.norm(D, axis=1).max()) * 100, 1)})
            return out

        def plant_hands(roots, rots, anchors, near=0.10, ease=3):
            """A hand the author put on a box top (anchors: frame, side, top) stays there: on the frames around the
            pose where the generated hand is still near the top (within `near`, or inside the box) and over the
            footprint, the hand is held at the pose's place and turn by arm IK, eased off over `ease` frames as it
            lifts. MotionBricks does not know the box: left alone it pushed a crouch's hands 16 cm into it."""
            import contact as C
            ix = {n: i for i, n in enumerate(sk['names'])}; T = len(roots); out = np.asarray(rots, float).copy()
            for f0, side, top in anchors:
                h = ix[side + 'Hand']; P, G = C.fk(sk, roots, out); low = C.surface_low(sk, P, G)[side + 'Hand']
                sup = C.support_at(props, C.SOMA_FLOOR, P[:, h][:, [0, 2]], margin=0.05)
                # the hold only covers frames where the arm can reach the held place: while the body is still upright
                # on the way in, a table top 0.6 m ahead is out of reach and the hand stopped short inside the box
                sh = ix[C.ARM[side][0]]; offs = np.array(sk['offsets'], float)
                arm = np.linalg.norm(offs[ix[C.ARM[side][1]]]) + np.linalg.norm(offs[h])
                reach_ok = lambda k, p: np.linalg.norm(p - P[k, sh]) <= 0.92 * arm   # the IK softens from 0.97: 0.97 left hands 3 cm short, in the table edge
                if top is None:   # against a face: held while the generated hand is near the placed one
                    stay = (np.linalg.norm(P[:, h] - P[f0, h], axis=1) <= near) & np.array([reach_ok(k, P[f0, h]) for k in range(T)])
                else:
                    stay = (low - top <= near) & (sup >= top - 1e-6) & np.array([reach_ok(k, P[f0, h]) for k in range(T)])
                a = f0
                while a > 0 and stay[a - 1]: a -= 1
                b = f0
                while b < T - 1 and stay[b + 1]: b += 1
                if b - a < 1: continue
                goal = np.tile(P[f0, h], (T, 1))
                # the hold, then a speed-limited release either side: from the held place the hand chases where the
                # generator had it at no more than `step_m` a frame until it has caught up (a fixed ramp let a hand
                # that the generator swung away fast jump 9 cm in a frame)
                step_m, step_deg = 0.06, 8.0
                q0 = G[h][f0]
                tgt = P[:, h].copy(); w = np.zeros(T); w[a:b + 1] = 1.0; tgt[a:b + 1] = goal[0]
                tq = np.array([G[h][k].as_quat() for k in range(T)]); tq[a:b + 1] = q0.as_quat()

                def keep_out(k, p, release=False):
                    # while still over a box top the hand stays above it at the hold's own joint height (the generator swings a
                    # rising body's hand down the box's front face; the margin covers the fingers); out of reach over the top it
                    # waits in front of the box (on the way in) and comes up over the edge once the body leans in, or (on
                    # the way out) slides back along the top towards the shoulder until the arm reaches (pushed sideways
                    # out of the footprint instead, a released hand jumped 27 cm in a frame)
                    p = p.copy()
                    if top is None: return p
                    sup = float(C.support_at(props, C.SOMA_FLOOR, p[None, [0, 2]], margin=0.22)[0])
                    if sup > C.SOMA_FLOOR + 1e-6: p[1] = max(p[1], goal[0][1] if abs(sup - top) < 1e-6 else sup + 0.08)
                    if not reach_ok(k, p):
                        if not release: return out_of_boxes(p, 0.14, top + 0.06)
                        sh_xz = P[k, sh][[0, 2]]
                        for _ in range(60):
                            if reach_ok(k, p): break
                            d = sh_xz - p[[0, 2]]; n = np.linalg.norm(d)
                            if n < 1e-3: break
                            p[[0, 2]] += d / n * min(0.01, n)
                    return p

                # The hand-over between the hold and the generated motion, each side: an ease-in-out blend (smoothstep) from the
                # held place and turn into the generated ones over N frames, N the fewest that keep every frame's move under
                # step_m and every turn under step_deg (and at least 4): the hand leaves and arrives at the generated motion's own
                # speed, so it neither stops dead at the contact (a 4.6 cm shake) nor lags and then jumps to catch up (4.1 cm).
                for end, step in ((a, -1), (b, 1)):
                    best = None
                    for N in range(4, 61):
                        ks = [end + step * i for i in range(1, N + 1) if 0 <= end + step * i < T]
                        if not ks: break
                        path, turns, prev, pq, ok = [], [], goal[0].copy(), q0, True
                        for i, k in enumerate(ks, 1):
                            x = i / (N + 1); sm = x * x * (3 - 2 * x)
                            p = keep_out(k, goal[0] + (P[k, h] - goal[0]) * sm, release=step > 0)
                            # and never more than step_m from the frame before (the keep-out rules correct each frame on
                            # its own: a hand waiting in front of the table jumped 24 cm onto it in one frame)
                            dp = p - prev; nd = np.linalg.norm(dp)
                            if nd > step_m: p = prev + dp / nd * step_m; ok = False
                            qk = R.from_quat([q0.as_quat(), G[h][k].as_quat()]).mean(weights=[1 - sm, sm])
                            if np.degrees((pq.inv() * qk).magnitude()) > step_deg: ok = False
                            path.append(p); turns.append(qk); prev, pq = p, qk
                        # the last frame must hand over cleanly to the generated motion that follows, and that motion
                        # must be clear of the box (handing over to a hand still under the table's edge jumped 27 cm)
                        kn = (ks[-1] + step) if 0 <= ks[-1] + step < T else None
                        if kn is not None and (np.linalg.norm(P[kn, h] - prev) > step_m or np.linalg.norm(keep_out(kn, P[kn, h], release=step > 0) - P[kn, h]) > 1e-4): ok = False
                        best = (ks, path, turns)
                        if ok: break
                    if best:
                        for k, p, qk in zip(*best): tgt[k] = p; tq[k] = qk.as_quat(); w[k] = 1.0
                # the correction (where the hand goes minus where the generator had it) smoothed over time, the hold
                # kept exact: no stop, jump or catch-up survives whatever the rules above did frame by frame (each
                # rule fixed one and caused the next: 4.6, 4.1, 27, 24, 5.8 cm)
                from scipy.ndimage import gaussian_filter1d
                D = np.where((w > 0)[:, None], tgt - P[:, h], 0.0)
                D = gaussian_filter1d(D, 2.0, axis=0, mode='nearest')
                D[a:b + 1] = goal[a:b + 1] - P[a:b + 1, h]
                tgt = P[:, h] + D
                w = np.maximum(w, (np.linalg.norm(D, axis=1) > 1e-3).astype(float))
                out = C.two_bone(sk, roots, out, C.ARM[side], tgt, list(np.where(w > 0)[0]), end_global=tq)
                planted_ranges.append({'hand': side, 'from': int(a), 'to': int(b)})
            return out
        pr, pq, pl = snap_to_props(np.array(poses[0]['root'], float), np.array(poses[0]['rotations'], float))
        out_r = [pr.copy() for _ in range(4)]; out_q = [pq.copy() for _ in range(4)]
        hold0 = int(round(float(poses[0].get('hold') or 0) * 30))
        out_r += [pr.copy() for _ in range(hold0)]; out_q += [pq.copy() for _ in range(hold0)]
        stages = []; anchors = [(3, side, top) for side, top in pl]; planted_ranges = []
        for k, pose in enumerate(poses[1:], 1):
            ctxr = np.array(out_r[-4:]); ctxq = np.array(out_q[-4:])
            tr = np.array(pose['root'], float); tq = np.array(pose['rotations'], float)
            if not pose.get('absolute'):
                # relative placement: the pose's own heading is swapped for the current heading (+turn), its root put
                # at the current root (+place back along the facing), its height kept
                cur_h = heading_of(sk, ctxr, ctxq, 3); own_h = heading_of(sk, tr[None], tq[None], 0)
                turn = cur_h + np.radians(pose.get('turn', 0.0)) - own_h; rq = R.from_rotvec([0, turn, 0])
                fwd = np.array([np.sin(cur_h), 0, np.cos(cur_h)])
                tr = np.array([ctxr[3][0], tr[1], ctxr[3][2]]) - fwd * float(pose.get('place', 0.0))
                tq = tq.copy(); tq[0] = (rq * R.from_quat(tq[0])).as_quat()
            boxes = [b for b in props if b.get('kind', 'box') == 'box'] if props else []
            if boxes:
                import contact as C
                ixp = {n: i for i, n in enumerate(sk['names'])}
                def over_box(root):
                    return float(C.support_at(boxes, C.SOMA_FLOOR, np.asarray(root, float)[None, [0, 2]])[0]) > C.SOMA_FLOOR + 1e-6
                onto = pose.get('onto')
                if onto in ('sit', 'hands', 'stand', 'push'):
                    # the pose goes onto the nearest box: "sit"/"stand" put the hips over its top centre, "hands" the
                    # hands' midpoint (the box ahead of the body). A seat faces back the way the body came (sit down
                    # onto a box that was ahead: walk up, turn, sit); "stand" and "hands" keep the heading set above.
                    Pp, _ = C.fk(sk, tr[None], tq[None])
                    anchor = Pp[0, 0] if onto not in ('hands', 'push') else (Pp[0, ixp['LeftHand']] + Pp[0, ixp['RightHand']]) / 2
                    b = min(boxes, key=lambda b: (b['pos'][0] - anchor[0]) ** 2 + (b['pos'][2] - anchor[2]) ** 2)
                    goal = np.array([b['pos'][0], 0.0, b['pos'][2]])
                    if onto == 'sit' and not pose.get('absolute'):
                        away = np.array([ctxr[3][0] - b['pos'][0], 0.0, ctxr[3][2] - b['pos'][2]])
                        if np.linalg.norm(away) > 0.15:
                            want = float(np.arctan2(away[0], away[2])); own = heading_of(sk, tr[None], tq[None], 0)
                            tq = tq.copy(); tq[0] = (R.from_rotvec([0, want - own, 0]) * R.from_quat(tq[0])).as_quat()
                            Pp, _ = C.fk(sk, tr[None], tq[None]); anchor = Pp[0, 0]
                        # the hips sit 12 cm in from the box's front face (the face the body looks away from), so the
                        # shins and feet hang in front of a solid box rather than inside it (hips at the centre put the
                        # feet under the top: `floor` 43 cm at the left foot)
                        h = heading_of(sk, tr[None], tq[None], 0); fwd = np.array([np.sin(h), 0.0, np.cos(h)])
                        c, s_ = np.cos(b.get('yaw', 0.0)), np.sin(b.get('yaw', 0.0))
                        lx, lz = fwd[0] * c + fwd[2] * s_, -fwd[0] * s_ + fwd[2] * c          # facing in the box's frame
                        extent = abs(lx) * b['size'][0] / 2 + abs(lz) * b['size'][2] / 2          # half-depth along the facing
                        goal = goal + fwd * max(0.0, extent - 0.12)
                    elif onto == 'hands':
                        # the hands rest 12 cm in from the near edge (the face the body looks at), where a person
                        # leaning on a box puts them; at the top's centre the knees met the box's front face. The
                        # body stands at least 35 cm behind that point and reaches (a standing pose's hands hang 8 cm
                        # ahead of the hips: placed by its hands it stood inside the table, feet 73 cm under the top)
                        h = heading_of(sk, tr[None], tq[None], 0); fwd = np.array([np.sin(h), 0.0, np.cos(h)])
                        c, s_ = np.cos(b.get('yaw', 0.0)), np.sin(b.get('yaw', 0.0))
                        lx, lz = fwd[0] * c + fwd[2] * s_, -fwd[0] * s_ + fwd[2] * c
                        extent = abs(lx) * b['size'][0] / 2 + abs(lz) * b['size'][2] / 2
                        goal = goal - fwd * max(0.0, extent - 0.12)
                        reach = float(np.dot(anchor - Pp[0, 0], fwd))
                        if reach < 0.35: anchor = anchor + fwd * (0.35 - reach)
                    elif onto == 'push':
                        # the hands meet the box's near face (4 cm off it): the body stands at the pose's own reach
                        h = heading_of(sk, tr[None], tq[None], 0); fwd = np.array([np.sin(h), 0.0, np.cos(h)])
                        c, s_ = np.cos(b.get('yaw', 0.0)), np.sin(b.get('yaw', 0.0))
                        lx, lz = fwd[0] * c + fwd[2] * s_, -fwd[0] * s_ + fwd[2] * c
                        extent = abs(lx) * b['size'][0] / 2 + abs(lz) * b['size'][2] / 2
                        goal = goal - fwd * (extent + 0.01)   # the arms reach the face (at 4 cm the palms stopped 2 cm short)
                    tr = tr + np.array([goal[0] - anchor[0], 0.0, goal[2] - anchor[2]])
                    if onto in ('push', 'hands'):
                        # nothing but the arms in the box: placed by its hands, a leaning pose put its head 2.8 cm into
                        # the wall. The body steps back along its facing by the deepest trunk/head/leg surface (the
                        # arms then reach that much further when the hands are snapped onto the box)
                        h = heading_of(sk, tr[None], tq[None], 0); fwd = np.array([np.sin(h), 0.0, np.cos(h)])
                        Pb, Gb = C.fk(sk, tr[None], tq[None]); deepest = 0.0
                        for bone, loc in C.proxy().items():
                            if any(k in bone for k in ('Arm', 'Hand')): continue
                            jb = ixp[bone]; W = Pb[0, jb] + Gb[jb][0].apply(loc)
                            for bb in boxes:
                                c, s_ = np.cos(bb.get('yaw', 0.0)), np.sin(bb.get('yaw', 0.0)); dx, dz = W[:, 0] - bb['pos'][0], W[:, 2] - bb['pos'][2]
                                lx, lz = dx * c + dz * s_, -dx * s_ + dz * c
                                inside = (np.abs(lx) < bb['size'][0] / 2) & (np.abs(lz) < bb['size'][2] / 2) & (W[:, 1] > bb['pos'][1]) & (W[:, 1] < bb['pos'][1] + bb['size'][1])
                                if inside.any():
                                    # how far each inside point is past the box's near face, along the facing (the
                                    # body faces into the box: the near face is the one on the far side of the facing)
                                    flx, flz = fwd[0] * c + fwd[2] * s_, -fwd[0] * s_ + fwd[2] * c
                                    past = (np.sign(flz) * lz + bb['size'][2] / 2) if abs(flz) >= abs(flx) else (np.sign(flx) * lx + bb['size'][0] / 2)
                                    deepest = max(deepest, float(np.max(np.where(inside, past, 0.0))))
                        if deepest > 0: tr = tr - fwd * (deepest + 0.01)
                    if onto != 'stand':
                        # and the feet never land inside a box: the pose backs away along its facing until they clear
                        h = heading_of(sk, tr[None], tq[None], 0); fwd = np.array([np.sin(h), 0.0, np.cos(h)])
                        for _ in range(40):
                            Pf, _ = C.fk(sk, tr[None], tq[None])
                            if not (over_box(Pf[0, ixp['LeftFoot']]) or over_box(Pf[0, ixp['RightFoot']]) or over_box(Pf[0, ixp['LeftToeBase']]) or over_box(Pf[0, ixp['RightToeBase']])): break
                            tr = tr - fwd * 0.05
                elif not pose.get('absolute') and over_box(tr) and tr[1] > 0.6:
                    # a pose nobody asked to put on a box is not stood on one: it slides forward along its own facing
                    # until the hips are clear of the footprint (standing up from a seat lands in front of it)
                    h = heading_of(sk, tr[None], tq[None], 0); fwd = np.array([np.sin(h), 0.0, np.cos(h)])
                    for _ in range(40):
                        tr = tr + fwd * 0.05
                        if not over_box(tr): tr = tr + fwd * 0.15; break
            approached = False
            tr, tq, pl = snap_to_props(tr, tq, hands=('force' if pose.get('onto') == 'hands' else 'face' if pose.get('onto') == 'push' else 'near') if boxes else 'near')
            if pose.get('onto') == 'sit' and boxes and not pose.get('absolute'):
                # a seat that needs a big turn gets a stage of its own first: the body walks to the spot in front of the
                # seat, already turned, in the pose it is in, and only then sits. Asked to turn 180° and sit in one
                # stage the model once hopped round in the air (feet 25 cm up, 4 frames for the whole turn).
                cur_h = heading_of(sk, ctxr, ctxq, 3); seat_h = heading_of(sk, tr[None], tq[None], 0)
                dturn = (seat_h - cur_h + np.pi) % (2 * np.pi) - np.pi
                if abs(dturn) > np.radians(60):
                    fwd = np.array([np.sin(seat_h), 0.0, np.cos(seat_h)])
                    # the spot is clear of the box: 30 cm out from the seated hips, then further until no foot is over
                    # the box (12 cm out put it on the box's front face and the heel went into the box on the turn)
                    mr = np.array([tr[0], ctxr[3][1], tr[2]]) + fwd * 0.30; mq = ctxq[3].copy()
                    mq[0] = (R.from_rotvec([0, dturn, 0]) * R.from_quat(mq[0])).as_quat()
                    for _ in range(20):
                        Pm, _ = C.fk(sk, mr[None], mq[None])
                        if not any(over_box(Pm[0, ixp[n]]) for n in ('LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase')): break
                        mr = mr + fwd * 0.05
                    sr, sq, ctxr, ctxq, st = stepping_stages(session, sk, ctxr, ctxq, mr, mq, ixp, k)
                    out_r += sr; out_q += sq; stages += st
                    approached = True
            if not approached and not pose.get('absolute') and ctxr[3][1] > 0.7:
                # standing, with the next pose far away or facing elsewhere: walk there with steps, as a seat does.
                # (One stage made the body glide 35-50 cm on planted feet: walking up to a box, stepping back from a
                # wall, leaving a table.) The spot is where the pose's hips are, 20 cm short along the facing when the
                # pose itself is low (a crouch, a lean) so the last stage can settle into it.
                ixs = {n: i for i, n in enumerate(sk['names'])}
                h0 = heading_of(sk, ctxr, ctxq, 3); h1 = heading_of(sk, tr[None], tq[None], 0)
                dturn = (h1 - h0 + np.pi) % (2 * np.pi) - np.pi
                dist = float(np.hypot(tr[0] - ctxr[3][0], tr[2] - ctxr[3][2]))
                if dist > 0.30 or abs(dturn) > np.radians(60):
                    fwd1 = np.array([np.sin(h1), 0.0, np.cos(h1)])
                    mr = np.array([tr[0], ctxr[3][1], tr[2]]) - (fwd1 * 0.20 if tr[1] < 0.8 else 0.0)
                    mq = ctxq[3].copy(); mq[0] = (R.from_rotvec([0, dturn, 0]) * R.from_quat(mq[0])).as_quat()
                    sr, sq, ctxr, ctxq, st = stepping_stages(session, sk, ctxr, ctxq, mr, mq, ixs, k)
                    out_r += sr; out_q += sq; stages += st
            place_stage = False
            if pose.get('onto') in ('hands', 'push') and pl and not pose.get('absolute'):
                # reach over, then place: a key pose first with the same body and the planted hands 10 cm above their
                # spot, then a short stage that sets them down. Straight to the placed pose, the generator moved the
                # hands up through the table's front face and they had to jump the last 25 cm onto the top.
                hq = tq.copy(); Ph, _ = C.fk(sk, tr[None], hq[None]); ixh = {n: i for i, n in enumerate(sk['names'])}
                hd = heading_of(sk, tr[None], tq[None], 0); back = -np.array([np.sin(hd), 0.0, np.cos(hd)])
                for side, _top in pl:
                    tgt = Ph[:, ixh[side + 'Hand']].copy()
                    if _top is None: tgt[0] += back * 0.10     # a push: 10 cm off the face, then onto it
                    else: tgt[0, 1] += 0.10
                    hq = C.two_bone(sk, tr[None], hq[None], C.ARM[side], tgt, [0])[0]
                mid_r = np.concatenate([ctxr, tr[None]]); mid_q = np.concatenate([ctxq, hq[None]])
                gr, gq, contacts, nt = mb.inbetween(session, sk, mid_r, mid_q, [0, 1, 2, 3], [4], tokens=[int(t) for t in (pose.get('tokens') or range(6, 13))])
                out_r += list(gr[1:]); out_q += list(gq[1:]); stages.append({'pose': k, 'tokens': nt, 'frames': int(len(gr) - 1), 'reach': True})
                ctxr = np.array(out_r[-4:]); ctxq = np.array(out_q[-4:]); place_stage = True
            clip_r = np.concatenate([ctxr, tr[None]]); clip_q = np.concatenate([ctxq, tq[None]])
            allowed = [6] if place_stage else (pose.get('tokens') or list(range(6, 13)))
            gr, gq, contacts, nt = mb.inbetween(session, sk, clip_r, clip_q, [0, 1, 2, 3], [4], tokens=[int(t) for t in allowed])
            out_r += list(gr[1:]); out_q += list(gq[1:]); stages.append({'pose': k, 'tokens': nt, 'frames': int(len(gr) - 1)})
            anchors += [(len(out_r) - 1, side, top) for side, top in pl]
            # a pose with a hold stays as reached for that long (still frames; the next stage starts from them)
            hold = int(round(float(pose.get('hold') or 0) * 30))
            if hold: out_r += [out_r[-1].copy() for _ in range(hold)]; out_q += [out_q[-1].copy() for _ in range(hold)]; stages[-1]['hold'] = hold
        # the clip ends at rest in its last pose (held 4 frames, like the start), not mid-motion into it
        out_r += [out_r[-1].copy() for _ in range(4)]; out_q += [out_q[-1].copy() for _ in range(4)]
        R_ = np.array(out_r); Q_ = np.array(out_q)
        if anchors: Q_ = plant_hands(R_, Q_, anchors)
        hands_moved = []
        if props:
            held = [(r['hand'], f) for r in planted_ranges for f in range(r['from'], r['to'] + 1)]
            Q_ = hands_out_of_boxes(R_, Q_, held); Q_ = hands_out_of_boxes(R_, Q_, held)   # twice: IK falls short near full reach
        rep = {'op': op, 'stages': stages, 'frames_after': int(len(R_)), 'hands_planted': planted_ranges, 'hands_out_of_boxes': hands_moved}
    else:
        raise ValueError('op must be regen, settle, loop or sequence')
    save(job['out'], R_, Q_, rep)
    return rep


def main():
    if '--serve' in sys.argv:
        session = mb.Session()
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                run(json.loads(line), session); print('OK', flush=True)
            except Exception as e:
                print('ERR ' + str(e).replace('\n', ' '), flush=True)
        return
    job = json.loads(sys.argv[1]); print(json.dumps(run(job, mb.Session())))


if __name__ == '__main__':
    main()
