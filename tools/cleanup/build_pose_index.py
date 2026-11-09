"""The auto-poser's pose index: every distinct pose in the library, as a small feature vector (understudy/static/body/).

A pose = where the hands, feet and head are relative to the hips, turned so the body faces +Z (so a crouch matches a
crouch whichever way it faced), plus the hips' height over the floor: 16 numbers. Clips that are trashed or carry a
broken-pose flag (anatomy, self-clip, hand in head, float) are left out; consecutive frames that moved less than
2 cm anywhere are kept once. The page compares the pose being edited against these and offers the closest real pose.

usage: build_pose_index.py <demo-output dir> <out dir>
"""
import glob, json, os, sys
import numpy as np
from scipy.spatial.transform import Rotation as R
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import contact as C

BAD = {'anatomy', 'clip', 'hand_head', 'float'}
JOINTS = ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'Head']
FLOOR = 0.02


def features(sk, P):
    ix = {n: i for i, n in enumerate(sk['names'])}
    a = P[:, ix['RightLeg']] - P[:, ix['LeftLeg']]; a[:, 1] = 0; a /= np.maximum(np.linalg.norm(a, axis=1, keepdims=True), 1e-9)
    f = np.cross([0, 1, 0], a); yaw = np.arctan2(f[:, 0], f[:, 2])
    rel = np.stack([P[:, ix[j]] - P[:, 0] for j in JOINTS], 1)                         # [T,5,3]
    c, s = np.cos(-yaw)[:, None], np.sin(-yaw)[:, None]
    x = rel[..., 0] * c + rel[..., 2] * s; z = -rel[..., 0] * s + rel[..., 2] * c
    rel = np.stack([x, rel[..., 1], z], -1)
    return np.concatenate([rel.reshape(len(P), -1), (P[:, 0, 1] - FLOOR)[:, None]], 1).astype(np.float32), yaw


def main():
    src, out = sys.argv[1], sys.argv[2]
    sk = json.load(open(os.environ.get('SOMA30_JSON', os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'soma30.json'))))
    clips, refs, feats = [], [], []
    for meta in sorted(glob.glob(os.path.join(src, '*.json'))):
        try: m = json.load(open(meta, encoding='utf-8'))
        except Exception: continue
        if not isinstance(m, dict) or 'id' not in m or m.get('trashed') or m.get('status') != 'ready': continue
        if not str(m.get('model', '')).startswith('soma'): continue
        if BAD & set((m.get('metrics') or {}).get('flags') or []): continue
        d = os.path.join(src, m['id'])
        if not os.path.exists(os.path.join(d, 'local_rotations_xyzw.f32')): continue
        r = np.fromfile(os.path.join(d, 'root_positions.f32'), np.float32).reshape(-1, 3).astype(float)
        q = np.fromfile(os.path.join(d, 'local_rotations_xyzw.f32'), np.float32).reshape(-1, 30, 4).astype(float)
        if len(r) != len(q) or not len(r): continue
        P, _ = C.fk(sk, r, q); F, _ = features(sk, P)
        ci = len(clips); clips.append(m['id']); last = None
        for t in range(len(F)):
            if last is not None and np.abs(F[t] - last).max() < 0.02: continue
            last = F[t]; refs.append([ci, t]); feats.append(F[t])
    feats = np.array(feats, np.float32)
    os.makedirs(out, exist_ok=True)
    feats.tofile(os.path.join(out, 'pose_index.f32'))
    json.dump({'joints': JOINTS, 'dims': int(feats.shape[1]), 'count': int(len(feats)), 'clips': clips, 'refs': refs, 'floor': FLOOR}, open(os.path.join(out, 'pose_index.json'), 'w'))
    print('poses', len(feats), 'from', len(clips), 'clips;', round(feats.nbytes / 1e6, 1), 'MB')


main()
