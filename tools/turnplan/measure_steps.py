"""Per foot: each lift (peak height above its rest) and the slip of each planted stretch (ankle travel on the floor);
plus the closest the two feet come (scissoring)."""
import os, sys, json, numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'motionbricks')); import mb
sk = mb.load_skeleton(); ix = {n: i for i, n in enumerate(sk['names'])}
for d in sys.argv[1:]:
    r = np.fromfile(d + '/root_positions.f32', np.float32).reshape(-1, 3).astype(float); q = np.fromfile(d + '/local_rotations_xyzw.f32', np.float32).reshape(-1, 30, 4).astype(float)
    P, _ = mb.fk(sk, r, q); out = []
    for s in ('Left', 'Right'):
        a = P[:, ix[s + 'Foot']]; t = P[:, ix[s + 'ToeBase']]
        h = np.minimum(a[:, 1], t[:, 1]); h = h - np.percentile(h, 5)
        up = h > 0.025
        lifts, slips, f = [], [], 0
        while f < len(h):
            g = f
            while g < len(h) and up[g] == up[f]: g += 1
            if up[f]: lifts.append(round(h[f:g].max() * 100))
            else: slips.append(round(np.linalg.norm(a[g - 1, [0, 2]] - a[f, [0, 2]]) * 100))
            f = g
        out.append(f'{s[0]} lifts {lifts} cm, planted slips {slips} cm')
    gap = np.linalg.norm((P[:, ix['LeftFoot']] - P[:, ix['RightFoot']])[:, [0, 2]], axis=1)
    print(d[-16:-8], ' | '.join(out), f'| closest feet {gap.min()*100:.0f} cm at f{gap.argmin()}')
