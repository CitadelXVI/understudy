"""Where a hip or shoulder can point the limb, learned from the library (understudy/static/body/soma30_limits.json).

For LeftLeg/RightLeg/LeftArm/RightArm: the limb's direction in its parent's frame (the joint's local turn applied to
the bone at rest) on every frame of every clip, binned on a sphere (Fibonacci points); a direction is allowed when the
library reached it (a few frames) or it neighbours one that did (one ring of margin). Twist about the bone: the 0.1 /
99.9 percentiles. The Handles keep a dragged limb inside these, plus the Clean up ranges (anatomy.py) and the wrist
range (wrist.js), so a pose can't be dragged somewhere no person goes.

usage: build_reach_limits.py <demo-output dir> <out json>
"""
import glob, json, os, sys
import numpy as np
from scipy.spatial.transform import Rotation as R
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from anatomy import LIMITS, HINGES

N_BINS = 1500
src, out = sys.argv[1], sys.argv[2]


def fib_sphere(n):
    i = np.arange(n) + 0.5; phi = np.arccos(1 - 2 * i / n); th = np.pi * (1 + 5 ** 0.5) * i
    return np.stack([np.cos(th) * np.sin(phi), np.cos(phi), np.sin(th) * np.sin(phi)], 1)


def main():
    skel = json.load(open(os.environ.get('SOMA30_JSON', os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'soma30.json'))))
    ix = {n: i for i, n in enumerate(skel['names'])}; off = np.array(skel['offsets'], float)
    child = {'LeftLeg': 'LeftShin', 'RightLeg': 'RightShin', 'LeftArm': 'LeftForeArm', 'RightArm': 'RightForeArm'}
    bins = fib_sphere(N_BINS)
    counts = {j: np.zeros(N_BINS, int) for j in child}; twists = {j: [] for j in child}; clips = 0
    for d in glob.glob(os.path.join(src, '*')):
        p = os.path.join(d, 'local_rotations_xyzw.f32')
        if not os.path.exists(p): continue
        q = np.fromfile(p, np.float32).reshape(-1, 30, 4).astype(float); clips += 1
        for j, c in child.items():
            bone = off[ix[c]] / np.linalg.norm(off[ix[c]]); rq = R.from_quat(q[:, ix[j]])
            dirs = rq.apply(bone)
            k = np.argmax(dirs @ bins.T, axis=1); np.add.at(counts[j], k, 1)
            # twist about the bone (swing-twist)
            proj = (q[:, ix[j], :3] @ bone)[:, None] * bone; tw = np.concatenate([proj, q[:, ix[j], 3:]], 1)
            tw /= np.maximum(np.linalg.norm(tw, axis=1, keepdims=True), 1e-9)
            twists[j].append(np.degrees(R.from_quat(tw).as_rotvec() @ bone))
    # allowed: reached on >= 3 frames, then one neighbour ring of margin
    nb = np.argsort(-(bins @ bins.T), axis=1)[:, 1:7]
    reach = {}
    for j in child:
        hit = counts[j] >= 3
        grown = hit.copy(); grown[np.unique(nb[hit].ravel())] = True
        tw = np.concatenate(twists[j])
        reach[j] = {'bone': (off[ix[child[j]]] / np.linalg.norm(off[ix[child[j]]])).round(5).tolist(),
                    'allowed': np.where(grown)[0].tolist(),
                    'twist': [round(float(np.percentile(tw, 0.1)) - 10, 1), round(float(np.percentile(tw, 99.9)) + 10, 1)]}
        print(j, 'bins reached', int(hit.sum()), 'allowed with margin', int(grown.sum()), 'of', N_BINS, 'twist', reach[j]['twist'])
    data = {'clips': clips, 'bins': bins.round(5).tolist(), 'reach': reach,
            'limits': LIMITS, 'hinges': {k: {'axis': v[0], 'child': v[1], 'bend': v[2], 'back': v[3], 'twist': v[4], 'side': v[5]} for k, v in HINGES.items()},
            'wrist': {'joints': ['LeftHand', 'RightHand'], 'twist': 80, 'swing': 70}}
    # Straighten (Turn mode) sets a joint to how it sits in a relaxed stand (rest is the T-pose for arms and neck)
    stand = np.fromfile(os.path.join(src, '1a3b4166ff1c5a2d', 'local_rotations_xyzw.f32'), np.float32).reshape(-1, 30, 4)[0]
    data['neutral'] = {'source': 'a relaxed stand (walk clip 1a3b4166ff1c5a2d frame 0)', 'rotations': {n: [round(float(c), 5) for c in stand[i]] for i, n in enumerate(skel['names'])}}
    json.dump(data, open(out, 'w'))
    print('wrote', out, 'from', clips, 'clips')


main()
