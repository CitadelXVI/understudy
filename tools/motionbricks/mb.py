"""MotionBricks SOMA in-betweening on Understudy clips, with ONNX Runtime (CPU, ~30 ms a generation).

A numpy port of NVIDIA's warp kernels (motionbricks/model/soma/kernels.py): four context poses and one to four
target poses go in, 18-58 frames of motion come out that start at the last context pose and end at the first
target pose. Kimodo's SOMA clips use the same 30 joints in the same order, so a clip's streams go straight in.
Model space: Y up, metres, floor at 0 (Understudy's floor is y = FLOOR; it is taken out and put back)."""
import json, os
import numpy as np
from scipy.spatial.transform import Rotation as R

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# NVIDIA's MotionBricks checkout (with its ONNX assets): $MOTIONBRICKS, else ./motionbricks in this repo.
MB_ROOT = os.environ.get('MOTIONBRICKS', os.path.join(REPO, 'motionbricks'))
ONNX = os.path.join(MB_ROOT, 'motionbricks', 'assets', 'onnx', 'soma', 'mmm_v6_soma_fp32.onnx')
FLOOR = 0.02
J = 30
POS0, ROT0 = 0, 87          # local_poses layout: 29 child positions, then 30 6D rotations
OUT_POS, OUT_ROT = 5, 92     # pred_global_motions layout: root 5, positions 87, rotations 180, velocities 90, contacts 4
BOUNDARY = 3
# MotionBricks' SOMA joint frames carry a rest rotation (each bone runs along its joint's local X; the USD bind pose
# shows it); Kimodo's export uses identity rest rotations with offsets along the bone. Same joints, same bind pose,
# so one constant per joint converts: R_mb = R_ours * C.
_BIND = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'soma_mb_bind.json')))['bind']


def fk(sk, roots, rots):
    par, off = sk['parents'], np.array(sk['offsets'], float)
    T = len(roots); P = np.zeros((T, J, 3)); G = [None] * J
    for j in range(J):
        q = R.from_quat(rots[:, j])
        if par[j] < 0:
            G[j] = q; P[:, j] = roots
        else:
            G[j] = G[par[j]] * q; P[:, j] = P[:, par[j]] + G[par[j]].apply(off[j])
    return P, G


def heading(right_hip, left_hip):
    across = np.array([right_hip[0] - left_hip[0], 0.0, right_hip[2] - left_hip[2]])
    n = np.linalg.norm(across)
    if n <= 1e-6:
        return 0.0
    across /= n; fwd = np.cross([0, 1, 0], across)
    return float(np.arctan2(fwd[0], fwd[2]))


def rot6d(q):   # world rotation -> first two columns of its matrix
    m = q.as_matrix(); return np.concatenate([m[:, 0], m[:, 1]])


def from6d(v):
    x = v[:3] / np.linalg.norm(v[:3]); z = np.cross(x, v[3:]); z /= np.linalg.norm(z); y = np.cross(z, x)
    return R.from_matrix(np.stack([x, y, z], 1))


class Session:
    def __init__(self):
        import onnxruntime as ort
        so = ort.SessionOptions(); so.log_severity_level = 3
        self.s = ort.InferenceSession(ONNX, so, providers=['CPUExecutionProvider'])

    def run(self, x):
        return self.s.run(None, x)


def encode(sk, P, G, ctx, tgt, desired=(1.0, 0.0)):
    """P, G: world positions/rotations per frame of the clip (floor already at 0). ctx: 4 frame indices;
    tgt: 1-4 frame indices. Returns (inputs, alignment (p, q))."""
    ix = {n: i for i, n in enumerate(sk['names'])}; rl, ll = ix['RightLeg'], ix['LeftLeg']
    C = [R.from_quat(_BIND[n]) for n in sk['names']]
    frames = list(ctx) + list(tgt) + [tgt[-1]] * (4 - len(tgt))
    last = ctx[-1]; hips = P[last, 0]
    cur = heading(P[last, rl], P[last, ll]); des = float(np.arctan2(desired[0], desired[1]))
    Ap = np.array([hips[0], 0.0, hips[2]]); Aq = R.from_rotvec([0, cur - des, 0])
    ap = lambda p: Aq.inv().apply(p - Ap)
    gr = np.zeros((1, 8, 5), np.float32); lr = np.zeros((1, 8, 4), np.float32); lp = np.zeros((1, 8, 267), np.float32)
    for i, f in enumerate(frames):
        nxt = f if i == 3 else frames[min(i + 1, 7)]
        h, hn = ap(P[f, 0]), ap(P[nxt, 0])
        ch = heading(ap(P[f, rl]), ap(P[f, ll])); nh = heading(ap(P[nxt, rl]), ap(P[nxt, ll]))
        d = np.arctan2(np.sin(nh - ch), np.cos(nh - ch))
        gr[0, i] = [h[0], h[1], h[2], np.cos(ch), np.sin(ch)]
        lr[0, i] = [d * 30, (hn[0] - h[0]) * 30, (hn[2] - h[2]) * 30, h[1]]
        rootp = np.array([h[0], 0, h[2]])
        for j in range(J):
            if j > 0:
                lp[0, i, POS0 + (j - 1) * 3: POS0 + j * 3] = ap(P[f, j]) - rootp
            lp[0, i, ROT0 + j * 6: ROT0 + j * 6 + 6] = rot6d(Aq.inv() * G[j][f] * C[j])
    nt = len(tgt); given = np.array([1] * (4 + nt) + [0] * (4 - nt), np.int32)
    hl = given.copy(); hl[3] = 0; hl[4 + nt - 1] = 0
    x = {'global_root_values': gr, 'has_global_root_values': given[None], 'local_root_values': lr, 'has_local_root_values': hl[None],
         'local_poses': lp, 'has_local_poses': given[None], 'allowed_pred_num_tokens': np.zeros((1, 11), np.int32)}
    return x, (Ap, Aq)


