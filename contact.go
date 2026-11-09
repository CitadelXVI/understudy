// Contact truth: where the body's surface really is relative to the floor. The checks used to look at joints with
// generous bands (a hand 12 cm over the floor counted as support), so a roll done in mid-air, a foot hovering while
// the body stood, or toes pushed through the floor all read "clean". The body proxy is the stage mannequin's own
// surface, sampled per bone (convex hull of the vertices each bone drives, in that bone's frame; built by
// tools/cleanup from the rendered mesh, within ~1 cm of it), so the checks see what the stage shows.
package main

import (
	_ "embed"
	"encoding/json"
	"math"
	"sort"
)

//go:embed soma30_proxy.json
var soma30ProxyJSON []byte

var bodyProxies = map[string]map[string][][3]float64{}

func init() {
	var p map[string][][3]float64
	if json.Unmarshal(soma30ProxyJSON, &p) == nil {
		bodyProxies["soma30"] = p
	}
}

const (
	touchM        = 0.025 // a surface this close to the floor touches it
	sinkFlagM     = 0.015 // a surface this far under the floor is through it
	floatBelowM   = 0.15  // a stretch with nothing touching and the body never higher than this over the floor floats
	floatMinRun   = 5
	floatTrunkM   = 0.30   // …or this, when the trunk (not the feet) is the lowest part
	hoverMinRun   = 10     // a still foot this many frames over the floor while the body stands on something else
	hoverLowM     = touchM // ...between these heights (above: a raised foot, a pose; below: touching)
	hoverHighM    = 0.12
	hoverStillM   = 0.012 // horizontal travel per frame of a still foot
	balanceOutM   = 0.15  // centre of mass this far outside the feet's support… (a one-legged kick leans ~13 cm for a moment)
	balanceMinRun = 8     // …for this many frames, while the body is nearly still
	balanceSlowMS = 0.6   // hips slower than this (m/s) count as nearly still
)

// One frame's contact picture.
type contactFrame struct {
	gap      float64            // lowest surface over the floor (negative = through it)
	part     string             // ...which bone that is
	low      map[string]float64 // each bone's lowest surface over the floor
	support  [][2]float64       // xz of the surface points touching the floor
	com      [3]float64
	feet     map[string][2]float64 // xz of each foot joint
	inverted bool                  // the trunk points down (hips above chest)
}

// contactFrames: nil when the skeleton has no proxy.
func contactFrames(roots, rotations []float32, skeleton skeletonDefinition, floor float64, props ...stageProp) []contactFrame {
	field := floorField{floor: floor, props: props}
	proxy := bodyProxies[skeleton.key]
	joints := len(skeleton.parents)
	if proxy == nil || joints == 0 {
		return nil
	}
	frames := len(roots) / 3
	if len(rotations) < frames*joints*4 {
		frames = len(rotations) / (joints * 4)
	}
	index := map[string]int{}
	for i, n := range skeleton.names {
		index[n] = i
	}
	weight := comWeights(skeleton)
	out := make([]contactFrame, frames)
	global := make([][4]float32, joints)
	pos := make([][3]float32, joints)
	for f := 0; f < frames; f++ {
		for j := 0; j < joints; j++ {
			at := (f*joints + j) * 4
			q := [4]float32{rotations[at], rotations[at+1], rotations[at+2], rotations[at+3]}
			p := skeleton.parents[j]
			if p < 0 {
				global[j], pos[j] = q, [3]float32{roots[f*3], roots[f*3+1], roots[f*3+2]}
				continue
			}
			global[j] = mulQuat(global[p], q)
			o := rotateVec(global[p], skeleton.offsets[j])
			pos[j] = [3]float32{pos[p][0] + o[0], pos[p][1] + o[1], pos[p][2] + o[2]}
		}
		c := contactFrame{gap: math.Inf(1), low: map[string]float64{}, feet: map[string][2]float64{}}
		if h, ok := index["Hips"]; ok {
			if ch, ok2 := index["Chest"]; ok2 {
				c.inverted = pos[ch][1] < pos[h][1]
			}
		}
		for _, side := range []string{"Left", "Right"} {
			if j, ok := index[side+"Foot"]; ok {
				c.feet[side] = [2]float64{float64(pos[j][0]), float64(pos[j][2])}
			}
		}
		wsum := 0.0
		for j := 0; j < joints; j++ {
			for k := 0; k < 3; k++ {
				c.com[k] += weight[j] * float64(pos[j][k])
			}
			wsum += weight[j]
		}
		for k := 0; k < 3; k++ {
			c.com[k] /= wsum
		}
		for name, pts := range proxy {
			j, ok := index[name]
			if !ok {
				continue
			}
			low := math.Inf(1)
			for _, pt := range pts {
				w := rotateVec(global[j], [3]float32{float32(pt[0]), float32(pt[1]), float32(pt[2])})
				y := field.height(float64(pos[j][0]+w[0]), float64(pos[j][1]+w[1]), float64(pos[j][2]+w[2]))
				low = math.Min(low, y)
				if y < touchM {
					c.support = append(c.support, [2]float64{float64(pos[j][0] + w[0]), float64(pos[j][2] + w[2])})
				}
			}
			c.low[name] = low
			if low < c.gap {
				c.gap, c.part = low, name
			}
		}
		out[f] = c
	}
	return out
}

