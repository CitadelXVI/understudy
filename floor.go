package main

import (
	"math"
	"sort"
	"strings"
)

// Ground the feet. Kimodo's post-processing pins the clip's lowest foot to the floor once, so a clip
// that rolls on the ground and stands up again ends hovering: the standing frames keep the roll's
// offset. This pass finds the frames where a foot is planted (still in the horizontal plane and not
// rising) and lowers the root so that foot touches the floor; between planted runs the shift is
// interpolated and the whole curve is smoothed, so the body comes down over the landing rather than
// snapping. Nothing is ever pushed below the floor.
//
// The floor is the one the stage draws: the 5th percentile of the toe joints (where a standing clip's
// toes rest). A planted toe goes exactly onto it; a planted ankle goes its rest height above the toe.
const (
	plantStill  = 0.012 // horizontal travel per frame under which a foot counts as planted
	plantVert   = 0.006 // vertical travel per frame under which a foot counts as planted
	minShift    = 0.008 // shifts smaller than this are left alone (the generator's own noise)
	floorSmooth = 7     // half-width of the smoothing window, frames
	ankleAbove  = 0.05  // a planted ankle's height over its toe when the skeleton has no toe offset to read
)

// How far above the floor a foot joint sits when its foot is flat: 0 for a toe, the toe's rest drop for an ankle.
func plantedHeight(skeleton skeletonDefinition, j int) float64 {
	if strings.Contains(strings.ToLower(skeleton.names[j]), "toe") {
		return 0
	}
	for k, p := range skeleton.parents {
		if p == j && strings.Contains(strings.ToLower(skeleton.names[k]), "toe") && k < len(skeleton.offsets) {
			if d := -float64(skeleton.offsets[k][1]); d > 0.01 && d < 0.15 {
				return d
			}
		}
	}
	return ankleAbove
}

// The clip's floor as the stage draws it: where planted toes stand (toe joints on frames they are still and low;
// the median), so a few frames of toes pushed through the floor do not drag the floor down with them. Falls back to
// the 5th percentile of the toe joints (foot joints when there are no toes). tools/cleanup/contact.py uses the same.
// Kimodo's world floor for the SOMA skeleton, measured: across ~140 clips the body's lowest surface rests at
// 1.8-2.0 cm (standing soles, lying backs). A floor guessed from each clip's feet fails exactly where it matters
// (kneeling and lying clips, toes pushed through the floor), so SOMA clips use this.
var nominalFloor = map[string]float64{"soma30": 0.02}

func clipFloor(pos [][][3]float32, skeleton skeletonDefinition) float64 {
	if f, ok := nominalFloor[skeleton.key]; ok {
		return f
	}
	var toes, feet []int
	for j, n := range skeleton.names {
		if !isFootJoint(n) {
			continue
		}
		feet = append(feet, j)
		if strings.Contains(strings.ToLower(n), "toe") {
			toes = append(toes, j)
		}
	}
	use := toes
	if len(use) == 0 {
		use = feet
	}
	if len(use) == 0 || len(pos) == 0 {
		return 0
	}
	var all, planted []float64
	for _, j := range use {
		var hs []float64
		for f := range pos {
			hs = append(hs, float64(pos[f][j][1]))
		}
		sort.Float64s(hs)
		low := hs[len(hs)/20]
		for f := range pos {
			y := float64(pos[f][j][1])
			all = append(all, y)
			if f == 0 {
				continue
			}
			a, b := pos[f-1][j], pos[f][j]
			if math.Hypot(float64(b[0]-a[0]), float64(b[2]-a[2])) < 0.012 && y < low+0.04 {
				planted = append(planted, y)
			}
		}
	}
	if len(planted) > 0 {
		sort.Float64s(planted)
		return planted[len(planted)/2]
	}
	sort.Float64s(all)
	return all[len(all)/20]
}

