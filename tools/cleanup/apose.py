"""Relax A-pose arms (2026-10-30, from an arm diagnosis): Kimodo often holds an upper arm flared out
sideways from the ribs (16-25 degrees on 23 of 28 judged takes; a natural hang is 7-11), worst after a stop. Blind
video judges named "A-pose" / "arm stuck out" in ~40% of verdicts. A follow-through spring cannot fix it (it keeps the
average pose), so this is a posture pass: on calm, upright frames with the hand hanging low, the flare past ~10
degrees is eased three quarters of the way back toward the ribs, smoothed over time. Reaches, raised arms, fast arm
motion and bent trunks are left as generated."""
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial.transform import Rotation as R

NATURAL = 10.5          # degrees of sideways flare a relaxed hanging arm has
SHARE = 0.75

def _world(sk, roots, rots):
    parents = sk['parents']; T, J = rots.shape[:2]; G = [None] * J
    for j in range(J):
        q = R.from_quat(rots[:, j]); G[j] = q if parents[j] < 0 else G[parents[j]] * q
    return G

def _ramp(x, a, b):
    return np.clip((x - a) / (b - a), 0.0, 1.0)

def relax_apose(sk, roots, rots, skip=None):
    ix = {n: i for i, n in enumerate(sk['names'])}
    need = ('Hips', 'Chest', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand')
    if not all(n in ix for n in need):
        return rots, {}
    from contact import fk
    P, _ = fk(sk, roots, rots)
    G = _world(sk, roots, rots)
    Gc = G[ix['Chest']]
    c_up, c_left, c_fwd = Gc.apply([0.0, 1.0, 0.0]), Gc.apply([1.0, 0.0, 0.0]), Gc.apply([0.0, 0.0, 1.0])
    trunk = P[:, ix['Chest']] - P[:, ix['Hips']]
    trunk_cos = trunk[:, 1] / np.maximum(np.linalg.norm(trunk, axis=1), 1e-9)
    out = rots.copy(); rep = {}
    for side, sgn in (('Left', 1.0), ('Right', -1.0)):
        arm, fore, hand = ix[side + 'Arm'], ix[side + 'ForeArm'], ix[side + 'Hand']
        u = P[:, fore] - P[:, arm]; u /= np.maximum(np.linalg.norm(u, axis=1, keepdims=True), 1e-9)
        flare = np.degrees(np.arctan2(sgn * np.sum(u * c_left, axis=1), -np.sum(u * c_up, axis=1)))
        speed = np.zeros(len(u))
        speed[1:] = np.degrees(np.linalg.norm((R.from_quat(rots[1:, arm]) * R.from_quat(rots[:-1, arm]).inv()).as_rotvec(), axis=1)) * 30
        speed = gaussian_filter1d(speed, 3.0, mode='nearest')
        down = -np.sum(u * c_up, axis=1)                       # 1 = upper arm straight down the ribs
        low_hand = P[:, ix['Chest'], 1] - 0.10 - P[:, hand, 1]  # > 0: the hand hangs below the chest
        w = _ramp(trunk_cos, 0.75, 0.90) * _ramp(down, 0.55, 0.80) * _ramp(low_hand, 0.0, 0.08) * (1.0 - _ramp(speed, 35.0, 80.0))
        if skip is not None: w = w * (1.0 - np.asarray(skip, float))
        w = np.clip(gaussian_filter1d(w, 4.0, mode='nearest'), 0.0, 1.0)
        excess = gaussian_filter1d(np.maximum(0.0, flare - NATURAL) * w, 10.0, mode='nearest') * w
        if excess.max() < 0.5:
            continue
        ang = np.radians(-sgn * SHARE * excess)                 # inward, about the chest's forward axis
        Gw = _world(sk, roots, out); Gj = Gw[arm]
        turn = R.from_rotvec(c_fwd * ang[:, None])
        q = (R.from_quat(out[:, arm]) * (Gj.inv() * turn * Gj)).as_quat()
        q = np.where(np.sum(q * out[:, arm], axis=1, keepdims=True) < 0, -q, q)
        out[:, arm] = q
        rep[side] = {'flare_mean_deg': round(float(np.mean(flare)), 1), 'eased_max_deg': round(float(SHARE * excess.max()), 1)}
    return out, rep
