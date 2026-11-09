package main

import (
	"log"
	"math"
	"strings"
)

// Reach (Point mode, static/js/point.js): a hand pinned with reach:true lands exactly on its target. The model takes a
// hand pin as a strong hint rather than a law -- in tests the body arrived where it was pinned (root within 5 cm) but
// the hand stopped up to 18 cm short, the trunk leaning less than the pinned pose -- so after generation the wrist is
// moved onto the pinned pose's wrist with two-bone IK on each frame's own arm, and the hand turned as it was pinned.
// The hand is on the point for reachHold frames either side of the touch and eases on and off it over reachEase more,
// following its own path, so the reach keeps its own arc and timing.
//
// from, dx and dz map the pin onto streams trimmed after generation: the pin's frame is from frames later than the
// trimmed clip's, and its position dx, dz further along X and Z if the trim re-zeroed the start (trimStreams; a clip
// with a reach pin keeps its frame, main.go, so for those they are 0).
const reachHold, reachEase = 2, 12

// The most the shoulder blade and the chest give to a reach the arm alone cannot make (radians).
const reachClavicle, reachChest = 20 * math.Pi / 180, 15 * math.Pi / 180

func reachStreams(roots, rotations []float32, sk skeletonDefinition, constraints []motionConstraint, from int, dx, dz float32) ([]float32, []float32, int) {
	joints, frames := len(sk.parents), len(roots)/3
	arms := armChains(sk)
	touched := 0
	for _, c := range constraints {
		if !c.Reach || c.Type != "end-effector" || len(c.FrameIndices) != 1 || len(c.RootPositions) < 1 || len(c.LocalJointsRotXYZW) < 1 || len(c.LocalJointsRotXYZW[0]) != joints {
			continue
		}
		F := c.FrameIndices[0] - from
		if F < 0 || F >= frames {
			continue
		}
		pinRoot := [3]float32{float32(c.RootPositions[0][0]) - dx, float32(c.RootPositions[0][1]), float32(c.RootPositions[0][2]) - dz}
		pinRot := make([][4]float32, joints)
		for j, r := range c.LocalJointsRotXYZW[0] {
			if len(r) == 4 {
				pinRot[j] = [4]float32{float32(r[0]), float32(r[1]), float32(r[2]), float32(r[3])}
			}
		}
		pinPos, pinG := fkFrame(pinRoot, pinRot, sk)
		for _, name := range c.JointNames {
			var arm *armIK
			for i := range arms {
				if sk.names[arms[i].wrist] == name {
					arm = &arms[i]
				}
			}
			if arm == nil {
				if leg, ok := legChain(sk, name); ok {
					touched += plantFoot(roots, rotations, sk, leg, F, hF64(pinPos[leg.wrist]), pinG[leg.wrist])
				}
				continue
			}
			target := hF64(pinPos[arm.wrist])
			rootAt := func(f int) [3]float32 { return [3]float32{roots[f*3], roots[f*3+1], roots[f*3+2]} }
			P, _ := fkFrame(rootAt(F), frameRotations(rotations, joints, F), sk)
			delta := v3sub(target, hF64(P[arm.wrist]))
			before := v3len(delta)
			// Out of the arm's reach (the trunk came out more upright than pinned): the shoulder blade comes forward and the
			// chest leans in, the least of both that reaches, worked out on the touch frame and eased like the rest.
			clav := sk.parents[arm.upper]
			chest := -1
			if clav >= 0 {
				chest = sk.parents[clav]
			}
			axisAt := func(j int) [3]float64 {
				if j < 0 {
					return [3]float64{}
				}
				return v3cross(v3sub(hF64(P[arm.upper]), hF64(P[j])), v3sub(target, hF64(P[j])))
			}
			assists := []struct {
				j    int
				axis [3]float64
				max  float64
			}{{clav, axisAt(clav), reachClavicle}, {chest, axisAt(chest), reachChest}}
			assist := func(rot [][4]float32, root [3]float32, s float64) {
				for _, a := range assists {
					if a.j < 0 || sk.parents[a.j] < 0 || v3len(a.axis) < 1e-6 || s <= 0 {
						continue
					}
					_, G := fkFrame(root, rot, sk)
					rot[a.j] = qnorm(mulQuat(qConj(G[sk.parents[a.j]]), mulQuat(qAxisAngle(a.axis, a.max*s), G[a.j])))
				}
			}
			short := func(s float64) float64 {
				rot := frameRotations(rotations, joints, F)
				assist(rot, rootAt(F), s)
				solveArm(rot, rootAt(F), sk, *arm, target)
				Pa, _ := fkFrame(rootAt(F), rot, sk)
				return v3len(v3sub(target, hF64(Pa[arm.wrist])))
			}
			need := 0.0
			if short(0) > 0.005 {
				need = 1
				if short(1) <= 0.005 {
					lo, hi := 0.0, 1.0
					for i := 0; i < 12; i++ {
						if m := (lo + hi) / 2; short(m) > 0.005 {
							lo = m
						} else {
							hi = m
						}
					}
					need = hi
				}
			}
			edge := func(f int) [3]float64 {
				f = max(0, min(frames-1, f))
				Pe, _ := fkFrame(rootAt(f), frameRotations(rotations, joints, f), sk)
				return v3sub(target, hF64(Pe[arm.wrist]))
			}
			deltaIn, deltaOut := edge(F-reachHold), edge(F+reachHold)
			for f := max(0, F-reachHold-reachEase); f <= min(frames-1, F+reachHold+reachEase); f++ {
				w := 1.0
				if d := abs(f-F) - reachHold; d > 0 {
					t := 1 - float64(d)/float64(reachEase+1)
					w = t * t * (3 - 2*t)
				}
				rot := frameRotations(rotations, joints, f)
				Pf, _ := fkFrame(rootAt(f), rot, sk)
				assist(rot, rootAt(f), need*w)
				// on the point through the hold (an offset that followed the body let the hand sink 2 cm into the floor as it
				// went on down); either side, the hold's edge offset fading along the hand's own path (pulled toward the point
				// itself, the hand stretched the arm straight as the body rose with the object, stalled and popped)
				goal := target
				if f < F-reachHold {
					goal = v3add(hF64(Pf[arm.wrist]), v3scale(deltaIn, w))
				} else if f > F+reachHold {
					goal = v3add(hF64(Pf[arm.wrist]), v3scale(deltaOut, w))
				}
				solveArm(rot, rootAt(f), sk, *arm, goal)
				// and the hand turns as it was pinned (palm down for a point on the floor), eased the same way
				_, G := fkFrame(rootAt(f), rot, sk)
				rot[arm.wrist] = qnorm(mulQuat(qConj(G[sk.parents[arm.wrist]]), slerp(G[arm.wrist], pinG[arm.wrist], float32(w))))
				for _, j := range []int{arm.upper, arm.lower, arm.wrist, clav, chest} {
					if j < 0 {
						continue
					}
					copy(rotations[(f*joints+j)*4:(f*joints+j)*4+4], rot[j][:])
				}
				touched++
			}
			P, _ = fkFrame(rootAt(F), frameRotations(rotations, joints, F), sk)
			log.Printf("reach: %s at frame %d, %.1f cm off before, %.1f cm after (shoulder and chest %.0f%%)", name, F+1, before*100, v3len(v3sub(target, hF64(P[arm.wrist])))*100, need*100)
		}
	}
	return roots, rotations, touched
}

