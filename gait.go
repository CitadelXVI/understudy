package main

// Gait checks: what a person sees at once and the older numbers missed (owner, 2026-10-27: "Foot sliding", "unnatural
// turn around where the person isn't actually making a genuine turning gesture").
//
//   slide  a foot that is down (its toe at floor level) and still travels along the floor: a glide instead of a step.
//          Measured per contact as the toe's net travel; a real step's toe moves under 2 cm while it is down.
//   pivot  the hips turning while neither foot lifts, or spinning flat on one weighted foot like a turntable while
//          the other foot skims low: nobody turns their body without stepping cleanly; the model sometimes spins the
//          body on planted feet or twists a flat foot >90° on the floor.
//
// Both use the toe joints (the ankle sits 8 cm up even when standing). "Down" is the toe within 1.5 cm of its own rest
// height in this clip (the 5th percentile) and not rising or dropping, for at least 4 frames.

import "math"

const (
	gaitDownAbove  = 0.015 // a toe within this of its rest height is down (3 cm let the start of a swing count: the toe skims low)
	gaitStillRise  = 0.004 // ...and not moving up or down more than this per frame (a toe rolling off the floor is leaving it)
	gaitMinRun     = 5     // frames in a row to count as a contact
	slideFlagM     = 0.04  // net toe travel during one contact that reads as a slide (3 cm flagged a settle's last shuffle)...
	slideSlowMps   = 0.02  // ...when it is at least this fast (3 cm over five seconds is not seen); any slide past slideCleanUpM counts
	pivotFlagDeg   = 60.0  // hips turn on planted feet that reads as a pivot (45° caught the hip twist of a punch; a turn-around is 90° or more)
	pivotStandingM = 0.6   // ...judged only while standing (hips above this): seated, the weight is on the seat, not the feet
	slideCleanUpM  = 0.08  // up to this Clean up's foot lock puts right; beyond it the stretch needs regenerating
	gaitEdgeFrames = 1     // strike and lift frames are not judged
	pivotMinFrames = 4
	spinDownAbove  = 0.028 // a weighted spinning toe can wobble up to ~2.8 cm above rest while staying planted...
	spinStillRise  = 0.012 // ...without lifting cleanly into a step
	spinOtherLowM  = 0.12  // ...while the other foot skims low (excludes roundhouse/high kicks where a support pivot is real)
	spinUprightCos = 0.80  // trunk within ~37° of vertical (excludes floor/inverted moves)
	spinMinFrames  = 5
)

type gaitSlide struct {
	Side string // Left / Right
	From int    // frames, 0-based (From..To inclusive)
	To   int
	NetM float64
}

type gaitResult struct {
	slides             []gaitSlide
	worst              gaitSlide
	pivotDeg           float64
	pivotFrom, pivotTo int
}

func toeJoints(skeleton skeletonDefinition) (left, right int) {
	left, right = -1, -1
	for i, n := range skeleton.names {
		switch n {
		case "LeftToeBase", "left_foot", "left_ankle_roll_skel":
			left = i
		case "RightToeBase", "right_foot", "right_ankle_roll_skel":
			right = i
		}
	}
	return
}

func spinJoints(skeleton skeletonDefinition) (leftFoot, rightFoot, hips, chest int) {
	leftFoot, rightFoot, hips, chest = -1, -1, -1, -1
	for i, n := range skeleton.names {
		switch n {
		case "LeftFoot", "left_ankle":
			leftFoot = i
		case "RightFoot", "right_ankle":
			rightFoot = i
		case "Hips", "pelvis":
			hips = i
		case "Chest", "spine3":
			chest = i
		}
	}
	return
}

func wrapRad(d float64) float64 {
	for d > math.Pi {
		d -= 2 * math.Pi
	}
	for d < -math.Pi {
		d += 2 * math.Pi
	}
	return d
}

// toeDown: per frame, whether a toe is at its rest height (the clip's own floor for that toe).
func toeDown(pos [][][3]float32, j int) []bool {
	frames := len(pos)
	hs := make([]float64, frames)
	for f := range pos {
		hs[f] = float64(pos[f][j][1])
	}
	sorted := append([]float64(nil), hs...)
	sortFloats(sorted)
	rest := sorted[len(sorted)/20]
	down := make([]bool, frames)
	for f := range hs {
		still := f == 0 || math.Abs(hs[f]-hs[f-1]) <= gaitStillRise
		down[f] = hs[f] <= rest+gaitDownAbove && still
	}
	return down
}

func sortFloats(a []float64) {
	// insertion sort is fine for a few hundred values and keeps this file free of imports beyond math
	for i := 1; i < len(a); i++ {
		for k := i; k > 0 && a[k] < a[k-1]; k-- {
			a[k], a[k-1] = a[k-1], a[k]
		}
	}
}

func hipsYaw(roots, rotations []float32, joints, f int) float64 {
	q := [4]float64{float64(rotations[(f*joints)*4]), float64(rotations[(f*joints)*4+1]), float64(rotations[(f*joints)*4+2]), float64(rotations[(f*joints)*4+3])}
	// the hips' forward (+Z) on the floor
	fx := 2 * (q[0]*q[2] + q[1]*q[3])
	fz := 1 - 2*(q[0]*q[0]+q[1]*q[1])
	return math.Atan2(fx, fz)
}

