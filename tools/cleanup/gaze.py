"""Level gaze (2026-10-30, from a diagnosis): Kimodo bends the neck 18-32 degrees forward on standing,
slow, crouching and combat clips (the head stares at the floor), and cranes it 16-26 degrees up on jogs, runs and turns.
Blind video judges marked both down on nearly every take; the mannequin's faceless head adds ~10 degrees of droop to
the eye. Clean up adds none (it lifts the head ~3 degrees).

This pass keeps the head's own motion (nods, a recoil, a turn led by the head) and removes only the sustained part
outside a natural corridor: the excess is smoothed over ~0.4 s and spread over Neck1 / Neck2 / Head, as a pure pitch
about the head's OWN left axis (the hips' axis rolled the head sideways on head-led turns). The corridor widens
downward as the trunk bends and while a hand reaches down to knee height (a pick-up looks at the floor). Upright,
prop and reach gates are smooth weights, never on/off switches (a hard switch snapped the neck in one frame)."""
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial.transform import Rotation as R

MIN_UP = -12.0          # degrees: the head may pitch up at most this far (more read as "craned skyward")
MAX_DOWN = -5.0         # degrees: and down this far while the trunk is upright (judged upright takes sat at -16..+5; the faceless head reads ~10 lower)
TRUNK_GIVE = 0.75       # extra downward room per degree of trunk lean past TRUNK_FREE
TRUNK_FREE = 15.0
REACH_DOWN = 75.0       # room to look down while a hand reaches to knee height
SPLIT = {'Neck1': 0.55, 'Neck2': 0.25, 'Head': 0.20}
UP = np.array([0.0, 1.0, 0.0])

def _world(sk, roots, rots):
    parents = sk['parents']; T, J = rots.shape[:2]; G = [None] * J
    for j in range(J):
        q = R.from_quat(rots[:, j]); G[j] = q if parents[j] < 0 else G[parents[j]] * q
    return G

def _left_of(rot, fallback):
    """The bone's own horizontal left axis (its local +X projected on the floor); the fallback where the bone points
    near-vertically sideways (a flip, a dive)."""
    lx = rot.apply([1.0, 0.0, 0.0]); lx[:, 1] = 0.0
    n = np.linalg.norm(lx, axis=1, keepdims=True)
    return np.where(n > 0.25, lx / np.maximum(n, 1e-9), fallback)

def _pitch(rot, left):
    """Degrees below horizontal of the bone's forward (+Z), in its own vertical plane."""
    f = rot.apply([0.0, 0.0, 1.0]); fwd = np.cross(left, UP)
    return np.degrees(np.arctan2(-f[:, 1], np.sum(f * fwd, axis=1)))

def level_gaze(sk, roots, rots, skip=None, strength=1.0, sigma=12.0):
    """Returns (rots, report). skip: [T] bool frames left alone (resting on a prop)."""
    ix = {n: i for i, n in enumerate(sk['names'])}
    need = ('Hips', 'Chest', 'Neck1', 'Neck2', 'Head', 'LeftLeg', 'RightLeg', 'LeftShin', 'RightShin', 'LeftHand', 'RightHand')
    if not all(n in ix for n in need):
        return rots, {}
    T = len(rots)
    from contact import fk
    P, _ = fk(sk, roots, rots)
    G = _world(sk, roots, rots)
    hips_left = P[:, ix['LeftLeg']] - P[:, ix['RightLeg']]; hips_left[:, 1] = 0
    hips_left /= np.maximum(np.linalg.norm(hips_left, axis=1, keepdims=True), 1e-9)
    chest_left = _left_of(G[ix['Chest']], hips_left)
    head_left = _left_of(G[ix['Head']], chest_left)
    head, chest = _pitch(G[ix['Head']], head_left), _pitch(G[ix['Chest']], chest_left)
    # weights in [0, 1], smoothed: trunk upright (Hips->Chest within ~50 degrees of vertical), not on a prop
    trunk = P[:, ix['Chest']] - P[:, ix['Hips']]
    trunk_cos = trunk[:, 1] / np.maximum(np.linalg.norm(trunk, axis=1), 1e-9)
    w_up = np.clip((trunk_cos - 0.40) / 0.22, 0.0, 1.0)
    if skip is not None:
        w_up = w_up * (1.0 - np.asarray(skip, float))
    w_keep = np.clip(gaussian_filter1d(w_up, 6.0, mode='nearest'), 0.0, 1.0)
    # reaching down: the lower hand at the LOWER knee's height (a one-knee kneel's hanging hands are not a reach)
    low_knee = np.minimum(P[:, ix['LeftShin'], 1], P[:, ix['RightShin'], 1])
    low_hand = np.minimum(P[:, ix['LeftHand'], 1], P[:, ix['RightHand'], 1])
    reach_w = np.clip(gaussian_filter1d((low_hand < low_knee + 0.08).astype(float), 6.0, mode='nearest') * 1.5, 0.0, 1.0)
    lo = np.full(T, MIN_UP)
    hi = MAX_DOWN + TRUNK_GIVE * np.maximum(0.0, chest - TRUNK_FREE)
    hi = hi + reach_w * (REACH_DOWN - hi)
    excess = np.clip(head, lo, hi) - head                                # degrees to add (negative: lift the head)
    e = gaussian_filter1d(excess * w_keep, sigma, mode='nearest') * w_keep * strength
    if np.abs(e).max() < 0.5:
        return rots, {'gaze_mean_deg': 0.0}
    out = rots.copy()
    for name, share in SPLIT.items():   # parent first; a world-space pitch about the head's own left axis
        Gw = _world(sk, roots, out)
        j = ix[name]; Gj = Gw[j]
        turn = R.from_rotvec(head_left * np.radians(e * share)[:, None])   # + about left = pitch down
        q = (R.from_quat(out[:, j]) * (Gj.inv() * turn * Gj)).as_quat()
        q = np.where(np.sum(q * out[:, j], axis=1, keepdims=True) < 0, -q, q)   # same hemisphere as before
        out[:, j] = q
    return out, {'gaze_mean_deg': round(float(np.mean(e)), 1), 'gaze_max_deg': round(float(np.abs(e).max()), 1),
                 'head_before_deg': round(float(np.median(head[w_keep > 0.5])) if (w_keep > 0.5).any() else 0.0, 1)}
