// Auto-checks on a finished clip: travel, speed, foot sliding, floor
// penetration and jitter, computed once from the raw streams and kept on
// the record so the library can show them without touching the data again.
// They are heuristics for sorting takes, not a verdict on quality.
package main

import (
	"math"
	"sort"
	"strings"
)

// Bump when the formulas or thresholds change: clips scored by an older
// version are rescored when the library loads.
const metricsVersion = 27 // 24: slide (toe travel per contact) and pivot (hips turn on planted feet), gait.go

type clipMetrics struct {
	Version       int            `json:"v"`
	Seconds       float64        `json:"seconds"`
	DistanceM     float64        `json:"distance_m"` // start to end, on the ground
	PathM         float64        `json:"path_m"`     // length of the root's ground path
	AvgSpeed      float64        `json:"avg_speed"`  // m/s along the path
	MaxSpeed      float64        `json:"max_speed"`
	HipsMinM      float64        `json:"hips_min_m"`
	HipsMaxM      float64        `json:"hips_max_m"`
	FootSkate     float64        `json:"foot_skate"`               // share of planted-foot frames that slide
	FloorM        float64        `json:"floor_m"`                  // lowest foot height; below 0 is through the floor
	Jitter        float64        `json:"jitter"`                   // mean joint acceleration, m per frame²
	JitterPeak    float64        `json:"jitter_peak,omitempty"`    // the hardest visible back-and-forth shake, cm per frame² (shake.go)
	JitterFrame   int            `json:"jitter_frame,omitempty"`   // ...its frame
	JitterJoint   string         `json:"jitter_joint,omitempty"`   // ...and joint ("root" for the root)
	SelfClip      float64        `json:"self_clip"`                // share of frames where two body parts overlap
	ClipPair      string         `json:"clip_pair,omitempty"`      // the pair that overlapped most
	ClipPairs     []clipPairStat `json:"clip_pairs,omitempty"`     // every pair that overlaps on more than 5 % of frames, worst first
	HandHead      float64        `json:"hand_head,omitempty"`      // share of frames with a hand inside the head (any amount flags)
	HoverM        float64        `json:"hover_m,omitempty"`        // how far the lowest planted foot floats above the floor at the end of the clip
	Airborne      float64        `json:"airborne,omitempty"`       // share of frames with both feet off the ground
	Ballistic     float64        `json:"ballistic_m,omitempty"`    // RMS distance of the hips from a gravity parabola while airborne (metres)
	AnatomyJoint  string         `json:"anatomy_joint,omitempty"`  // the joint turned furthest past what a body can do
	AnatomyFrame  int            `json:"anatomy_frame,omitempty"`  // ...its worst frame
	AnatomyDeg    float64        `json:"anatomy_deg,omitempty"`    // ...and how far past its range (degrees)
	AnatomyFrames int            `json:"anatomy_frames,omitempty"` // joint-frames outside their range
	SlideM        float64        `json:"slide_m,omitempty"`        // gait.go: the worst contact's toe travel along the floor (a glide, not a step)
	SlideSide     string         `json:"slide_side,omitempty"`
	SlideFrom     int            `json:"slide_from,omitempty"`
	SlideTo       int            `json:"slide_to,omitempty"`
	SlideCount    int            `json:"slide_count,omitempty"` // contacts that slide
	PivotDeg      float64        `json:"pivot_deg,omitempty"`   // gait.go: the hips turning while neither foot lifts
	PivotFrom     int            `json:"pivot_from,omitempty"`
	PivotTo       int            `json:"pivot_to,omitempty"`
	FloorY        float64        `json:"floor_y"`               // the clip's floor (where standing soles rest; the stage draws it here)
	FloorFrame    int            `json:"floor_frame,omitempty"` // deepest frame through the floor…
	FloorPart     string         `json:"floor_part,omitempty"`  // …and the bone whose surface it is
	FloatFrom     int            `json:"float_from,omitempty"`  // the longest stretch with nothing touching, never clear of the floor
	FloatTo       int            `json:"float_to,omitempty"`
	FloatGapM     float64        `json:"float_gap_m,omitempty"` // …its mean gap
	FootHover     string         `json:"foot_hover,omitempty"`  // "Left"/"Right": a still foot hovering while the body stands on something else
	FootHoverFrom int            `json:"foot_hover_from,omitempty"`
	FootHoverTo   int            `json:"foot_hover_to,omitempty"`
	FootHoverM    float64        `json:"foot_hover_m,omitempty"`
	BalanceFrom   int            `json:"balance_from,omitempty"` // nearly still, on the feet, centre of mass outside them
	BalanceTo     int            `json:"balance_to,omitempty"`
	BalanceOutM   float64        `json:"balance_out_m,omitempty"`
	StartSpeed    float64        `json:"start_speed,omitempty"`  // mean joint speed (m/s) over the first frames…
	EndSpeed      float64        `json:"end_speed,omitempty"`    // …and the last: above 0.15 the clip starts/ends mid-motion
	IdleHead      int            `json:"idle_head,omitempty"`    // frames of standing still before the move (past a short hold)
	IdleTail      int            `json:"idle_tail,omitempty"`    // …and after it settles
	ActionNotes   []string       `json:"action_notes,omitempty"` // what the prompt's verb needed and the clip did not do (action.go)
	Flags         []string       `json:"flags"`
}

