// Wrist clean-up: Kimodo's hands twist and fold beyond what a wrist does.
// Each hand's parent-local rotation is split into the twist about the forearm
// axis and the swing away from it; the twist is clamped to ±wristTwistMax and
// the swing to wristSwingMax, then the result is smoothed over the neighbouring
// frames. The same math runs live on the page (static/js/wrist.js); this is
// the version that bakes it into a clip, and the one that runs at generation
// when the request asks for it.
package main

import "math"

const (
	wristTwistMax = 80.0 * math.Pi / 180 // pronation / supination
	wristSwingMax = 70.0 * math.Pi / 180 // flexion / extension / deviation, as one cone
	wristSmooth   = 3                    // frames either side
)

// The hand joints and the axis (in the forearm's frame) they hang from.
func wristJoints(skeleton skeletonDefinition) [][2]int { // [hand, forearm]
	var out [][2]int
	for j, n := range skeleton.names {
		if (n == "LeftHand" || n == "RightHand" || n == "left_wrist" || n == "right_wrist") && skeleton.parents[j] >= 0 {
			out = append(out, [2]int{j, skeleton.parents[j]})
		}
	}
	return out
}

func qnorm(q [4]float32) [4]float32 {
	n := float32(math.Sqrt(float64(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3])))
	if n < 1e-9 {
		return [4]float32{0, 0, 0, 1}
	}
	return [4]float32{q[0] / n, q[1] / n, q[2] / n, q[3] / n}
}

// Clamp one parent-local hand rotation. axis is the forearm→hand direction in
// the forearm's frame (unit).
func clampWrist(q [4]float32, axis [3]float32) [4]float32 {
	q = qnorm(q)
	if q[3] < 0 {
		q = [4]float32{-q[0], -q[1], -q[2], -q[3]}
	}
	// swing-twist decomposition: twist = projection of the vector part on the axis
	d := q[0]*axis[0] + q[1]*axis[1] + q[2]*axis[2]
	twist := qnorm([4]float32{axis[0] * d, axis[1] * d, axis[2] * d, q[3]})
	// swing = q * twist⁻¹
	ti := [4]float32{-twist[0], -twist[1], -twist[2], twist[3]}
	swing := qnorm(qmul(q, ti))
	// clamp angles
	twistAngle := 2 * math.Atan2(float64(d), float64(q[3]))
	if twistAngle > wristTwistMax || twistAngle < -wristTwistMax {
		a := math.Copysign(wristTwistMax, twistAngle)
		s, c := float32(math.Sin(a/2)), float32(math.Cos(a/2))
		twist = [4]float32{axis[0] * s, axis[1] * s, axis[2] * s, c}
	}
	sv := math.Sqrt(float64(swing[0]*swing[0] + swing[1]*swing[1] + swing[2]*swing[2]))
	swingAngle := 2 * math.Atan2(sv, float64(swing[3]))
	if swingAngle > wristSwingMax && sv > 1e-6 {
		s, c := float32(math.Sin(wristSwingMax/2)), float32(math.Cos(wristSwingMax/2))
		k := s / float32(sv)
		swing = [4]float32{swing[0] * k, swing[1] * k, swing[2] * k, c}
	}
	return qnorm(qmul(swing, twist))
}

// wristCleanStreams returns a copy of rotations with every hand clamped and smoothed.
func wristCleanStreams(rotations []float32, skeleton skeletonDefinition) []float32 {
	joints := len(skeleton.parents)
	frames := len(rotations) / (joints * 4)
	out := append([]float32(nil), rotations...)
	for _, pair := range wristJoints(skeleton) {
		hand := pair[0]
		off := skeleton.offsets[hand]
		n := float32(math.Sqrt(float64(off[0]*off[0] + off[1]*off[1] + off[2]*off[2])))
		if n < 1e-6 {
			continue
		}
		axis := [3]float32{off[0] / n, off[1] / n, off[2] / n}
		clamped := make([][4]float32, frames)
		for f := 0; f < frames; f++ {
			at := (f*joints + hand) * 4
			clamped[f] = clampWrist([4]float32{rotations[at], rotations[at+1], rotations[at+2], rotations[at+3]}, axis)
		}
		for f := 0; f < frames; f++ {
			// weighted average over the window, each neighbour aligned to the centre's hemisphere
			acc := [4]float32{}
			for d := -wristSmooth; d <= wristSmooth; d++ {
				t := f + d
				if t < 0 || t >= frames {
					continue
				}
				w := float32(wristSmooth + 1 - abs(d))
				q := clamped[t]
				if q[0]*clamped[f][0]+q[1]*clamped[f][1]+q[2]*clamped[f][2]+q[3]*clamped[f][3] < 0 {
					q = [4]float32{-q[0], -q[1], -q[2], -q[3]}
				}
				for k := range acc {
					acc[k] += w * q[k]
				}
			}
			q := qnorm(acc)
			at := (f*joints + hand) * 4
			out[at], out[at+1], out[at+2], out[at+3] = q[0], q[1], q[2], q[3]
		}
	}
	return out
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