def decode(sk, out, tokens, align):
    """pred_global_motions [1,64,366] -> (roots [N,3], local rots xyzw [N,30,4], contacts [N,4]) in clip space, floor 0."""
    Ap, Aq = align; par = sk['parents']; Cinv = [R.from_quat(_BIND[n]).inv() for n in sk['names']]
    n = int(tokens) * 4 - 2 * BOUNDARY; roots = np.zeros((n, 3)); rots = np.zeros((n, J, 4)); contacts = np.zeros((n, 4))
    for f in range(n):
        row = out[0, BOUNDARY + f]
        hp = row[0:3]; glob = [from6d(row[OUT_ROT + j * 6: OUT_ROT + j * 6 + 6]) * Cinv[j] for j in range(J)]   # back to our joint frames
        roots[f] = Aq.apply(hp) + Ap; rots[f, 0] = (Aq * glob[0]).as_quat()
        for j in range(1, J):
            rots[f, j] = (glob[par[j]].inv() * glob[j]).as_quat()
        contacts[f] = np.clip(row[-4:], 0, 1)
    return roots, rots, contacts


def endpoint_correct(sk, roots, rots, ctx_last, tgt_first):
    """ctx_last / tgt_first: (root position, local rots [30,4]) of the last context and first target pose."""
    n = len(roots); out_r = roots.copy(); out_q = rots.copy()
    sp = ctx_last[0] - roots[0]; ep = tgt_first[0] - roots[-1]
    sq = R.from_quat(rots[0, 0]).inv() * R.from_quat(ctx_last[1][0]); eq = R.from_quat(rots[-1, 0]).inv() * R.from_quat(tgt_first[1][0])
    sd = [R.from_quat(rots[0, j]).inv() * R.from_quat(ctx_last[1][j]) for j in range(J)]
    ed = [R.from_quat(rots[-1, j]).inv() * R.from_quat(tgt_first[1][j]) for j in range(J)]
    slerp = lambda q, w: R.from_rotvec(q.as_rotvec() * w)
    for f in range(n):
        ew = f / (n - 1); sw = 1 - ew
        out_r[f] = roots[f] + sp * sw + ep * ew
        out_q[f, 0] = (R.from_quat(rots[f, 0]) * slerp(sq, sw) * slerp(eq, ew)).as_quat()
        for j in range(1, J):
            out_q[f, j] = (R.from_quat(rots[f, j]) * slerp(sd[j], sw) * slerp(ed[j], ew)).as_quat()
    return out_r, out_q


def inbetween(session, sk, roots, rots, ctx, tgt, tokens=None, correct=True):
    """Generate the motion between clip frames ctx (4 indices) and tgt (1-4 indices). tokens: an int to force the
    length (frames = 4*tokens - 6), a list of allowed counts, or None for the model's own choice (8-14).
    Returns (roots, rots, contacts, tokens) with the clip's floor restored."""
    r0 = roots.copy(); r0[:, 1] -= FLOOR
    P, G = fk(sk, r0, rots)
    x, align = encode(sk, P, G, ctx, tgt)
    allowed = [tokens] if isinstance(tokens, int) else (tokens or range(8, 15))
    for t in allowed:
        x['allowed_pred_num_tokens'][0, t - 6] = 1
    out, nt = session.run(x); nt = int(nt[0])
    gr, gq, contacts = decode(sk, out, nt, align)
    if correct:
        gr, gq = endpoint_correct(sk, gr, gq, (r0[ctx[-1]], rots[ctx[-1]]), (r0[tgt[0]], rots[tgt[0]]))
    gr[:, 1] += FLOOR
    return gr, gq.astype(np.float32), contacts, nt


def load_clip(cid, root=os.path.join(REPO, 'demo-output')):
    d = os.path.join(root, cid)
    return (np.fromfile(os.path.join(d, 'root_positions.f32'), np.float32).reshape(-1, 3).astype(float),
            np.fromfile(os.path.join(d, 'local_rotations_xyzw.f32'), np.float32).reshape(-1, J, 4).astype(float))


def load_skeleton(path=os.environ.get('SOMA30_JSON', os.path.join(REPO, 'soma30.json'))):
    return json.load(open(path))