// Thresholds, in metres and seconds. Feet rest a few centimetres above the
// origin on every skeleton, so "planted" is relative to the clip's own floor.
const (
	fps             = 30.0
	plantedAbove    = 0.03  // a foot within this of the clip's floor level is down
	plantedRise     = 0.004 // ...and not moving vertically more than this per frame
	plantedRun      = 4     // ...for at least this many frames in a row (edges excluded)
	slideStep       = 0.015 // a planted foot moving more than this per frame is sliding (0.45 m/s)
	skateFlagAt     = 0.30  // share of planted frames sliding
	skateMinPlanted = 10    // fewer planted frames than this says nothing
	floorFlagBelow  = -0.03
	jitterFlagAbove = 0.025 // mean joint acceleration; fast legitimate moves sit near 0.02
	hoverFlagAbove  = 0.03  // the lowest foot over the last second this far above the floor reads as floating
	clipDepth       = 0.04  // two capsules overlapping deeper than this are clipping; less is contact (a guard, a tuck)
	clipFlagAt      = 0.15  // share of frames with any clip
)

func rotateVec(q [4]float32, v [3]float32) [3]float32 {
	x, y, z, w := float64(q[0]), float64(q[1]), float64(q[2]), float64(q[3])
	vx, vy, vz := float64(v[0]), float64(v[1]), float64(v[2])
	tx, ty, tz := 2*(y*vz-z*vy), 2*(z*vx-x*vz), 2*(x*vy-y*vx)
	return [3]float32{float32(vx + w*tx + y*tz - z*ty), float32(vy + w*ty + z*tx - x*tz), float32(vz + w*tz + x*ty - y*tx)}
}

func mulQuat(a, b [4]float32) [4]float32 {
	x, y, z, w := a[0], a[1], a[2], a[3]
	X, Y, Z, W := b[0], b[1], b[2], b[3]
	return [4]float32{x*W + w*X + y*Z - z*Y, y*W + w*Y + z*X - x*Z, z*W + w*Z + x*Y - y*X, w*W - x*X - y*Y - z*Z}
}

// World joint positions per frame: [frame][joint][3].
func forwardKinematics(roots, rotations []float32, skeleton skeletonDefinition) [][][3]float32 {
	joints := len(skeleton.parents)
	if joints == 0 || len(roots) < 3 {
		return nil
	}
	frames := len(roots) / 3
	if len(rotations) < frames*joints*4 {
		frames = len(rotations) / (joints * 4)
	}
	out := make([][][3]float32, frames)
	global := make([][4]float32, joints)
	for f := 0; f < frames; f++ {
		positions := make([][3]float32, joints)
		for j := 0; j < joints; j++ {
			at := (f*joints + j) * 4
			q := [4]float32{rotations[at], rotations[at+1], rotations[at+2], rotations[at+3]}
			p := skeleton.parents[j]
			if p < 0 {
				global[j] = q
				positions[j] = [3]float32{roots[f*3], roots[f*3+1], roots[f*3+2]}
				continue
			}
			global[j] = mulQuat(global[p], q)
			o := rotateVec(global[p], skeleton.offsets[j])
			pp := positions[p]
			positions[j] = [3]float32{pp[0] + o[0], pp[1] + o[1], pp[2] + o[2]}
		}
		out[f] = positions
	}
	return out
}

