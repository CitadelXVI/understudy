// Jitter: a joint that shakes back and forth from one frame to the next (Kimodo sometimes snaps a foot at
// take-off or landing, or an arm in a hand plant). A mean over the whole clip washes a few-frame shake out,
// so this looks at each joint's turn per frame and finds the frames where its acceleration reverses hard:
// the turn speeds up one way and immediately the other. Fast but smooth moves (a kick, a flip) accelerate
// one way for several frames and do not count.
//
// The fix refits only the joints and frames that shake with a 9-frame cubic (Savitzky-Golay), fading back to the
// original around them, and leaves the rest alone.
package main

import (
	"math"
	"strings"
)

const (
	jitterFlagDeg   = 15.0 // a joint whose turn reverses this hard (degrees per frame², back-to-back) is shaking
	jitterRootCm    = 1.2  // the same for the root, in centimetres per frame²
	jitterWindow    = 4    // frames either side of the cubic fit that smooths a shake (Savitzky-Golay, 9 frames)
	jitterTaper     = 2    // frames over which the smoothing fades back to the original
	jitterSmoothMax = 3    // smoothing passes
)

// Joints the shake check ignores: end sites that only carry a length, and the face.
func jitterIgnored(name string) bool {
	n := strings.ToLower(name)
	return strings.HasSuffix(n, "end") || strings.Contains(n, "eye") || strings.Contains(n, "jaw")
}

// The turn from q0 to q1 as an axis × angle vector (radians), q = [x y z w].
func turnVector(q0, q1 [4]float32) [3]float64 {
	d := qmul(qnorm(q1), qConj(qnorm(q0)))
	if d[3] < 0 {
		d = [4]float32{-d[0], -d[1], -d[2], -d[3]}
	}
	s := math.Sqrt(float64(d[0]*d[0] + d[1]*d[1] + d[2]*d[2]))
	if s < 1e-9 {
		return [3]float64{}
	}
	a := 2 * math.Atan2(s, float64(d[3]))
	return [3]float64{float64(d[0]) / s * a, float64(d[1]) / s * a, float64(d[2]) / s * a}
}

// How hard a track reverses at frame f (1..frames-3): sqrt of the negative dot of two back-to-back accelerations.
func reversal(v []([3]float64), f int) float64 {
	a1 := v3sub(v[f], v[f-1])
	a2 := v3sub(v[f+1], v[f])
	d := -v3dot(a1, a2)
	if d <= 0 {
		return 0
	}
	return math.Sqrt(d)
}

type jitterHit struct {
	joint int // -1 = root
	frame int
	size  float64 // degrees for joints, centimetres for the root
}

// Every shake in a clip, joints in degrees, the root in centimetres.
func jitterHits(roots, rotations []float32, skeleton skeletonDefinition) []jitterHit {
	joints := len(skeleton.parents)
	if joints == 0 {
		return nil
	}
	frames := len(rotations) / (joints * 4)
	if frames < 5 {
		return nil
	}
	var hits []jitterHit
	vel := make([][3]float64, frames-1)
	for j := 0; j < joints; j++ {
		if jitterIgnored(skeleton.names[j]) {
			continue
		}
		for f := 0; f < frames-1; f++ {
			a, b := (f*joints+j)*4, ((f+1)*joints+j)*4
			vel[f] = turnVector([4]float32{rotations[a], rotations[a+1], rotations[a+2], rotations[a+3]}, [4]float32{rotations[b], rotations[b+1], rotations[b+2], rotations[b+3]})
		}
		for f := 1; f < frames-2; f++ {
			if r := reversal(vel, f) * 180 / math.Pi; r > 0 {
				hits = append(hits, jitterHit{j, f, r})
			}
		}
	}
	for f := 0; f < frames-1; f++ {
		vel[f] = [3]float64{float64(roots[(f+1)*3] - roots[f*3]), float64(roots[(f+1)*3+1] - roots[f*3+1]), float64(roots[(f+1)*3+2] - roots[f*3+2])}
	}
	for f := 1; f < frames-2; f++ {
		if r := reversal(vel, f) * 100; r > 0 {
			hits = append(hits, jitterHit{-1, f, r})
		}
	}
	return hits
}

// The worst shake: the joint's peak in degrees (root shakes are converted at 1 cm ≈ jitterFlagDeg/jitterRootCm degrees
// so one number ranks both), its frame and joint name.
func jitterPeak(roots, rotations []float32, skeleton skeletonDefinition) (float64, int, string) {
	best, at, who := 0.0, -1, ""
	for _, h := range jitterHits(roots, rotations, skeleton) {
		s := h.size
		name := "root"
		if h.joint < 0 {
			s *= jitterFlagDeg / jitterRootCm
		} else {
			name = skeleton.names[h.joint]
		}
		if s > best {
			best, at, who = s, h.frame, name
		}
	}
	return best, at, who
}

