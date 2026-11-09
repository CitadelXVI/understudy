package main

import (
	"math"
	"strings"
)

// Clean hands: on every frame where a hand sinks into the head, the wrist is moved
// just outside the skull with two-bone IK on that frame's own arm, and the change
// is eased over ±4 frames. It is the bake the Handles bar's "Fix hand-in-head"
// does, run on the server so it can happen right after generation: a clip badged
// clean is then clean on the body, not only below a threshold.

type armIK struct {
	upper, lower, wrist int
	hand, head          bodyPart
}

func armChains(skeleton skeletonDefinition) []armIK {
	parts := partsOf(skeleton)
	var head *bodyPart
	for i := range parts {
		if parts[i].name == "head" {
			head = &parts[i]
		}
	}
	if head == nil {
		return nil
	}
	index := map[string]int{}
	for i, n := range skeleton.names {
		index[strings.ToLower(n)] = i
	}
	find := func(names ...string) int {
		for _, n := range names {
			if i, ok := index[strings.ToLower(n)]; ok {
				return i
			}
		}
		return -1
	}
	var out []armIK
	for _, side := range []struct{ pre, post string }{{"Left", "left_"}, {"Right", "right_"}} {
		u, l, w := find(side.pre+"Arm", side.post+"shoulder"), find(side.pre+"ForeArm", side.post+"elbow"), find(side.pre+"Hand", side.post+"wrist")
		if u < 0 || l < 0 || w < 0 {
			continue
		}
		for _, p := range parts {
			if p.name == side.pre+" hand" {
				out = append(out, armIK{u, l, w, p, *head})
			}
		}
	}
	return out
}

func hF64(v [3]float32) [3]float64               { return [3]float64{float64(v[0]), float64(v[1]), float64(v[2])} }
func v3sub(a, b [3]float64) [3]float64           { return [3]float64{a[0] - b[0], a[1] - b[1], a[2] - b[2]} }
func v3add(a, b [3]float64) [3]float64           { return [3]float64{a[0] + b[0], a[1] + b[1], a[2] + b[2]} }
func v3scale(a [3]float64, k float64) [3]float64 { return [3]float64{a[0] * k, a[1] * k, a[2] * k} }
func v3dot(a, b [3]float64) float64              { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] }
func v3len(a [3]float64) float64                 { return math.Sqrt(v3dot(a, a)) }
func v3cross(a, b [3]float64) [3]float64 {
	return [3]float64{a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]}
}
func v3norm(a [3]float64) [3]float64 {
	n := v3len(a)
	if n < 1e-12 {
		return a
	}
	return v3scale(a, 1/n)
}
func hClamp(x float64) float64      { return math.Max(-1, math.Min(1, x)) }
func qConj(q [4]float32) [4]float32 { return [4]float32{-q[0], -q[1], -q[2], q[3]} }
func qAxisAngle(axis [3]float64, angle float64) [4]float32 {
	a := v3norm(axis)
	s, c := math.Sin(angle/2), math.Cos(angle/2)
	return [4]float32{float32(a[0] * s), float32(a[1] * s), float32(a[2] * s), float32(c)}
}

// One frame's local rotations as quaternions.
func frameRotations(rotations []float32, joints, f int) [][4]float32 {
	out := make([][4]float32, joints)
	for j := 0; j < joints; j++ {
		at := (f*joints + j) * 4
		out[j] = [4]float32{rotations[at], rotations[at+1], rotations[at+2], rotations[at+3]}
	}
	return out
}

// Forward kinematics of one frame: world positions and global rotations.
func fkFrame(root [3]float32, rot [][4]float32, skeleton skeletonDefinition) ([][3]float32, [][4]float32) {
	joints := len(skeleton.parents)
	pos, global := make([][3]float32, joints), make([][4]float32, joints)
	for j := 0; j < joints; j++ {
		p := skeleton.parents[j]
		if p < 0 {
			global[j], pos[j] = rot[j], root
			continue
		}
		global[j] = mulQuat(global[p], rot[j])
		o := rotateVec(global[p], skeleton.offsets[j])
		pos[j] = [3]float32{pos[p][0] + o[0], pos[p][1] + o[1], pos[p][2] + o[2]}
	}
	return pos, global
}