func gaitChecks(pos [][][3]float32, roots, rotations []float32, skeleton skeletonDefinition) gaitResult {
	res := gaitResult{pivotFrom: -1, pivotTo: -1}
	lt, rt := toeJoints(skeleton)
	if lt < 0 || rt < 0 || len(pos) < gaitMinRun+2 {
		return res
	}
	frames := len(pos)
	down := map[string][]bool{"Left": toeDown(pos, lt), "Right": toeDown(pos, rt)}
	toe := map[string]int{"Left": lt, "Right": rt}
	for _, side := range []string{"Left", "Right"} {
		d, j := down[side], toe[side]
		for f := 0; f < frames; {
			if !d[f] {
				f++
				continue
			}
			end := f
			for end < frames && d[end] {
				end++
			}
			if end-f >= gaitMinRun {
				a, b := f+gaitEdgeFrames, end-1-gaitEdgeFrames
				net := math.Hypot(float64(pos[b][j][0]-pos[a][j][0]), float64(pos[b][j][2]-pos[a][j][2]))
				speed := net / (float64(b-a+1) / fps)
				if net > slideFlagM && (speed >= slideSlowMps || net > slideCleanUpM) {
					s := gaitSlide{Side: side, From: a, To: b, NetM: net}
					res.slides = append(res.slides, s)
					if net > res.worst.NetM {
						res.worst = s
					}
				}
			}
			f = end
		}
	}
	// pivot: the hips' heading change over a run where both toes stay down
	joints := len(skeleton.parents)
	for f := 0; f < frames; {
		standing := func(k int) bool { return float64(roots[k*3+1]) > pivotStandingM }
		if !(down["Left"][f] && down["Right"][f] && standing(f)) {
			f++
			continue
		}
		end := f
		for end < frames && down["Left"][end] && down["Right"][end] && standing(end) {
			end++
		}
		if end-f >= pivotMinFrames {
			total, prev, extreme := 0.0, hipsYaw(roots, rotations, joints, f), 0.0
			peakAt := f
			for k := f + 1; k < end; k++ {
				y := hipsYaw(roots, rotations, joints, k)
				total += wrapRad(y - prev)
				prev = y
				if math.Abs(total) > extreme {
					extreme, peakAt = math.Abs(total), k
				}
			}
			if deg := extreme * 180 / math.Pi; deg > res.pivotDeg {
				res.pivotDeg, res.pivotFrom, res.pivotTo = deg, f, peakAt
			}
		}
		f = end
	}
	// single-foot flat spin: one weighted foot twists on the floor together with the hips while the other foot skims
	// low instead of stepping cleanly (r4 turn takes spun 112-129° on one foot while hover-shuffling the other, 4-5/10)
	lf, rf, hips, chest := spinJoints(skeleton)
	if lf >= 0 && rf >= 0 && hips >= 0 && chest >= 0 && lf != lt && rf != rt {
		toeRest := func(j int) float64 {
			hs := make([]float64, frames)
			for f := range pos {
				hs[f] = float64(pos[f][j][1])
			}
			sortFloats(hs)
			return hs[len(hs)/20]
		}
		footYaw := func(jFoot, jToe, k int) float64 {
			dx := float64(pos[k][jToe][0] - pos[k][jFoot][0])
			dz := float64(pos[k][jToe][2] - pos[k][jFoot][2])
			return math.Atan2(dx, dz)
		}
		upright := func(k int) bool {
			if float64(roots[k*3+1]) <= pivotStandingM {
				return false
			}
			sx := float64(pos[k][chest][0] - pos[k][hips][0])
			sy := float64(pos[k][chest][1] - pos[k][hips][1])
			sz := float64(pos[k][chest][2] - pos[k][hips][2])
			sl := math.Sqrt(sx*sx + sy*sy + sz*sz)
			return sl > 1e-6 && sy/sl > spinUprightCos
		}
		rl, rr := toeRest(lt), toeRest(rt)
		type leg struct {
			jToe, jFoot, jOther int
			rToe, rOther        float64
		}
		for _, g := range []leg{{lt, lf, rt, rl, rr}, {rt, rf, lt, rr, rl}} {
			flat := make([]bool, frames)
			for k := 0; k < frames; k++ {
				ht := float64(pos[k][g.jToe][1])
				still := k == 0 || math.Abs(ht-float64(pos[k-1][g.jToe][1])) <= spinStillRise
				ho := float64(pos[k][g.jOther][1])
				flat[k] = ht <= g.rToe+spinDownAbove && still && upright(k) && ho <= g.rOther+spinOtherLowM
			}
			for f := 0; f < frames; {
				if !flat[f] {
					f++
					continue
				}
				end := f
				for end < frames && flat[end] {
					end++
				}
				if end-f >= spinMinFrames {
					tf, th := 0.0, 0.0
					pf, ph := footYaw(g.jFoot, g.jToe, f), hipsYaw(roots, rotations, joints, f)
					extreme, peakAt := 0.0, f
					for k := f + 1; k < end; k++ {
						yf := footYaw(g.jFoot, g.jToe, k)
						yh := hipsYaw(roots, rotations, joints, k)
						tf += wrapRad(yf - pf)
						th += wrapRad(yh - ph)
						pf, ph = yf, yh
						if tf*th > 0 {
							same := math.Min(math.Abs(tf), math.Abs(th))
							if same > extreme {
								extreme, peakAt = same, k
							}
						}
					}
					if deg := extreme * 180 / math.Pi; deg > res.pivotDeg {
						res.pivotDeg, res.pivotFrom, res.pivotTo = deg, f, peakAt
					}
				}
				f = end
			}
		}
	}
	return res
}
