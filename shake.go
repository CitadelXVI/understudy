// Visible shake: what a viewer sees jump back and forth from one frame to the next. Measured on positions relative
// to the hips (whole-body travel taken out): every joint, plus a point 5 cm off each bone's axis so a bone rolling
// about its own length (a foot rolling onto its edge, a hand flipping) counts too. Joint turn tracks are not used:
// Kimodo writes some turns split differently between neighbouring joints from one frame to the next (a waist turned
// 166° one way and the chest 166° back, an elbow bent sideways with the upper arm spun to make up for it); the track
// jumps while the body moves smoothly, and a turn-based check called such clips shaky while missing real pops.
package main

import (
	"math"
	"strings"
)

const shakeFlagCm = 4.0 // a point that jumps this far back and forth (cm per frame², back-to-back) is a visible shake

func shakeIgnored(name string) bool {
	n := strings.ToLower(name)
	return strings.Contains(n, "eye") || strings.Contains(n, "jaw")
}

// The worst visible shake: centimetres, frame (where it reverses) and the joint whose point shook.
func visibleShake(roots, rotations []float32, skeleton skeletonDefinition) (float64, int, string) {
	joints := len(skeleton.parents)
	if joints == 0 || len(roots) < 15 {
		return 0, -1, ""
	}
	frames := min(len(roots)/3, len(rotations)/(joints*4))
	if frames < 5 {
		return 0, -1, ""
	}
	// the side mark of each joint: perpendicular to its first child's bone, 5 cm out
	marks := make([][3]float32, joints)
	for j := range marks {
		axis := [3]float64{0, 1, 0}
		for c, p := range skeleton.parents {
			o := skeleton.offsets[c]
			if l := math.Sqrt(float64(o[0]*o[0] + o[1]*o[1] + o[2]*o[2])); p == j && l > 1e-6 {
				axis = [3]float64{float64(o[0]) / l, float64(o[1]) / l, float64(o[2]) / l}
				break
			}
		}
		ref := [3]float64{0, 0, 1}
		if math.Abs(axis[2]) > 0.9 {
			ref = [3]float64{1, 0, 0}
		}
		s := [3]float64{axis[1]*ref[2] - axis[2]*ref[1], axis[2]*ref[0] - axis[0]*ref[2], axis[0]*ref[1] - axis[1]*ref[0]}
		l := math.Sqrt(s[0]*s[0] + s[1]*s[1] + s[2]*s[2])
		marks[j] = [3]float32{float32(s[0] / l * 0.05), float32(s[1] / l * 0.05), float32(s[2] / l * 0.05)}
	}
	// points per frame: joint and mark, hips-relative
	pts := make([][][3]float64, frames)
	global := make([][4]float32, joints)
	pos := make([][3]float32, joints)
	for f := 0; f < frames; f++ {
		row := make([][3]float64, 2*joints)
		for j := 0; j < joints; j++ {
			at := (f*joints + j) * 4
			q := [4]float32{rotations[at], rotations[at+1], rotations[at+2], rotations[at+3]}
			if p := skeleton.parents[j]; p < 0 {
				global[j] = q
				pos[j] = [3]float32{roots[f*3], roots[f*3+1], roots[f*3+2]}
			} else {
				global[j] = mulQuat(global[p], q)
				o := rotateVec(global[p], skeleton.offsets[j])
				pos[j] = [3]float32{pos[p][0] + o[0], pos[p][1] + o[1], pos[p][2] + o[2]}
			}
		}
		for j := 0; j < joints; j++ {
			m := rotateVec(global[j], marks[j])
			for k := 0; k < 3; k++ {
				row[j][k] = float64(pos[j][k] - pos[0][k])
				row[joints+j][k] = float64(pos[j][k] + m[k] - pos[0][k])
			}
		}
		pts[f] = row
	}
	best, at, who := 0.0, -1, ""
	for i := 0; i < 2*joints; i++ {
		if shakeIgnored(skeleton.names[i%joints]) {
			continue
		}
		rev := make([]float64, frames) // the point's reversal at each frame, cm per frame²
		spd := make([]float64, frames) // its speed into and out of the frame, cm per frame
		for f := 1; f < frames-2; f++ {
			var a1, a2 [3]float64
			var s0, s1 float64
			for k := 0; k < 3; k++ {
				v0 := pts[f][i][k] - pts[f-1][i][k]
				v1 := pts[f+1][i][k] - pts[f][i][k]
				v2 := pts[f+2][i][k] - pts[f+1][i][k]
				a1[k], a2[k] = v1-v0, v2-v1
				s0 += v0 * v0
				s1 += v1 * v1
			}
			if d := -(a1[0]*a2[0] + a1[1]*a2[1] + a1[2]*a2[2]); d > 0 {
				rev[f] = math.Sqrt(d) * 100
			}
			spd[f] = math.Max(math.Sqrt(s0), math.Sqrt(s1)) * 100
		}
		for f := 1; f < frames-2; f++ {
			r := rev[f]
			if r <= best {
				continue
			}
			// a shake is a back-and-forth: more than one reversal within a few frames. A lone reversal of a fast
			// point is a limb changing direction (a kick snapping out and back, 19 cm per frame), not a shake
			others := 0
			for g := max(1, f-3); g <= min(frames-3, f+3); g++ {
				if g != f && rev[g] > shakeFlagCm*0.75 {
					others++
				}
			}
			if others == 0 && spd[f] > 10 {
				continue
			}
			best, at, who = r, f, skeleton.names[i%joints]
		}
	}
	return best, at, who
}