// The body's centre of mass, roughly: trunk joints weigh 3, the head 1.5, every other joint 1, ends/eyes/jaw 0.
func comWeights(skeleton skeletonDefinition) []float64 {
	w := make([]float64, len(skeleton.names))
	for j, n := range skeleton.names {
		w[j] = 1
		switch n {
		case "Hips", "Spine1", "Spine2", "Chest", "pelvis", "spine1", "spine2", "spine3":
			w[j] = 3
		case "Head", "head":
			w[j] = 1.5
		}
		if len(n) > 3 && (n[len(n)-3:] == "End" || n[len(n)-3:] == "Eye") || n == "Jaw" {
			w[j] = 0
		}
	}
	return w
}

type contactReport struct {
	sinkM                  float64 // deepest any surface goes under the floor (positive)
	sinkFrame              int
	sinkPart               string
	air                    []bool // nothing touches
	floatFrom, floatTo     int    // the longest near-floor float (-1 = none)
	floatGapM              float64
	hoverFoot              string // a still foot hovering while the body stands on something else
	hoverFrom, hoverTo     int
	hoverM                 float64
	balanceFrom, balanceTo int // centre of mass outside the support while nearly still
	balanceOutM            float64
	endHoverM              float64 // lowest foot surface over the last second (ends in the air)
}

func analyseContact(cf []contactFrame, roots []float32) contactReport {
	r := contactReport{floatFrom: -1, hoverFrom: -1, balanceFrom: -1}
	frames := len(cf)
	r.air = make([]bool, frames)
	for f, c := range cf {
		if -c.gap > r.sinkM {
			r.sinkM, r.sinkFrame, r.sinkPart = -c.gap, f, c.part
		}
		r.air[f] = c.gap > touchM
	}
	// floating: a run with nothing touching that never rises clear of the floor
	for f := 0; f < frames; {
		if !r.air[f] {
			f++
			continue
		}
		a, high := f, 0.0
		for f < frames && r.air[f] {
			high = math.Max(high, cf[f].gap)
			f++
		}
		// lying, sitting or rolling (the lowest part is the trunk, not the feet): no one jumps from there, so any
		// stretch off the floor up to floatTrunkM is a float
		trunk := 0
		for k := a; k < f; k++ {
			if isTrunkPart(cf[k].part) {
				trunk++
			}
		}
		limit := floatBelowM
		if trunk*2 > f-a {
			limit = floatTrunkM
		}
		// a clip may start or end in the air on its feet (a fall, a jump cut short); lying in the air never is fine
		edge := a == 0 || f == frames
		// a small hop on the feet is not a float: its centre of mass rides a gravity arc (Clean up uses the same rule)
		// a hop or a flip is not a float: its centre of mass rides a gravity arc, upside down or not (Clean up agrees)
		hop := high > 0.05 && f-a >= 5 && gravityFitRMS(cf[a:f]) < 0.03
		// upside down in the air is a flip or a dive (the floaty-jump check judges its arc), not a float
		inv := 0
		for k := a; k < f; k++ {
			if cf[k].inverted {
				inv++
			}
		}
		hop = hop || inv*10 > 3*(f-a)
		if f-a >= floatMinRun && high < limit && (!edge || limit == floatTrunkM) && !hop && f-a > r.floatTo-r.floatFrom {
			mean := 0.0
			for k := a; k < f; k++ {
				mean += cf[k].gap
			}
			r.floatFrom, r.floatTo, r.floatGapM = a, f-1, mean/float64(f-a)
		}
	}
	// a foot hovering: still, low but not touching, while something else holds the body up
	for _, side := range []string{"Left", "Right"} {
		foot, toe := side+"Foot", side+"ToeBase"
		run, start, sum := 0, 0, 0.0
		flush := func(end int) {
			if run >= hoverMinRun && end-start > r.hoverTo-r.hoverFrom {
				r.hoverFoot, r.hoverFrom, r.hoverTo, r.hoverM = side, start, end, sum/float64(run)
			}
			run, sum = 0, 0
		}
		for f, c := range cf {
			lf, okf := c.low[foot]
			lt, okt := c.low[toe]
			if !okf || !okt {
				return r
			}
			h := math.Min(lf, lt)
			still := true
			if f > 0 {
				a, b := cf[f-1].feet[side], c.feet[side]
				still = math.Hypot(b[0]-a[0], b[1]-a[1]) < hoverStillM
			}
			if h > hoverLowM && h < hoverHighM && still && !r.air[f] {
				if run == 0 {
					start = f
				}
				run++
				sum += h
				continue
			}
			flush(f - 1)
		}
		flush(frames - 1)
	}
	// balance: nearly still, held up by the feet alone, centre of mass outside them
	run, start, worst := 0, 0, 0.0
	flush := func(end int) {
		if run >= balanceMinRun && end-start > r.balanceTo-r.balanceFrom {
			r.balanceFrom, r.balanceTo, r.balanceOutM = start, end, worst
		}
		run, worst = 0, 0
	}
	for f, c := range cf {
		slow := false
		if f > 0 {
			slow = math.Hypot(float64(roots[f*3]-roots[(f-1)*3]), float64(roots[f*3+2]-roots[(f-1)*3+2]))*fps < balanceSlowMS
		}
		// whatever touches the floor holds the body up (feet, knees, shins, hips, hands): the centre of mass must be over it
		out := 0.0
		if !r.air[f] && len(c.support) > 0 && slow {
			out = outsideHull(c.support, [2]float64{c.com[0], c.com[2]})
		}
		if out > balanceOutM {
			if run == 0 {
				start = f
			}
			run++
			worst = math.Max(worst, out)
			continue
		}
		flush(f - 1)
	}
	flush(frames - 1)
	// ends in the air: the feet over the last second
	if frames > 30 {
		low := math.Inf(1)
		for f := frames - 30; f < frames; f++ {
			for name, l := range cf[f].low {
				if isFootJoint(name) {
					low = math.Min(low, l)
				}
			}
		}
		r.endHoverM = math.Max(0, low)
	}
	return r
}