// Two-bone IK, the same as the Handles bar: bend the elbow to the right length,
// then aim the upper arm so the wrist lands on the target.
func solveArm(rot [][4]float32, root [3]float32, skeleton skeletonDefinition, c armIK, target [3]float64) {
	P, G := fkFrame(root, rot, skeleton)
	A, B, C := hF64(P[c.upper]), hF64(P[c.lower]), hF64(P[c.wrist])
	l1, l2 := v3len(v3sub(B, A)), v3len(v3sub(C, B))
	if l1 < 1e-6 || l2 < 1e-6 {
		return
	}
	d := math.Max(math.Abs(l1-l2)+1e-4, math.Min(l1+l2-1e-4, v3len(v3sub(target, A))))
	a0 := math.Acos(hClamp(v3dot(v3norm(v3sub(A, B)), v3norm(v3sub(C, B)))))
	a1 := math.Acos(hClamp((l1*l1 + l2*l2 - d*d) / (2 * l1 * l2)))
	axis := v3cross(v3sub(B, A), v3sub(C, B))
	if v3len(axis) < 1e-6 {
		axis = v3cross(v3sub(B, A), [3]float64{0, 1, 0})
	}
	if v3len(axis) < 1e-6 {
		axis = [3]float64{1, 0, 0}
	}
	bend := qAxisAngle(axis, a0-a1)
	pl := skeleton.parents[c.lower]
	rot[c.lower] = qnorm(mulQuat(qConj(G[pl]), mulQuat(bend, G[c.lower])))
	P, G = fkFrame(root, rot, skeleton)
	from, to := v3norm(v3sub(hF64(P[c.wrist]), A)), v3norm(v3sub(target, A))
	ang := math.Acos(hClamp(v3dot(from, to)))
	if ang > 1e-5 {
		aim := qAxisAngle(v3cross(from, to), ang)
		pu := skeleton.parents[c.upper]
		rot[c.upper] = qnorm(mulQuat(qConj(G[pu]), mulQuat(aim, G[c.upper])))
	}
}

// Push every hand out of the head on every frame it sinks in (up to three passes,
// since a pushed hand can still graze), eased over ±4 frames. Returns the streams
// and how many frames were touched on the first pass.
func cleanHandsStreams(roots, rotations []float32, skeleton skeletonDefinition) ([]float32, []float32, int) {
	chains := armChains(skeleton)
	joints := len(skeleton.parents)
	if len(chains) == 0 || joints == 0 {
		return roots, rotations, 0
	}
	frames := len(roots) / 3
	fixed := 0
	for pass := 0; pass < 3; pass++ {
		pos := forwardKinematics(roots, rotations, skeleton)
		var keys []poseKey
		for f := 0; f < len(pos) && f < frames; f++ {
			frame := pos[f]
			var rot [][4]float32
			root := [3]float32{roots[f*3], roots[f*3+1], roots[f*3+2]}
			for _, c := range chains {
				h0, h1 := frame[c.head.a], capsuleEnd(frame, c.head)
				d := segmentDistance(frame[c.hand.a], capsuleEnd(frame, c.hand), h0, h1)
				depth := c.hand.radius + c.head.radius - d
				if depth <= clipDepth {
					continue
				}
				if rot == nil {
					rot = frameRotations(rotations, joints, f)
				}
				// straight away from the skull axis by the overlap, plus a centimetre of air
				w, a0 := hF64(frame[c.wrist]), hF64(h0)
				ax := v3sub(hF64(h1), a0)
				t := math.Max(0, math.Min(1, v3dot(v3sub(w, a0), ax)/math.Max(v3dot(ax, ax), 1e-9)))
				away := v3sub(w, v3add(a0, v3scale(ax, t)))
				n := v3len(away)
				if n < 1e-6 {
					away, n = [3]float64{0, 0, 1}, 1
				}
				target := v3add(w, v3scale(away, (depth+0.01)/n))
				solveArm(rot, root, skeleton, c, target)
			}
			if rot != nil {
				k := poseKey{Frame: f, Root: []float32{root[0], root[1], root[2]}, Rotations: make([][]float32, joints)}
				for j := 0; j < joints; j++ {
					k.Rotations[j] = []float32{rot[j][0], rot[j][1], rot[j][2], rot[j][3]}
				}
				keys = append(keys, k)
			}
		}
		if len(keys) == 0 {
			break
		}
		if pass == 0 {
			fixed = len(keys)
		}
		r, q, err := poseEditStreamsMulti(roots, rotations, joints, keys, 4)
		if err != nil {
			break
		}
		roots, rotations = r, q
	}
	return roots, rotations, fixed
}