func isFootJoint(name string) bool {
	n := strings.ToLower(name)
	return strings.Contains(n, "foot") || strings.Contains(n, "toe") || strings.Contains(n, "ankle")
}

func computeMetrics(roots, rotations []float32, skeleton skeletonDefinition, props ...stageProp) *clipMetrics {
	pos := forwardKinematics(roots, rotations, skeleton)
	frames := len(pos)
	if frames < 2 {
		return nil
	}
	m := &clipMetrics{Version: metricsVersion, Seconds: float64(frames) / fps, Flags: []string{}}
	// Root travel.
	m.HipsMinM, m.HipsMaxM = math.Inf(1), math.Inf(-1)
	for f := 0; f < frames; f++ {
		y := float64(roots[f*3+1])
		m.HipsMinM = math.Min(m.HipsMinM, y)
		m.HipsMaxM = math.Max(m.HipsMaxM, y)
		if f > 0 {
			step := math.Hypot(float64(roots[f*3]-roots[(f-1)*3]), float64(roots[f*3+2]-roots[(f-1)*3+2]))
			m.PathM += step
			m.MaxSpeed = math.Max(m.MaxSpeed, step*fps)
		}
	}
	m.DistanceM = math.Hypot(float64(roots[(frames-1)*3]-roots[0]), float64(roots[(frames-1)*3+2]-roots[2]))
	m.AvgSpeed = m.PathM / m.Seconds
	// Feet: floor level, sliding while planted, penetration.
	var feet []int
	for j, name := range skeleton.names {
		if isFootJoint(name) {
			feet = append(feet, j)
		}
	}
	if len(feet) > 0 {
		heights := make([]float64, 0, frames*len(feet))
		for f := 0; f < frames; f++ {
			for _, j := range feet {
				heights = append(heights, float64(pos[f][j][1]))
			}
		}
		sort.Float64s(heights)
		floor := heights[len(heights)/20] // 5th percentile: the clip's own floor
		m.FloorM = heights[0]
		// A contact is a run of frames where the joint is down and still in Y;
		// its first and last frames (strike and lift) are not judged.
		planted, sliding := 0, 0
		for _, j := range feet {
			down := make([]bool, frames)
			for f := 0; f < frames; f++ {
				low := float64(pos[f][j][1]) <= floor+plantedAbove
				still := f == 0 || math.Abs(float64(pos[f][j][1]-pos[f-1][j][1])) <= plantedRise
				down[f] = low && still
			}
			for f := 0; f < frames; {
				if !down[f] {
					f++
					continue
				}
				end := f
				for end < frames && down[end] {
					end++
				}
				if end-f >= plantedRun {
					for k := f + 1; k < end-1; k++ {
						planted++
						if math.Hypot(float64(pos[k][j][0]-pos[k-1][j][0]), float64(pos[k][j][2]-pos[k-1][j][2])) > slideStep {
							sliding++
						}
					}
				}
				f = end
			}
		}
		if planted >= skateMinPlanted {
			m.FootSkate = float64(sliding) / float64(planted)
		}
	}
	// Jitter: mean second difference of every joint.
	joints := len(skeleton.parents)
	if frames > 2 {
		var total float64
		for f := 1; f < frames-1; f++ {
			for j := 0; j < joints; j++ {
				a, b, c := pos[f-1][j], pos[f][j], pos[f+1][j]
				total += math.Sqrt(float64((c[0]-2*b[0]+a[0])*(c[0]-2*b[0]+a[0]) + (c[1]-2*b[1]+a[1])*(c[1]-2*b[1]+a[1]) + (c[2]-2*b[2]+a[2])*(c[2]-2*b[2]+a[2])))
			}
		}
		m.Jitter = total / float64((frames-2)*joints)
	}
	m.SelfClip, m.ClipPair, m.ClipPairs, m.HandHead = selfClip(pos, skeleton)
	// Contact truth from the body's surface (see contact.go); joints only when the skeleton has no body proxy.
	var air []bool
	m.FloorY = math.Round(clipFloor(pos, skeleton)*1000) / 1000
	cf := contactFrames(roots, rotations, skeleton, clipFloor(pos, skeleton), props...)
	if cf != nil {
		c := analyseContact(cf, roots)
		air = c.air
		m.FloorM, m.FloorFrame, m.FloorPart = -math.Round(c.sinkM*1000)/1000, c.sinkFrame, c.sinkPart
		if c.floatFrom >= 0 {
			m.FloatFrom, m.FloatTo, m.FloatGapM = c.floatFrom, c.floatTo, math.Round(c.floatGapM*1000)/1000
			m.Flags = append(m.Flags, "float")
		}
		if c.hoverFoot != "" {
			m.FootHover, m.FootHoverFrom, m.FootHoverTo, m.FootHoverM = c.hoverFoot, c.hoverFrom, c.hoverTo, math.Round(c.hoverM*1000)/1000
			m.Flags = append(m.Flags, "foot_hover")
		}
		if c.balanceFrom >= 0 {
			m.BalanceFrom, m.BalanceTo, m.BalanceOutM = c.balanceFrom, c.balanceTo, math.Round(c.balanceOutM*1000)/1000
			m.Flags = append(m.Flags, "balance")
		}
	}
	m.Airborne, m.Ballistic = ballistic(pos, skeleton, air)
	if m.Ballistic > 0.05 {
		m.Flags = append(m.Flags, "ballistic")
	}
	if m.SelfClip > clipFlagAt {
		m.Flags = append(m.Flags, "clip")
	}
	// Ending in the air: the lowest foot over the last second above the clip's floor.
	if frames > 30 {
		lowest := math.Inf(1)
		for f := frames - 30; f < frames; f++ {
			for _, j := range feetOf(skeleton) {
				lowest = math.Min(lowest, float64(pos[f][j][1]))
			}
		}
		if !math.IsInf(lowest, 1) {
			// against the floor the stage draws (toes rest on it), so the badge and the picture agree
			m.HoverM = math.Round(math.Max(0, lowest-clipFloor(pos, skeleton))*1000) / 1000
			if cf != nil {
				m.HoverM = math.Round(analyseContact(cf, roots).endHoverM*1000) / 1000
			}
			if m.HoverM > hoverFlagAbove {
				m.Flags = append(m.Flags, "hover")
			}
		}
	}
	// A hand in the face is never "clean": two frames are enough to see it.
	if m.HandHead*float64(frames) >= 1.5 {
		m.Flags = append(m.Flags, "hand_head")
	}
	if m.FootSkate > skateFlagAt {
		m.Flags = append(m.Flags, "skate")
	}
	// Gait: a foot gliding along the floor instead of stepping; the body turning on planted feet (gait.go)
	if gr := gaitChecks(pos, roots, rotations, skeleton); gr.worst.NetM > 0 || gr.pivotDeg > pivotFlagDeg {
		if gr.worst.NetM > 0 {
			m.SlideM, m.SlideSide, m.SlideFrom, m.SlideTo, m.SlideCount = math.Round(gr.worst.NetM*1000)/1000, gr.worst.Side, gr.worst.From, gr.worst.To, len(gr.slides)
			m.Flags = append(m.Flags, "slide")
		}
		if gr.pivotDeg > pivotFlagDeg {
			m.PivotDeg, m.PivotFrom, m.PivotTo = math.Round(gr.pivotDeg), gr.pivotFrom, gr.pivotTo
			m.Flags = append(m.Flags, "pivot")
		}
	}
	if m.FloorM < floorFlagBelow || cf != nil && m.FloorM < -sinkFlagM {
		m.Flags = append(m.Flags, "floor")
	}
	// Incomplete: a clip that ends (or starts) mid-motion cannot be used as one move in a game.
	st, en := endSpeeds(pos, skeleton)
	m.StartSpeed, m.EndSpeed = math.Round(st*100)/100, math.Round(en*100)/100
	// Idle: standing still before the move starts or after it settles, past a short hold (Trim idle cuts it)
	if from, to, ok := settleWindow(roots, rotations, skeleton, true, frames); ok {
		m.IdleHead, m.IdleTail = from, frames-1-to
		if m.IdleHead > idleFlagFrames || m.IdleTail > idleFlagFrames {
			m.Flags = append(m.Flags, "idle")
		}
	}
	if en > unsettledEnd {
		m.Flags = append(m.Flags, "unsettled_end")
	}
	if st > unsettledEnd {
		m.Flags = append(m.Flags, "unsettled_start")
	}
	m.JitterPeak, m.JitterFrame, m.JitterJoint = visibleShake(roots, rotations, skeleton)
	m.JitterPeak = math.Round(m.JitterPeak*10) / 10
	if m.Jitter > jitterFlagAbove || m.JitterPeak > shakeFlagCm {
		m.Flags = append(m.Flags, "jitter")
	}
	if joint, frame, over, n := worstAnatomy(anatomyHits(rotations, skeleton)); n > 0 {
		m.AnatomyJoint, m.AnatomyFrame, m.AnatomyDeg, m.AnatomyFrames = joint, frame, over, n
		m.Flags = append(m.Flags, "anatomy")
	}
	round := func(v float64) float64 { return math.Round(v*1000) / 1000 }
	m.Seconds, m.DistanceM, m.PathM, m.AvgSpeed, m.MaxSpeed = round(m.Seconds), round(m.DistanceM), round(m.PathM), round(m.AvgSpeed), round(m.MaxSpeed)
	m.HipsMinM, m.HipsMaxM, m.FootSkate, m.FloorM, m.Jitter = round(m.HipsMinM), round(m.HipsMaxM), round(m.FootSkate), round(m.FloorM), math.Round(m.Jitter*100000)/100000
	m.SelfClip, m.HandHead = round(m.SelfClip), round(m.HandHead)
	return m
}

