package main

import "math"

// Floaty jump fix: while the body is airborne its centre of mass rides a gravity parabola. The old fix tweened
// every joint toward a straight blend, which erased most of a flip; this one lifts or lowers the whole body (the
// root's height only) toward the parabola. Every limb keeps its motion, the timing is kept, and the correction
// fades in after take-off and out before landing (a cosine taper, then a light low-pass) so the hips never jolt.
//
// Kimodo's floaty landings often slow the body down while it is still in the air, which no hip height can fix
// without a jolt, so a few tapers are tried and the one that leaves the least float without adding any shake
// wins. A fix is a fix, not a new motion: a taper that moves the body more than maxArcShift on average over the
// jump is not used (the edit guard would rightly call that a changed motion). What is left after that is the
// landing itself; regenerating it is the full fix.
const maxArcShift = 0.12

type arcResult struct {
	stretches     int
	before, after float64 // floaty-jump error (m), as the check measures it
}

func arcStreams(roots, rotations []float32, skeleton skeletonDefinition) ([]float32, arcResult) {
	frames := len(roots) / 3
	pos := forwardKinematics(roots, rotations, skeleton)
	var air []bool
	var gap []float64 // the body's lowest surface over the floor: a variant only moves the hips' height, so it shifts this
	if cf := contactFrames(roots, rotations, skeleton, clipFloor(pos, skeleton)); cf != nil {
		air = analyseContact(cf, roots).air
		for _, c := range cf {
			gap = append(gap, c.gap)
		}
	}
	_, before, fits := ballisticFits(pos, skeleton, air)
	res := arcResult{before: before, after: before}
	if len(fits) == 0 {
		return append([]float32(nil), roots...), res
	}
	jp0, _, _ := jitterPeak(roots, rotations, skeleton)
	// a variant's floaty-jump error and shake, without recomputing every check (24 variants)
	score := func(out []float32) (ball, jp float64) {
		p2 := make([][][3]float32, len(pos))
		var air2 []bool
		for f := range pos {
			dy := out[f*3+1] - roots[f*3+1]
			p2[f] = make([][3]float32, len(pos[f]))
			for j, v := range pos[f] {
				p2[f][j] = [3]float32{v[0], v[1] + dy, v[2]}
			}
			if gap != nil {
				air2 = append(air2, gap[f]+float64(dy) > touchM)
			}
		}
		_, ball, _ = ballisticFits(p2, skeleton, air2)
		jp, _, _ = jitterPeak(out, rotations, skeleton)
		return
	}
	best := append([]float32(nil), roots...)
	for _, fixed := range []bool{true, false} {
		for _, taper := range []float64{0.2, 0.3, 0.4, 0.5} {
			for _, sigma := range []float64{0, 1.5, 2.5} {
				out := append([]float32(nil), roots...)
				n := 0
				for _, a := range fits {
					if a.from == 0 || a.to == frames-1 { // starts or ends in the air: no take-off or landing to hold
						continue
					}
					applyArc(out, a, fixed, taper, sigma)
					n++
				}
				if n == 0 {
					return best, res
				}
				shift, count := 0.0, 0
				for f := 0; f < frames; f++ {
					if d := math.Abs(float64(out[f*3+1] - roots[f*3+1])); d > 0.005 {
						shift += d
						count++
					}
				}
				if count > 0 && shift/float64(count) > maxArcShift {
					continue
				}
				ball, jp := score(out)
				shakes := jp > jp0+2 && (jp > jitterFlagDeg && jp0 <= jitterFlagDeg || jp > jp0*1.15)
				if !shakes && ball < res.after-1e-4 {
					best, res.after, res.stretches = out, ball, n
				}
			}
		}
	}
	return best, res
}

// One stretch: the correction toward the parabola (fixed = through the take-off and landing heights in the
// clip's own airtime; otherwise the least-squares parabola the check fits), tapered and low-passed.
func applyArc(out []float32, a arcFit, fixed bool, taper, sigma float64) {
	const g, dt = 9.81, 1.0 / 30
	n := len(a.com)
	span := float64(n+1) * dt
	v0 := (a.post-a.pre)/span + g*span/2
	delta := make([]float64, n)
	for i := range delta {
		if fixed {
			t := float64(i+1) * dt
			delta[i] = a.pre + v0*t - g*t*t/2 - a.com[i]
		} else {
			delta[i] = a.fit[i] - a.com[i]
		}
		x := float64(i+1) / float64(n+1)
		w := 1.0
		if x < taper {
			w = 0.5 * (1 - math.Cos(math.Pi*x/taper))
		} else if x > 1-taper {
			w = 0.5 * (1 - math.Cos(math.Pi*(1-x)/taper))
		}
		delta[i] *= w
	}
	for i := range delta {
		v := delta[i]
		if sigma > 0 {
			s, ws := 0.0, 0.0
			for k := -6; k <= 6; k++ {
				w := math.Exp(-float64(k*k) / (2 * sigma * sigma))
				ws += w
				if i+k >= 0 && i+k < n {
					s += w * delta[i+k]
				}
			}
			v = s / ws
		}
		out[(a.from+i)*3+1] += float32(v)
	}
}

func containsFlag(flags []string, f string) bool {
	for _, x := range flags {
		if x == f {
			return true
		}
	}
	return false
}
