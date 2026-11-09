"""Mid-clip hover (2026-10-30): Kimodo sometimes glides with both feet off the floor while the hips neither rise nor
fall as a jump would (a sprint brake floated 6 frames at 6-33 cm, "sitting in the air"). A real flight has ballistic
hips: rising, then falling at ~g. Where both soles are off the floor for a few frames and the hips are not in such an
arc, the body is lowered so the lower sole touches, eased in and out, legs re-solved toward their own feet."""
import numpy as np
from scipy.ndimage import gaussian_filter1d

G_ACC = 9.81

def ground_hovers(sk, roots, rots, floor, min_frames=3, clear=0.045, fps=30.0):
    from contact import fk, surface_low, runs, two_bone
    P, G = fk(sk, roots, rots)
    low = surface_low(sk, P, G)
    lowest = np.minimum(np.minimum(low['LeftFoot'], low['LeftToeBase']), np.minimum(low['RightFoot'], low['RightToeBase']))
    off = lowest > floor + clear
    T = len(roots)
    hy = gaussian_filter1d(roots[:, 1], 1.0)
    vy = np.gradient(hy) * fps
    ay = np.gradient(vy) * fps
    drop = np.zeros(T)
    fixed = []
    for a, b in runs(off):
        if b - a + 1 < min_frames:
            continue
        seg = slice(a, b + 1)
        # a jump: hips accelerate downward near g through the flight (and rise first); a hover has flat hips
        ballistic = np.mean(ay[seg]) < -0.45 * G_ACC or (hy[seg].max() - min(hy[max(0, a - 2)], hy[min(T - 1, b + 2)]) > 0.12)
        # a sprint's flight phase (fast, both feet up a stride's length) is left alone even with flat hips; a hover is
        # a slow glide, a few centimetres up
        speed = np.linalg.norm(np.diff(roots[max(0, a - 1):b + 1][:, [0, 2]], axis=0), axis=1).mean() * fps if b > a else 0.0
        if ballistic or speed > 3.5 or (lowest[seg] - floor).max() > 0.25:
            continue
        drop[seg] = lowest[seg] - floor
        fixed.append((int(a), int(b), round(float(drop[seg].max()), 3)))
    if not fixed:
        return roots, rots, fixed
    drop = gaussian_filter1d(drop, 1.5)                      # eased in and out
    roots2 = roots.copy(); roots2[:, 1] -= drop
    # the feet were in the air anyway: the legs follow the body down unchanged (no re-solve needed), but a foot that
    # now dips under the floor is lifted to it
    P2, G2 = fk(sk, roots2, rots); low2 = surface_low(sk, P2, G2)
    out = rots.copy()
    for s in ('Left', 'Right'):
        sole = np.minimum(low2[s + 'Foot'], low2[s + 'ToeBase'])
        under = np.where((sole < floor - 0.003) & (drop > 1e-4))[0]
        if len(under):
            tgt = P2[:, sk['names'].index(s + 'Foot')].copy(); tgt[under, 1] += (floor - sole[under])
            out = two_bone(sk, roots2, out, (s + 'Leg', s + 'Shin', s + 'Foot'), tgt, under, end_global=G2[sk['names'].index(s + 'Foot')].as_quat())
    return roots2, out, fixed