// Body parts as capsules around bones, and which pairs may never overlap.
// Radii are for an average adult; the check wants gross clipping, not skin contact.
type bodyPart struct {
	name   string
	group  string // arm-l, arm-r, leg-l, leg-r, torso, head
	a, b   int    // joint indices of the segment
	radius float64
	extend float64 // metres the capsule continues past b along a→b (the skull above the Head joint)
}

func partsOf(skeleton skeletonDefinition) []bodyPart {
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
	var parts []bodyPart
	add := func(name, group string, a, b int, radius float64) {
		if a >= 0 && b >= 0 && a != b {
			parts = append(parts, bodyPart{name, group, a, b, radius, 0})
		}
	}
	// SOMA / SMPL-X naming (the G1 robot has none of these and gets no check).
	for _, side := range []struct{ tag, pre, post string }{{"l", "Left", "left_"}, {"r", "Right", "right_"}} {
		arm := "arm-" + side.tag
		leg := "leg-" + side.tag
		add(side.pre+" upper arm", arm, find(side.pre+"Arm", side.post+"shoulder"), find(side.pre+"ForeArm", side.post+"elbow"), 0.05)
		add(side.pre+" forearm", arm, find(side.pre+"ForeArm", side.post+"elbow"), find(side.pre+"Hand", side.post+"wrist"), 0.04)
		add(side.pre+" hand", arm, find(side.pre+"Hand", side.post+"wrist"), find(side.pre+"HandMiddleEnd", side.pre+"HandThumbEnd", side.post+"wrist"), 0.03)
		add(side.pre+" thigh", leg, find(side.pre+"Leg", side.post+"hip"), find(side.pre+"Shin", side.post+"knee"), 0.07)
		add(side.pre+" shin", leg, find(side.pre+"Shin", side.post+"knee"), find(side.pre+"Foot", side.post+"ankle"), 0.055)
		add(side.pre+" foot", leg, find(side.pre+"Foot", side.post+"ankle"), find(side.pre+"ToeBase", side.post+"foot"), 0.04)
	}
	add("torso", "torso", find("Hips", "pelvis"), find("Chest", "spine3"), 0.13)
	add("neck", "head", find("Neck1", "neck"), find("Head", "head"), 0.06)
	// SOMA's Head joint is the skull base; the face and skull sit the next ~0.2 m up the neck line.
	add("head", "head", find("Neck1", "neck"), find("Head", "head"), 0.10) // the doll's skull is 16 × 18 cm: a hand axis within 9 cm of the skull axis is inside it, a guard at the cheek is not
	parts[len(parts)-1].extend = 0.2
	return parts
}