func groundRootStreams(roots, rotations []float32, skeleton skeletonDefinition) ([]float32, int) {
	pos := forwardKinematics(roots, rotations, skeleton)
	frames := len(pos)
	if frames < 3 {
		return roots, 0
	}
	var feet []int
	for j, n := range skeleton.names {
		if isFootJoint(n) {
			feet = append(feet, j)
		}
	}
	if len(feet) == 0 {
		return roots, 0
	}
	floor := clipFloor(pos, skeleton)
	rest := map[int]float64{}
	for _, j := range feet {
		rest[j] = plantedHeight(skeleton, j)
	}
	// per frame: the lowest planted foot's height above the floor, or NaN when nothing is planted
	support := make([]float64, frames)
	for f := 0; f < frames; f++ {
		support[f] = math.NaN()
		best := math.Inf(1)
		for _, j := range feet {
			if f == 0 || f == frames-1 {
				continue
			}
			a, b, c := pos[f-1][j], pos[f][j], pos[f+1][j]
			horiz := math.Max(math.Hypot(float64(b[0]-a[0]), float64(b[2]-a[2])), math.Hypot(float64(c[0]-b[0]), float64(c[2]-b[2])))
			vert := math.Max(math.Abs(float64(b[1]-a[1])), math.Abs(float64(c[1]-b[1])))
			if horiz < plantStill && vert < plantVert {
				best = math.Min(best, float64(b[1])-floor-rest[j])
			}
		}
		if !math.IsInf(best, 1) {
			support[f] = best
		}
	}
	// the shift each planted frame wants (down by how far the planted foot floats above its sole height)
	shift := make([]float64, frames)
	known := make([]bool, frames)
	touched := 0
	for f := 0; f < frames; f++ {
		if math.IsNaN(support[f]) {
			continue
		}
		s := support[f]
		if s < minShift {
			s = 0
		} else {
			touched++
		}
		shift[f], known[f] = s, true
	}
	if touched == 0 {
		return roots, 0
	}
	// interpolate across unplanted stretches (airborne frames carry the shift between their neighbours)
	last := -1
	for f := 0; f < frames; f++ {
		if !known[f] {
			continue
		}
		if last < 0 {
			for g := 0; g < f; g++ {
				shift[g] = shift[f]
			}
		} else {
			for g := last + 1; g < f; g++ {
				t := float64(g-last) / float64(f-last)
				shift[g] = shift[last]*(1-t) + shift[f]*t
			}
		}
		last = f
	}
	for g := last + 1; g < frames; g++ {
		shift[g] = shift[last]
	}
	// smooth twice with a box window
	for pass := 0; pass < 2; pass++ {
		out := make([]float64, frames)
		for f := 0; f < frames; f++ {
			sum, n := 0.0, 0
			for k := -floorSmooth; k <= floorSmooth; k++ {
				g := f + k
				if g < 0 || g >= frames {
					continue
				}
				sum += shift[g]
				n++
			}
			out[f] = sum / float64(n)
		}
		shift = out
	}
	// never below the floor: cap each frame's shift by its lowest foot's clearance
	outRoots := append([]float32(nil), roots...)
	for f := 0; f < frames; f++ {
		lowest := math.Inf(1)
		for _, j := range feet {
			lowest = math.Min(lowest, float64(pos[f][j][1])-floor)
		}
		s := math.Min(shift[f], math.Max(0, lowest))
		outRoots[f*3+1] -= float32(s)
	}
	// the body itself never sinks into the floor either: a rolling head or hip that goes under lifts the
	// whole body by what is missing (head and hips carry a 9 cm radius, wrists 2 cm, fingers touch the
	// floor, other joints 4 cm), smoothed
	lift := make([]float64, frames)
	anyLift := false
	for f := 0; f < frames; f++ {
		rootShift := float64(roots[f*3+1] - outRoots[f*3+1])
		need := 0.0
		for j, n := range skeleton.names {
			r := 0.04
			switch n {
			case "Head", "head", "Hips", "pelvis":
				r = 0.09
			}
			if ln := strings.ToLower(n); strings.Contains(ln, "hand") || strings.Contains(ln, "wrist") || strings.Contains(ln, "finger") || strings.Contains(ln, "thumb") {
				r = 0.02
				if ln != "lefthand" && ln != "righthand" && !strings.Contains(ln, "wrist") {
					r = 0.0
				}
			}
			if isFootJoint(n) {
				continue
			}
			y := float64(pos[f][j][1]) - floor - rootShift
			if y < r {
				need = math.Max(need, r-y)
			}
		}
		lift[f] = need
		if need > 0.005 {
			anyLift = true
		}
	}
	if anyLift {
		for pass := 0; pass < 2; pass++ {
			out := make([]float64, frames)
			for f := 0; f < frames; f++ {
				sum, n := 0.0, 0
				for k := -floorSmooth; k <= floorSmooth; k++ {
					g := f + k
					if g < 0 || g >= frames {
						continue
					}
					sum += lift[g]
					n++
				}
				out[f] = sum / float64(n)
			}
			lift = out
		}
		for f := 0; f < frames; f++ {
			outRoots[f*3+1] += float32(lift[f])
		}
		touched++
	}
	return outRoots, touched
}
