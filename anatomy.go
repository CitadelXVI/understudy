// Anatomy: joints turned further than a body can (a neck folded 170° into the chest, a knee twisted so the foot
// faces backwards, an elbow bent sideways). Kimodo makes these now and then, more often under constraints. The
// limits are above what the library's good clips reach (99.9th percentile + margin), so only broken poses flag;
// tools/cleanup/anatomy.py holds the same numbers and the fix (Clean up pulls every joint back inside, eased).
package main

import "math"

// total turn from rest, degrees
var anatomyLimits = map[string]float64{"Spine1": 60, "Spine2": 40, "Chest": 55, "Neck1": 90, "Neck2": 70, "Head": 85,
	"LeftShoulder": 65, "RightShoulder": 65, "LeftFoot": 110, "RightFoot": 110, "LeftToeBase": 70, "RightToeBase": 70}

// knees and elbows: bend axis, the child joint that gives the bone axis, max bend, max backward bend, max twist, max side bend
type hingeLimit struct {
	axis                       [3]float64
	child                      string
	bend, back, twist, sideMax float64
}

var anatomyHinges = map[string]hingeLimit{
	"LeftShin":     {[3]float64{1, 0, 0}, "LeftFoot", 165, 30, 60, 45},
	"RightShin":    {[3]float64{1, 0, 0}, "RightFoot", 165, 30, 60, 45},
	"LeftForeArm":  {[3]float64{0, -1, 0}, "LeftHand", 165, 30, 120, 75},
	"RightForeArm": {[3]float64{0, 1, 0}, "RightHand", 165, 30, 120, 75},
}

type anatomyHit struct {
	joint  string
	frames int
	frame  int     // worst frame
	over   float64 // degrees past the limit at the worst frame
}

func quatAngleDeg(q [4]float32) float64 {
	w := math.Min(1, math.Abs(float64(q[3])))
	return 2 * math.Acos(w) * 180 / math.Pi
}

// rotation vector (axis × radians) of a unit quaternion
func quatRotvec(q [4]float64) [3]float64 {
	if q[3] < 0 {
		q = [4]float64{-q[0], -q[1], -q[2], -q[3]}
	}
	s := math.Sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2])
	if s < 1e-12 {
		return [3]float64{}
	}
	a := 2 * math.Atan2(s, q[3])
	return [3]float64{q[0] / s * a, q[1] / s * a, q[2] / s * a}
}

func qmul64(a, b [4]float64) [4]float64 {
	return [4]float64{
		a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
		a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
		a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
		a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
	}
}

// Swing-twist about the bone axis: bend (about the hinge axis), side bend and twist, in degrees.
func hingeParts(q [4]float32, bone, axis [3]float64) (bend, side, twist float64) {
	qq := [4]float64{float64(q[0]), float64(q[1]), float64(q[2]), float64(q[3])}
	p := qq[0]*bone[0] + qq[1]*bone[1] + qq[2]*bone[2]
	tw := [4]float64{p * bone[0], p * bone[1], p * bone[2], qq[3]}
	n := math.Sqrt(tw[0]*tw[0] + tw[1]*tw[1] + tw[2]*tw[2] + tw[3]*tw[3])
	if n < 1e-9 {
		tw = [4]float64{0, 0, 0, 1}
	} else {
		tw = [4]float64{tw[0] / n, tw[1] / n, tw[2] / n, tw[3] / n}
	}
	swing := qmul64(qq, [4]float64{-tw[0], -tw[1], -tw[2], tw[3]})
	sv, tv := quatRotvec(swing), quatRotvec(tw)
	b := sv[0]*axis[0] + sv[1]*axis[1] + sv[2]*axis[2]
	sx, sy, sz := sv[0]-b*axis[0], sv[1]-b*axis[1], sv[2]-b*axis[2]
	t := tv[0]*bone[0] + tv[1]*bone[1] + tv[2]*bone[2]
	deg := 180 / math.Pi
	return b * deg, math.Sqrt(sx*sx+sy*sy+sz*sz) * deg, t * deg
}

func anatomyHits(rotations []float32, skeleton skeletonDefinition) []anatomyHit {
	joints := len(skeleton.parents)
	if joints == 0 {
		return nil
	}
	frames := len(rotations) / (joints * 4)
	index := map[string]int{}
	for i, n := range skeleton.names {
		index[n] = i
	}
	rot := func(f, j int) [4]float32 {
		a := (f*joints + j) * 4
		return [4]float32{rotations[a], rotations[a+1], rotations[a+2], rotations[a+3]}
	}
	var hits []anatomyHit
	record := func(name string, over []float64) {
		h := anatomyHit{joint: name, frame: -1}
		for f, o := range over {
			if o > 0.5 {
				h.frames++
				if h.frame < 0 || o > h.over {
					h.frame, h.over = f, o
				}
			}
		}
		if h.frames > 0 {
			hits = append(hits, h)
		}
	}
	for name, lim := range anatomyLimits {
		j, ok := index[name]
		if !ok {
			continue
		}
		over := make([]float64, frames)
		for f := 0; f < frames; f++ {
			over[f] = quatAngleDeg(rot(f, j)) - lim
		}
		record(name, over)
	}
	for name, h := range anatomyHinges {
		j, ok := index[name]
		c, ok2 := index[h.child]
		if !ok || !ok2 {
			continue
		}
		o := skeleton.offsets[c]
		l := math.Sqrt(float64(o[0]*o[0] + o[1]*o[1] + o[2]*o[2]))
		bone := [3]float64{float64(o[0]) / l, float64(o[1]) / l, float64(o[2]) / l}
		over := make([]float64, frames)
		for f := 0; f < frames; f++ {
			bend, side, twist := hingeParts(rot(f, j), bone, h.axis)
			over[f] = math.Max(math.Max(bend-h.bend, -bend-h.back), math.Max(math.Abs(twist)-h.twist, side-h.sideMax))
		}
		record(name, over)
	}
	return hits
}

// The worst hit, for the Checks row: "neck folded 84° past its range at frame 68".
func worstAnatomy(hits []anatomyHit) (string, int, float64, int) {
	var best anatomyHit
	frames := 0
	for _, h := range hits {
		frames += h.frames
		if h.over > best.over {
			best = h
		}
	}
	if best.joint == "" {
		return "", 0, 0, 0
	}
	return best.joint, best.frame, math.Round(best.over), frames
}