// Which groups to test against each other. Same-side limb parts are
// neighbours by construction; the two thighs touch in any standing pose.
func checkPair(a, b bodyPart) bool {
	if a.group == b.group {
		return false
	}
	isArm := func(g string) bool { return strings.HasPrefix(g, "arm") }
	isLeg := func(g string) bool { return strings.HasPrefix(g, "leg") }
	switch {
	case isArm(a.group) && isArm(b.group):
		// Hands meeting each other is a clasp, a clap or a guard, not clipping.
		return !(strings.HasSuffix(a.name, " hand") && strings.HasSuffix(b.name, " hand"))
	case isArm(a.group) && isLeg(b.group), isLeg(a.group) && isArm(b.group):
		return true
	case isLeg(a.group) && isLeg(b.group):
		return !strings.Contains(a.name, "thigh") && !strings.Contains(b.name, "thigh")
	case (isArm(a.group) && b.group == "torso") || (a.group == "torso" && isArm(b.group)):
		// Hands and forearms against the torso only: upper arms rest on it.
		arm := a
		if a.group == "torso" {
			arm = b
		}
		return !strings.Contains(arm.name, "upper")
	case (isArm(a.group) && b.group == "head") || (a.group == "head" && isArm(b.group)):
		return true
	}
	return false
}