// A Point reach starts from standing: the walk or turn up to the point is the move. The page's standing start is off by
// default and a pinned clip gets no pre-roll, so with only the reach pinned the first frames were free and the model
// began on the floor -- it crawled the whole clip to a pinned floor pickup (2026-11-01). A walk opens with the planned
// first steps (walkStartConstraints: standing, then the hips and feet keyed for two steps, the arms free) when they end
// well before the touch; anything else with the standing start.
func (g *gallery) reachStart(skeletonKey, prompt string, frames int, cs []motionConstraint) []motionConstraint {
	firstTouch := -1
	for _, c := range cs {
		for _, f := range c.FrameIndices {
			if f < 4 {
				return cs // the first frames are pinned already
			}
		}
		if c.Reach && len(c.FrameIndices) > 0 && (firstTouch < 0 || c.FrameIndices[0] < firstTouch) {
			firstTouch = c.FrameIndices[0]
		}
	}
	if firstTouch < 0 {
		return cs
	}
	if wc := g.walkStartConstraints(skeletonKey, prompt, frames); wc != nil {
		last := 0
		for _, c := range wc {
			for _, f := range c.FrameIndices {
				last = max(last, f)
			}
		}
		if last+10 < firstTouch {
			log.Printf("reach start: planned first steps (to frame %d) before the touch at %d", last+1, firstTouch+1)
			return append(wc, cs...)
		}
	}
	// always standing: the pin's stance is planned from a standing body, and the start-low words misread the object
	// ("a small step toward an object on the floor" was taken for a person starting on the floor; the clip began mid-step)
	if c, ok := g.standingStart(skeletonKey, "a person stands", cs); ok {
		log.Printf("reach start: standing")
		return append([]motionConstraint{c}, cs...)
	}
	return cs
}