// Smooth every shake away, keeping contacts. A shake is usually a whole-body event (a landing snaps the hips, shins
// and feet in the same frame), so around each shake the whole pose (every joint and the root) is refitted with the
// 9-frame cubic, fading back to the original; then planted toes and hands are put back exactly where they were by
// two-bone IK, the foot or hand keeping its smoothed turn (eased back where the leg cannot reach). Repeats while
// shakes remain. Returns the new streams and the frames changed.
func smoothJitterStreams(roots, rotations []float32, skeleton skeletonDefinition) ([]float32, []float32, int) {
	joints := len(skeleton.parents)
	if joints == 0 {
		return roots, rotations, 0
	}
	frames := len(rotations) / (joints * 4)
	outR := append([]float32(nil), roots...)
	outQ := append([]float32(nil), rotations...)
	changed := 0
	for pass := 0; pass < jitterSmoothMax; pass++ {
		w := make([]float64, frames)
		any := false
		for _, h := range jitterHits(outR, outQ, skeleton) {
			thr := jitterFlagDeg
			if h.joint < 0 {
				thr = jitterRootCm
			}
			if h.size <= thr {
				continue
			}
			any = true
			for g := h.frame - 1 - jitterTaper; g <= h.frame+2+jitterTaper; g++ {
				if g < 0 || g >= frames {
					continue
				}
				v := 1.0
				if g < h.frame-1 {
					v = 1 - float64(h.frame-1-g)/float64(jitterTaper+1)
				} else if g > h.frame+2 {
					v = 1 - float64(g-h.frame-2)/float64(jitterTaper+1)
				}
				w[g] = math.Max(w[g], v)
			}
		}
		if !any {
			break
		}
		srcR := append([]float32(nil), outR...)
		srcQ := append([]float32(nil), outQ...)
		touched := make([]bool, frames)
		for f := 0; f < frames; f++ {
			if w[f] <= 0.001 {
				continue
			}
			touched[f] = true
			changed++
			k := w[f]
			var acc [3]float64
			for d := -jitterWindow; d <= jitterWindow; d++ {
				t := clampFrame(f+d, frames)
				for i := 0; i < 3; i++ {
					acc[i] += sgCoef[d+jitterWindow] / 231 * float64(srcR[t*3+i])
				}
			}
			for i := 0; i < 3; i++ {
				outR[f*3+i] = float32(float64(srcR[f*3+i])*(1-k) + acc[i]*k)
			}
			for j := 0; j < joints; j++ {
				at := (f*joints + j) * 4
				c := [4]float32{srcQ[at], srcQ[at+1], srcQ[at+2], srcQ[at+3]}
				q4 := [4]float32{}
				for d := -jitterWindow; d <= jitterWindow; d++ {
					b := (clampFrame(f+d, frames)*joints + j) * 4
					q := [4]float32{srcQ[b], srcQ[b+1], srcQ[b+2], srcQ[b+3]}
					if q[0]*c[0]+q[1]*c[1]+q[2]*c[2]+q[3]*c[3] < 0 {
						q = [4]float32{-q[0], -q[1], -q[2], -q[3]}
					}
					cf := float32(sgCoef[d+jitterWindow])
					for i := range q4 {
						q4[i] += cf * q[i]
					}
				}
				q := nlerpQ(c, qnorm(q4), k)
				outQ[at], outQ[at+1], outQ[at+2], outQ[at+3] = q[0], q[1], q[2], q[3]
			}
		}
		restoreContacts(srcR, srcQ, outR, outQ, skeleton, touched)
	}
	if changed == 0 {
		return roots, rotations, 0
	}
	// never hand back something that shakes harder than what came in
	if before, _, _ := jitterPeak(roots, rotations, skeleton); func() bool { after, _, _ := jitterPeak(outR, outQ, skeleton); return after >= before }() {
		return roots, rotations, 0
	}
	return outR, outQ, changed
}