func sub(a, b [3]float32) [3]float64 {
	return [3]float64{float64(a[0] - b[0]), float64(a[1] - b[1]), float64(a[2] - b[2])}
}
func dot(a, b [3]float64) float64 { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] }

// Closest distance between two segments.
// The far end of a part's capsule: joint b, or a point `extend` metres past it.
func capsuleEnd(frame [][3]float32, p bodyPart) [3]float32 {
	q := frame[p.b]
	if p.extend <= 0 {
		return q
	}
	a := frame[p.a]
	d := [3]float32{q[0] - a[0], q[1] - a[1], q[2] - a[2]}
	n := float32(math.Sqrt(float64(d[0]*d[0] + d[1]*d[1] + d[2]*d[2])))
	if n < 1e-6 {
		return q
	}
	k := float32(p.extend) / n
	return [3]float32{q[0] + d[0]*k, q[1] + d[1]*k, q[2] + d[2]*k}
}

func segmentDistance(p1, q1, p2, q2 [3]float32) float64 {
	d1, d2, r := sub(q1, p1), sub(q2, p2), sub(p1, p2)
	a, e, f := dot(d1, d1), dot(d2, d2), dot(d2, r)
	var s, t float64
	const eps = 1e-9
	if a <= eps && e <= eps {
		s, t = 0, 0
	} else if a <= eps {
		s, t = 0, math.Max(0, math.Min(1, f/e))
	} else {
		c := dot(d1, r)
		if e <= eps {
			t, s = 0, math.Max(0, math.Min(1, -c/a))
		} else {
			b := dot(d1, d2)
			denom := a*e - b*b
			if denom != 0 {
				s = math.Max(0, math.Min(1, (b*f-c*e)/denom))
			}
			t = (b*s + f) / e
			if t < 0 {
				t, s = 0, math.Max(0, math.Min(1, -c/a))
			} else if t > 1 {
				t, s = 1, math.Max(0, math.Min(1, (b-c)/a))
			}
		}
	}
	c1 := [3]float64{float64(p1[0]) + d1[0]*s, float64(p1[1]) + d1[1]*s, float64(p1[2]) + d1[2]*s}
	c2 := [3]float64{float64(p2[0]) + d2[0]*t, float64(p2[1]) + d2[1]*t, float64(p2[2]) + d2[2]*t}
	dx, dy, dz := c1[0]-c2[0], c1[1]-c2[1], c1[2]-c2[2]
	return math.Sqrt(dx*dx + dy*dy + dz*dz)
}

// Share of frames where any checked pair overlaps deeper than clipDepth, and
// the pair that did so most.
type clipPairStat struct {
	Pair  string  `json:"pair"`
	Share float64 `json:"share"` // of frames
}

