package main

import (
	"math"
	"sort"
)

// Ground contacts for the hands. A cartwheel, a handstand, a push-up or a roll puts the hands on
// the floor; the model often stops them a few centimetres short, which reads as floating. Every
// run of frames where a wrist dips below groundReach and comes back up is treated as a plant: the
// wrist is pulled to the floor (two-bone IK on that frame's arm, the same solver as the hand
// push-out), eased over ±3 frames. Hands that merely hang low while standing are left alone:
// a run only counts when the hand is the lowest it gets and the hips are low or the body is
// inverted (hips below the shoulders' rest height or the head below the hips).
const (
	groundReach  = 0.20  // a wrist within this of the floor is reaching for it
	groundWristY = 0.045 // wrist height when the palm is flat on the floor
	fingerClear  = 0.006 // the lowest finger joint stays this far above the floor

	groundPullFrom, groundPullFull = 0.14, 0.07 // the pull to the floor starts at 14 cm of wrist height, full at 7 cm
)

func groundHandsStreams(roots, rotations []float32, skeleton skeletonDefinition) ([]float32, []float32, int) {
	chains := armChains(skeleton)
	joints := len(skeleton.parents)
	if len(chains) == 0 || joints == 0 {
		return roots, rotations, 0
	}
	pos := forwardKinematics(roots, rotations, skeleton)
	frames := len(pos)
	if frames < 3 {
		return roots, rotations, 0
	}
	hips, head := -1, -1
	for j, n := range skeleton.names {
		switch n {
		case "Hips", "pelvis":
			hips = j
		case "Head", "head":
			head = j
		}
	}
	// the clip's own floor: the 5th percentile of foot height
	floor := float64(0)
	{
		var heights []float64
		for f := 0; f < frames; f++ {
			for j, n := range skeleton.names {
				if isFootJoint(n) {
					heights = append(heights, float64(pos[f][j][1]))
				}
			}
		}
		if len(heights) > 0 {
			sort.Float64s(heights)
			floor = heights[len(heights)/20]
		}
	}
	type key struct {
		frame int
		rot   [][4]float32
	}
	var keys []poseKey
	touched := 0
	for _, c := range chains {
		// runs where the wrist is within reach of the floor
		for f := 0; f < frames; {
			if float64(pos[f][c.wrist][1])-floor > groundReach {
				f++
				continue
			}
			end := f
			for end < frames && float64(pos[end][c.wrist][1])-floor <= groundReach {
				end++
			}
			// inverted or crouched somewhere in the run? (a hand swinging low while walking is not a plant)
			plant := false
			for g := f; g < end; g++ {
				if hips >= 0 && head >= 0 && float64(pos[g][head][1]) < float64(pos[g][hips][1])+0.1 {
					plant = true
				}
				if hips >= 0 && float64(pos[g][hips][1])-floor < 0.6 {
					plant = true
				}
			}
			if plant && end-f >= 2 {
				for g := f; g < end; g++ {
					w := pos[g][c.wrist]
					if float64(w[1]) <= floor+groundWristY+0.005 && handLowest(pos[g], c.wrist, skeleton) >= floor {
						continue
					}
					// the pull fades in with height: none at 14 cm, a full plant at 7 cm. Pulled all the way from 20 cm, a hand
					// reaching for something on the floor snapped down where the run began (fingertip pops of 5-13 cm on
					// every pick-up and some crouches, 2026-10-28)
					h := float64(w[1]) - floor
					a := math.Max(0, math.Min(1, (groundPullFrom-h)/(groundPullFrom-groundPullFull)))
					a = a * a * (3 - 2*a)
					if a <= 0 {
						continue
					}
					rot := frameRotations(rotations, joints, g)
					root := [3]float32{roots[g*3], roots[g*3+1], roots[g*3+2]}
					if a >= 1 {
						plantWrist(rot, root, skeleton, c, w, floor)
					} else {
						solveArm(rot, root, skeleton, c, [3]float64{float64(w[0]), float64(w[1]) - a*(float64(w[1])-floor-groundWristY), float64(w[2])})
					}
					k := poseKey{Frame: g, Root: []float32{root[0], root[1], root[2]}, Rotations: make([][]float32, joints)}
					for j := 0; j < joints; j++ {
						k.Rotations[j] = []float32{rot[j][0], rot[j][1], rot[j][2], rot[j][3]}
					}
					keys = append(keys, k)
					touched++
				}
			}
			f = end
		}
	}
	if len(keys) == 0 {
		return roots, rotations, 0
	}
	// keys from both hands on the same frame: merge (the later key's arm edits only touch its own arm, so
	// re-solving the second hand on top of the first keeps both)
	merged := map[int]*poseKey{}
	order := []int{}
	for i := range keys {
		k := keys[i]
		if m, ok := merged[k.Frame]; ok {
			// re-solve this hand on the merged frame so the other arm's edit survives
			rot := make([][4]float32, joints)
			for j := 0; j < joints; j++ {
				rot[j] = [4]float32{m.Rotations[j][0], m.Rotations[j][1], m.Rotations[j][2], m.Rotations[j][3]}
			}
			for _, c := range chains {
				w := pos[k.Frame][c.wrist]
				if float64(w[1])-floor > groundReach {
					continue
				}
				root := [3]float32{roots[k.Frame*3], roots[k.Frame*3+1], roots[k.Frame*3+2]}
				plantWrist(rot, root, skeleton, c, w, floor)
			}
			for j := 0; j < joints; j++ {
				m.Rotations[j] = []float32{rot[j][0], rot[j][1], rot[j][2], rot[j][3]}
			}
			continue
		}
		kk := k
		merged[k.Frame] = &kk
		order = append(order, k.Frame)
	}
	final := make([]poseKey, 0, len(order))
	for _, f := range order {
		final = append(final, *merged[f])
	}
	r, q, err := poseEditStreamsMulti(roots, rotations, joints, final, 3)
	if err != nil {
		return roots, rotations, 0
	}
	return r, q, len(order)
}

// The lowest point of a hand: the wrist and every joint below it (fingers), at one frame's positions.
func handLowest(pos [][3]float32, wrist int, skeleton skeletonDefinition) float64 {
	low := float64(pos[wrist][1])
	for j := range skeleton.parents {
		for a := j; a >= 0; a = skeleton.parents[a] {
			if a == wrist {
				low = math.Min(low, float64(pos[j][1]))
				break
			}
		}
	}
	return low
}

// Plant a wrist on the floor: two-bone IK to palm height, then raised until no finger is below the floor
// (a hand the model holds pointing down would otherwise push its fingers through the floor).
func plantWrist(rot [][4]float32, root [3]float32, skeleton skeletonDefinition, c armIK, w [3]float32, floor float64) {
	target := [3]float64{float64(w[0]), floor + groundWristY, float64(w[2])}
	for i := 0; i < 4; i++ {
		solveArm(rot, root, skeleton, c, target)
		pos, _ := fkFrame(root, rot, skeleton)
		deficit := floor + fingerClear - handLowest(pos, c.wrist, skeleton)
		if deficit <= 0.002 {
			return
		}
		target[1] += deficit
	}
}