// Put planted ends back: on every touched frame where a toe (or a hand) was on the floor before smoothing, the leg
// (or arm) is re-solved by two-bone IK so the toe (wrist) is exactly where it was, while the foot (hand) keeps its
// smoothed turn; where the leg cannot reach, the foot eases back toward its old turn. The pull eases out over two
// frames around a contact.
func restoreContacts(roots0, rot0, roots, rot []float32, skeleton skeletonDefinition, touched []bool) {
	joints := len(skeleton.parents)
	frames := len(rot) / (joints * 4)
	pos0 := forwardKinematics(roots0, rot0, skeleton)
	floor := clipFloor(pos0, skeleton)
	index := map[string]int{}
	for i, n := range skeleton.names {
		index[n] = i
	}
	type limb struct {
		c     armIK
		end   int
		reach float64
	}
	var limbs []limb
	for _, side := range []string{"Left", "Right"} {
		if u, ok := index[side+"Leg"]; ok {
			if l, w, t := index[side+"Shin"], index[side+"Foot"], index[side+"ToeBase"]; l > 0 && w > 0 && t > 0 {
				limbs = append(limbs, limb{armIK{upper: u, lower: l, wrist: w}, t, 0.012})
			}
		}
		if u, ok := index[side+"Arm"]; ok {
			if l, w := index[side+"ForeArm"], index[side+"Hand"]; l > 0 && w > 0 {
				limbs = append(limbs, limb{armIK{upper: u, lower: l, wrist: w}, w, 0.08})
			}
		}
	}
	for _, lb := range limbs {
		pull := make([]float64, frames)
		for f := 0; f < frames; f++ {
			if float64(pos0[f][lb.end][1])-floor >= lb.reach {
				continue
			}
			for d := -2; d <= 2; d++ {
				if g := f + d; g >= 0 && g < frames {
					pull[g] = math.Max(pull[g], 1-float64(abs(d))/3)
				}
			}
		}
		u, l, w := lb.c.upper, lb.c.lower, lb.c.wrist
		maxReach := v3len(hF64(skeleton.offsets[l])) + v3len(hF64(skeleton.offsets[w])) - 0.003
		for f := 0; f < frames; f++ {
			if pull[f] <= 0 || !touched[f] {
				continue
			}
			fr := frameRotations(rot, joints, f)
			fr0 := frameRotations(rot0, joints, f)
			root := [3]float32{roots[f*3], roots[f*3+1], roots[f*3+2]}
			root0 := [3]float32{roots0[f*3], roots0[f*3+1], roots0[f*3+2]}
			P, G := fkFrame(root, fr, skeleton)
			_, G0 := fkFrame(root0, fr0, skeleton)
			endNew, endOld := G[w], G0[w]
			shoulder := hF64(P[u])
			goal := func(q [4]float32) [3]float64 {
				want := hF64(pos0[f][lb.end])
				if lb.end != w {
					want = v3sub(want, hF64(rotateVec(q, skeleton.offsets[lb.end])))
				}
				now := hF64(P[w])
				return v3add(now, v3scale(v3sub(want, now), pull[f]))
			}
			endRot := endNew
			target := goal(endRot)
			if v3len(v3sub(target, shoulder)) > maxReach {
				lo, hi := 0.0, 1.0
				for i := 0; i < 12; i++ {
					m := (lo + hi) / 2
					if v3len(v3sub(goal(nlerpQ(endOld, endNew, m)), shoulder)) > maxReach {
						hi = m
					} else {
						lo = m
					}
				}
				endRot = nlerpQ(endOld, endNew, lo)
				target = goal(endRot)
			}
			solveArm(fr, root, skeleton, lb.c, target)
			_, G2 := fkFrame(root, fr, skeleton)
			fr[w] = qnorm(mulQuat(qConj(G2[skeleton.parents[w]]), endRot))
			at := f * joints * 4
			for _, j := range []int{u, l, w} {
				rot[at+j*4], rot[at+j*4+1], rot[at+j*4+2], rot[at+j*4+3] = fr[j][0], fr[j][1], fr[j][2], fr[j][3]
			}
		}
	}
}

// Savitzky-Golay weights for a cubic fit over 9 frames: keeps a real acceleration (a take-off speeding up), drops a shake.
var sgCoef = [9]float64{-21, 14, 39, 54, 59, 54, 39, 14, -21}

func clampFrame(f, frames int) int {
	if f < 0 {
		return 0
	}
	if f >= frames {
		return frames - 1
	}
	return f
}

// Normalised blend of two rotations, b taken onto a's hemisphere.
func nlerpQ(a, b [4]float32, t float64) [4]float32 {
	if a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3] < 0 {
		b = [4]float32{-b[0], -b[1], -b[2], -b[3]}
	}
	k := float32(t)
	return qnorm([4]float32{a[0]*(1-k) + b[0]*k, a[1]*(1-k) + b[1]*k, a[2]*(1-k) + b[2]*k, a[3]*(1-k) + b[3]*k})
}