func selfClip(pos [][][3]float32, skeleton skeletonDefinition) (float64, string, []clipPairStat, float64) {
	parts := partsOf(skeleton)
	if len(parts) < 4 || len(pos) == 0 {
		return 0, "", nil, 0
	}
	type pair struct{ a, b int }
	var pairs []pair
	for i := range parts {
		for j := i + 1; j < len(parts); j++ {
			if checkPair(parts[i], parts[j]) {
				pairs = append(pairs, pair{i, j})
			}
		}
	}
	counts := make([]int, len(pairs))
	handHead := make([]bool, len(pairs))
	for k, pr := range pairs {
		a, b := parts[pr.a], parts[pr.b]
		handHead[k] = (a.name == "head" && strings.HasSuffix(b.name, " hand")) || (b.name == "head" && strings.HasSuffix(a.name, " hand"))
	}
	clipped, headFrames := 0, 0
	for _, frame := range pos {
		any, inHead := false, false
		for k, pr := range pairs {
			a, b := parts[pr.a], parts[pr.b]
			d := segmentDistance(frame[a.a], capsuleEnd(frame, a), frame[b.a], capsuleEnd(frame, b))
			if a.radius+b.radius-d > clipDepth {
				counts[k]++
				any = true
				if handHead[k] {
					inHead = true
				}
			}
		}
		if any {
			clipped++
		}
		if inHead {
			headFrames++
		}
	}
	worst, worstAt := 0, -1
	for k, c := range counts {
		if c > worst {
			worst, worstAt = c, k
		}
	}
	label := ""
	if worstAt >= 0 {
		label = parts[pairs[worstAt].a].name + " × " + parts[pairs[worstAt].b].name
	}
	// Every pair that clips on more than 5 % of frames, worst first: a punch combo can
	// have a hand in the head and an elbow in the torso, and both need fixing.
	var stats []clipPairStat
	for k, c := range counts {
		if share := float64(c) / float64(len(pos)); share > 0.05 || (handHead[k] && c >= 2) {
			stats = append(stats, clipPairStat{Pair: parts[pairs[k].a].name + " × " + parts[pairs[k].b].name, Share: math.Round(share*1000) / 1000})
		}
	}
	sort.Slice(stats, func(i, j int) bool { return stats[i].Share > stats[j].Share })
	if len(stats) > 6 {
		stats = stats[:6]
	}
	return float64(clipped) / float64(len(pos)), label, stats, float64(headFrames) / float64(len(pos))
}

// Ballistic check (Cascadeur's AutoPhysics, the part that matters for jumps):
// while the whole body is clear of the floor for 6+ frames its centre of mass
// must follow a parabola under gravity. For each airborne run a parabola
// y = a + b t - g/2 t² is fitted (least squares on a, b) and the RMS residual is reported.
func ballistic(pos [][][3]float32, skeleton skeletonDefinition, air []bool) (float64, float64) {
	airborne, rms, _ := ballisticFits(pos, skeleton, air)
	return airborne, rms
}

// One airborne stretch [from, to] and its centre of mass: com(f) and the gravity parabola it should follow.
type arcFit struct {
	from, to  int
	com, fit  []float64
	pre, post float64 // the centre of mass on the frames just before take-off and just after landing
}