func hasReach(cs []motionConstraint) bool {
	for _, c := range cs {
		if c.Reach {
			return true
		}
	}
	return false
}

// shiftXZ moves a root stream along X and Z (undoes trimStreams' re-zeroing).
func shiftXZ(roots []float32, dx, dz float32) []float32 {
	for f := 0; f*3 < len(roots); f++ {
		roots[f*3] += dx
		roots[f*3+2] += dz
	}
	return roots
}

// lastPinnedFrame: the last frame any constraint pins, or -1.
func lastPinnedFrame(cs []motionConstraint) int {
	last := -1
	for _, c := range cs {
		for _, f := range c.FrameIndices {
			last = max(last, f)
		}
	}
	return last
}

// A foot pinned to a point plants there: a hand touches for a moment, a foot carries weight. The window is the run of
// frames around the pinned one where the generated foot is down and slow (the model's own footfall, however long), at
// least the hold; the ankle is on the point through it, the sole turned as pinned, and it eases on and off over
// footEase frames along the foot's own path. Without this the model put the foot within 0-6 cm of the mark but, in 2 of
// 3 takes, still moving through it (28-49 cm/s).
const footEase, footReach = 8, 20

func legChain(sk skeletonDefinition, foot string) (armIK, bool) {
	side := strings.TrimSuffix(foot, "Foot")
	if side == foot {
		return armIK{}, false
	}
	u, l, w := -1, -1, -1
	for i, n := range sk.names {
		switch n {
		case side + "Leg":
			u = i
		case side + "Shin":
			l = i
		case foot:
			w = i
		}
	}
	return armIK{upper: u, lower: l, wrist: w}, u >= 0 && l >= 0 && w >= 0
}