// Distance of p outside the convex hull of pts (0 inside).
func outsideHull(pts [][2]float64, p [2]float64) float64 {
	if len(pts) == 0 {
		return 0
	}
	h := convexHull(pts)
	if len(h) < 3 {
		// a line or a point: distance to it
		best := math.Inf(1)
		for i := range h {
			best = math.Min(best, segDist2(p, h[i], h[(i+1)%len(h)]))
		}
		return best
	}
	inside := true
	best := math.Inf(1)
	for i := range h {
		a, b := h[i], h[(i+1)%len(h)]
		if (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]) < 0 {
			inside = false
		}
		best = math.Min(best, segDist2(p, a, b))
	}
	if inside {
		return 0
	}
	return best
}

func segDist2(p, a, b [2]float64) float64 {
	dx, dy := b[0]-a[0], b[1]-a[1]
	l := dx*dx + dy*dy
	t := 0.0
	if l > 1e-12 {
		t = math.Max(0, math.Min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/l))
	}
	return math.Hypot(p[0]-a[0]-t*dx, p[1]-a[1]-t*dy)
}

// Andrew's monotone chain, counter-clockwise.
func convexHull(pts [][2]float64) [][2]float64 {
	p := append([][2]float64(nil), pts...)
	sort.Slice(p, func(i, j int) bool { return p[i][0] < p[j][0] || p[i][0] == p[j][0] && p[i][1] < p[j][1] })
	cross := func(o, a, b [2]float64) float64 { return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]) }
	var h [][2]float64
	for _, q := range p {
		for len(h) >= 2 && cross(h[len(h)-2], h[len(h)-1], q) <= 0 {
			h = h[:len(h)-1]
		}
		h = append(h, q)
	}
	lower := len(h) + 1
	for i := len(p) - 2; i >= 0; i-- {
		q := p[i]
		for len(h) >= lower && cross(h[len(h)-2], h[len(h)-1], q) <= 0 {
			h = h[:len(h)-1]
		}
		h = append(h, q)
	}
	if len(h) > 1 {
		h = h[:len(h)-1]
	}
	return h
}

func isTrunkPart(name string) bool {
	switch name {
	case "Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head", "LeftShoulder", "RightShoulder", "LeftArm", "RightArm":
		return true
	}
	return false
}

// RMS distance (m) of the centre of mass's height from the best gravity arc (g fixed, take-off height and speed fitted).
func gravityFitRMS(cf []contactFrame) float64 {
	n := len(cf)
	var st, sy, stt, sty float64
	for i, c := range cf {
		t := float64(i) / fps
		y := c.com[1] + 0.5*9.81*t*t
		st += t
		sy += y
		stt += t * t
		sty += t * y
	}
	den := float64(n)*stt - st*st
	if den < 1e-12 {
		return math.Inf(1)
	}
	b := (float64(n)*sty - st*sy) / den
	a := (sy - b*st) / float64(n)
	ss := 0.0
	for i, c := range cf {
		t := float64(i) / fps
		d := c.com[1] + 0.5*9.81*t*t - (a + b*t)
		ss += d * d
	}
	return math.Sqrt(ss / float64(n))
}