// air (from the contact check: nothing touches the floor) decides which frames are airborne when given; without it
// a joint band does (skeletons with no body proxy).
func ballisticFits(pos [][][3]float32, skeleton skeletonDefinition, air []bool) (float64, float64, []arcFit) {
	if len(pos) == 0 {
		return 0, 0, nil
	}
	idx := map[string]int{}
	for i, n := range skeleton.names {
		idx[strings.ToLower(n)] = i
	}
	find := func(names ...string) int {
		for _, n := range names {
			if i, ok := idx[strings.ToLower(n)]; ok {
				return i
			}
		}
		return -1
	}
	lt, rt, hips := find("LeftToeBase", "LeftFoot", "left_foot"), find("RightToeBase", "RightFoot", "right_foot"), find("Hips", "pelvis")
	if lt < 0 || rt < 0 || hips < 0 {
		return 0, 0, nil
	}
	// The body's centre of mass, roughly: trunk joints weigh 3, the head 1.5, every other joint 1. A flip
	// spins the hips around this point, so the hips alone are never on a parabola even in a perfect flip.
	weight := make([]float64, len(skeleton.names))
	wsum := 0.0
	for j, n := range skeleton.names {
		w := 1.0
		switch strings.ToLower(n) {
		case "hips", "pelvis", "spine1", "spine2", "chest", "spine", "spine3":
			w = 3
		case "head":
			w = 1.5
		}
		if strings.Contains(strings.ToLower(n), "eye") || strings.Contains(strings.ToLower(n), "jaw") || strings.HasSuffix(strings.ToLower(n), "end") {
			w = 0
		}
		weight[j] = w
		wsum += w
	}
	com := func(f int) float64 {
		s := 0.0
		for j := range skeleton.names {
			s += weight[j] * float64(pos[f][j][1])
		}
		return s / wsum
	}
	// The clip's floor, and "airborne" means every joint is clear of it: a roll on the hands or the back is
	// supported, not flying.
	floor := math.Inf(1)
	for f := range pos {
		floor = math.Min(floor, math.Min(float64(pos[f][lt][1]), float64(pos[f][rt][1])))
	}
	// Body thickness: lying on the back puts the spine and shoulder joints ~10 cm above the floor, so trunk
	// joints count as touching below 16 cm, limbs below 8 cm. A foot standing still (even hovering, which the
	// floor pass and the "ends in the air" check cover) is support too: flying bodies do not hold a foot still.
	trunk := make([]bool, len(skeleton.names))
	for j, n := range skeleton.names {
		switch strings.ToLower(n) {
		case "hips", "pelvis", "spine1", "spine2", "chest", "spine", "spine3", "neck1", "neck2", "neck", "head", "leftshoulder", "rightshoulder", "leftarm", "rightarm":
			trunk[j] = true
		}
	}
	footIdx := []int{}
	for j, n := range skeleton.names {
		if isFootJoint(n) {
			footIdx = append(footIdx, j)
		}
	}
	clear := func(f int) bool {
		if air != nil {
			return f < len(air) && air[f]
		}
		for j := range skeleton.names {
			r := 0.08 // every joint, fingertips included: a hand on the floor is support
			if trunk[j] {
				r = 0.16
			}
			if float64(pos[f][j][1])-floor < r {
				return false
			}
		}
		if f > 0 && f < len(pos)-1 {
			for _, j := range footIdx {
				a, b, c := pos[f-1][j], pos[f][j], pos[f+1][j]
				horiz := math.Max(math.Hypot(float64(b[0]-a[0]), float64(b[2]-a[2])), math.Hypot(float64(c[0]-b[0]), float64(c[2]-b[2])))
				vert := math.Max(math.Abs(float64(b[1]-a[1])), math.Abs(float64(c[1]-b[1])))
				if horiz < plantStill && vert < plantVert {
					return false
				}
			}
		}
		return true
	}
	const g = 9.81
	const dt = 1.0 / 30
	airborne := 0
	var sumSq float64
	var samples int
	var fits []arcFit
	start := -1
	flush := func(a, b int) { // frames [a, b] airborne
		n := b - a + 1
		if n < 6 {
			return
		}
		// fit y(t) + g/2 t² = a0 + b0 t
		var sx, sy, sxx, sxy float64
		for f := a; f <= b; f++ {
			t := float64(f-a) * dt
			y := com(f) + 0.5*g*t*t
			sx += t
			sy += y
			sxx += t * t
			sxy += t * y
		}
		den := float64(n)*sxx - sx*sx
		if den < 1e-9 {
			return
		}
		b0 := (float64(n)*sxy - sx*sy) / den
		a0 := (sy - b0*sx) / float64(n)
		af := arcFit{from: a, to: b, pre: com(max(a-1, 0)), post: com(min(b+1, len(pos)-1))}
		for f := a; f <= b; f++ {
			t := float64(f-a) * dt
			fit := a0 + b0*t - 0.5*g*t*t
			d := com(f) - fit
			sumSq += d * d
			samples++
			af.com, af.fit = append(af.com, com(f)), append(af.fit, fit)
		}
		fits = append(fits, af)
	}
	for f := range pos {
		off := clear(f)
		if off {
			airborne++
			if start < 0 {
				start = f
			}
		} else if start >= 0 {
			flush(start, f-1)
			start = -1
		}
	}
	if start >= 0 {
		flush(start, len(pos)-1)
	}
	rms := 0.0
	if samples > 0 {
		rms = math.Sqrt(sumSq / float64(samples))
	}
	return float64(airborne) / float64(len(pos)), math.Round(rms*1000) / 1000, fits
}

func feetOf(skeleton skeletonDefinition) []int {
	var out []int
	for j, n := range skeleton.names {
		if isFootJoint(n) {
			out = append(out, j)
		}
	}
	return out
}

// How bad a clip's problems are, for comparing two versions of one clip (Clean up's do-no-harm guard): a move not
// done or not finished outweighs everything; contact and body problems next; idle padding barely counts.
func flagSeverity(m *clipMetrics) int {
	if m == nil {
		return 1 << 20
	}
	n := 0
	for _, f := range m.Flags {
		switch f {
		case "action", "unsettled_end", "unsettled_start":
			n += 100
		case "idle":
			n += 1
		default:
			n += 10
		}
	}
	return n
}
