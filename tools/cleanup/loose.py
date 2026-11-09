"""Loose arms (experiment 2026-10-29, tuned 2026-10-30 from a review): follow-through on the arms.

Kimodo's arms often move as if bolted to the torso: when the body turns, stops or dips, a real person's hanging arms lag
a moment and swing past. Each arm joint's WORLD turn follows the turn the clip asks for through a spring (in hierarchy
order, so a forearm rides its simulated upper arm), blended with the clip by `strength`.

Tuning (a blind A/B won walk 6-5 and turn 7-6 but lost a run 4-5):
- damping 0.72-0.80, past the resonance point: at 0.45 the springs peaked right on running cadence and the forearms
  snapped forward on every stride;
- the left and right arms have slightly different frequencies, so they never settle in mirror lockstep;
- no lag about the upper arm's own axis, and the elbow keeps a hinge: a lagging twist swung a bent forearm sideways
  like a door (11-17 degrees out at each forward swing of a run);
- a speed gate: where the arm itself drives fast (a pump, a strike, an arm dropping on purpose) the spring fades out,
  so follow-through stays where the body carries the arm;
- the head is not sprung (gaze.py looks after it; a sprung neck bobbled).

usage: python loose.py <in_dir> <out_dir> [--strength 0.5]   (in/out: root_positions.f32 + local_rotations_xyzw.f32)"""
import argparse, json, os
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial.transform import Rotation as R

# joint: (natural frequency Hz, damping ratio). Heavier, longer parts swing slower.
SPRINGS = {'LeftShoulder': (4.2, 0.80), 'RightShoulder': (4.5, 0.80),
           'LeftArm': (2.5, 0.72), 'RightArm': (2.8, 0.72),
           'LeftForeArm': (3.3, 0.75), 'RightForeArm': (3.6, 0.75),
           'LeftHand': (4.5, 0.75), 'RightHand': (4.8, 0.75)}
GATE_FROM, GATE_SPAN, GATE_FLOOR = 95.0, 95.0, 0.15   # deg/s of the arm's own turn: full below 95, 15 % above 190

def _speed_dps(q):
    """[T] degrees per second of a local turn track (30 fps)."""
    s = np.zeros(len(q))
    s[1:] = np.degrees(np.linalg.norm((R.from_quat(q[1:]) * R.from_quat(q[:-1]).inv()).as_rotvec(), axis=1)) * 30
    return s

def loosen(sk, roots, rots, strength=0.5, fps=30.0, springs=SPRINGS):
    names, parents = sk['names'], sk['parents']
    ix = {n: i for i, n in enumerate(names)}
    off = np.array(sk['offsets'], float)
    T, J = rots.shape[:2]
    dt = 1.0 / fps
    # per side: how hard the arm drives itself (its own local turn speed), smoothed -> gate in [GATE_FLOOR, 1]
    gate = {}
    for side in ('Left', 'Right'):
        w = np.maximum(_speed_dps(rots[:, ix[side + 'Arm']]), 0.8 * _speed_dps(rots[:, ix[side + 'ForeArm']]))
        w = gaussian_filter1d(w, 6.0, mode='nearest')
        gate[side] = 1.0 - (1.0 - GATE_FLOOR) * np.clip((w - GATE_FROM) / GATE_SPAN, 0.0, 1.0)
    G = [None] * J
    out = rots.copy()
    for j in range(J):
        local = R.from_quat(rots[:, j])
        if parents[j] < 0:
            G[j] = local; continue
        want = G[parents[j]] * local                   # where the clip puts this part, given the simulated parent
        if names[j] not in springs:
            G[j] = want; continue
        f, z = springs[names[j]]
        w0 = 2 * np.pi * f; k, c = w0 * w0, 2 * z * w0
        wq = want.as_quat(); sq = np.empty_like(wq)
        s = R.from_quat(wq[0]); om = np.zeros(3)
        for t in range(T):
            target = R.from_quat(wq[t])
            err = (target * s.inv()).as_rotvec()
            for _ in range(4):
                om += (k * err - c * om) * (dt / 4)
                s = R.from_rotvec(om * dt / 4) * s
                err = (target * s.inv()).as_rotvec()
            sq[t] = s.as_quat()
        new_local = G[parents[j]].inv() * R.from_quat(sq)
        d = (local.inv() * new_local).as_rotvec()       # the spring's change, in the joint's own frame
        n = names[j]
        if n.endswith('Arm') and not n.endswith('ForeArm'):   # no lag about the upper arm's own (bone) axis
            child = ix[n.replace('Arm', 'ForeArm')]
            ax = off[child] / max(np.linalg.norm(off[child]), 1e-9)
            d = d - (d @ ax)[:, None] * ax
        if n.endswith('ForeArm'):                       # the elbow is a hinge: keep only the bend
            hinge = np.zeros(3); hinge[1] = 1.0
            d = (d @ hinge)[:, None] * hinge
        side = 'Left' if n.startswith('Left') else 'Right'
        bl = local * R.from_rotvec(d * (strength * gate[side])[:, None])
        q = bl.as_quat(); q = np.where(np.sum(q * rots[:, j], axis=1, keepdims=True) < 0, -q, q)
        out[:, j] = q
        G[j] = G[parents[j]] * R.from_quat(q)
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('in_dir'); ap.add_argument('out_dir'); ap.add_argument('--strength', type=float, default=0.5)
    a = ap.parse_args()
    sk = json.load(open(os.path.join(a.in_dir, 'skeleton.json')))
    roots = np.fromfile(os.path.join(a.in_dir, 'root_positions.f32'), np.float32).reshape(-1, 3).astype(float)
    rots = np.fromfile(os.path.join(a.in_dir, 'local_rotations_xyzw.f32'), np.float32).reshape(len(roots), -1, 4).astype(float)
    out = loosen(sk, roots, rots, a.strength)
    os.makedirs(a.out_dir, exist_ok=True)
    roots.astype(np.float32).tofile(os.path.join(a.out_dir, 'root_positions.f32'))
    out.astype(np.float32).tofile(os.path.join(a.out_dir, 'local_rotations_xyzw.f32'))

if __name__ == '__main__':
    main()