func plantFoot(roots, rotations []float32, sk skeletonDefinition, leg armIK, F int, target [3]float64, turn [4]float32) int {
	joints, frames := len(sk.parents), len(roots)/3
	rootAt := func(f int) [3]float32 { return [3]float32{roots[f*3], roots[f*3+1], roots[f*3+2]} }
	ankle := make([][3]float64, frames)
	for f := range ankle {
		P, _ := fkFrame(rootAt(f), frameRotations(rotations, joints, f), sk)
		ankle[f] = hF64(P[leg.wrist])
	}
	down := func(f int) bool {
		if f <= 0 || f >= frames-1 {
			return false
		}
		step := math.Hypot(ankle[f+1][0]-ankle[f-1][0], ankle[f+1][2]-ankle[f-1][2]) / 2
		return ankle[f][1] < target[1]+0.04 && step < 0.5/30
	}
	a, b := F-reachHold, F+reachHold
	for a > max(0, F-footReach) && down(a-1) {
		a--
	}
	for b < min(frames-1, F+footReach) && down(b+1) {
		b++
	}
	a, b = max(0, a), min(frames-1, b)
	deltaIn, deltaOut := v3sub(target, ankle[a]), v3sub(target, ankle[b])
	before := v3len(v3sub(target, ankle[F]))
	n := 0
	for f := max(0, a-footEase); f <= min(frames-1, b+footEase); f++ {
		w, goal := 1.0, target
		if f < a || f > b {
			d := a - f
			if f > b {
				d = f - b
			}
			t := 1 - float64(d)/float64(footEase+1)
			w = t * t * (3 - 2*t)
			if f < a {
				goal = v3add(ankle[f], v3scale(deltaIn, w))
			} else {
				goal = v3add(ankle[f], v3scale(deltaOut, w))
			}
		}
		rot := frameRotations(rotations, joints, f)
		solveLeg(rot, rootAt(f), sk, leg, goal)
		_, G := fkFrame(rootAt(f), rot, sk)
		rot[leg.wrist] = qnorm(mulQuat(qConj(G[sk.parents[leg.wrist]]), slerp(G[leg.wrist], turn, float32(w))))
		for _, j := range []int{leg.upper, leg.lower, leg.wrist} {
			copy(rotations[(f*joints+j)*4:(f*joints+j)*4+4], rot[j][:])
		}
		n++
	}
	P, _ := fkFrame(rootAt(F), frameRotations(rotations, joints, F), sk)
	log.Printf("reach: %s planted frames %d-%d (pinned %d), %.1f cm off before, %.1f cm after", sk.names[leg.wrist], a+1, b+1, F+1, before*100, v3len(v3sub(target, hF64(P[leg.wrist])))*100)
	return n
}

// solveLeg: two-bone IK like solveArm, with a knee that always bends forward. A walking leg is often nearly straight,
// and the bend axis taken from so slight a bend can point either way; then the axis comes from the pelvis instead.
func solveLeg(rot [][4]float32, root [3]float32, sk skeletonDefinition, c armIK, target [3]float64) {
	P, G := fkFrame(root, rot, sk)
	A, B, C := hF64(P[c.upper]), hF64(P[c.lower]), hF64(P[c.wrist])
	l1, l2 := v3len(v3sub(B, A)), v3len(v3sub(C, B))
	if l1 < 1e-6 || l2 < 1e-6 {
		return
	}
	d := math.Max(math.Abs(l1-l2)+1e-4, math.Min(l1+l2-1e-4, v3len(v3sub(target, A))))
	a0 := math.Acos(hClamp(v3dot(v3norm(v3sub(A, B)), v3norm(v3sub(C, B)))))
	a1 := math.Acos(hClamp((l1*l1 + l2*l2 - d*d) / (2 * l1 * l2)))
	axis := v3cross(v3sub(B, A), v3sub(C, B))
	if v3len(axis) < 0.1*l1*l2 {
		pelvis := 0
		for j, p := range sk.parents {
			if p < 0 {
				pelvis = j
			}
		}
		back := v3scale(hF64(rotateVec(G[pelvis], [3]float32{0, 0, 1})), -1)
		axis = v3cross(v3sub(B, A), back)
	}
	if v3len(axis) < 1e-9 {
		return
	}
	rot[c.lower] = qnorm(mulQuat(qConj(G[sk.parents[c.lower]]), mulQuat(qAxisAngle(axis, a0-a1), G[c.lower])))
	P, G = fkFrame(root, rot, sk)
	from, to := v3norm(v3sub(hF64(P[c.wrist]), A)), v3norm(v3sub(target, A))
	if ang := math.Acos(hClamp(v3dot(from, to))); ang > 1e-5 {
		rot[c.upper] = qnorm(mulQuat(qConj(G[sk.parents[c.upper]]), mulQuat(qAxisAngle(v3cross(from, to), ang), G[c.upper])))
	}
}
