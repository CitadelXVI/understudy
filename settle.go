package main

// Complete clips. Kimodo plays an action at its own pace inside the frames it is given: too few frames and the action
// is cut off mid-motion (a kick ending with the foot still in the air), too many and the clip idles for seconds.
// "Finish settled" asks the model to come to rest (a hidden last segment, "The person stops and stands still"),
// then trims the idle beyond a short hold at the end (and at the start, when nothing pins the first frames).
// The check: a clip that starts or ends moving is incomplete, never clean.

import (
	"math"
	"regexp"
	"strings"
)

const (
	standPrompt    = "A person stands still"
	settlePrompt   = "The person slows down, stops and stands still"
	settleFrames   = 90
	settleHold     = 10   // frames kept still at each end (enough to blend into the next animation)
	movingSpeed    = 0.10 // mean joint speed (m/s) above which the body is moving
	unsettledEnd   = 0.15 // mean joint speed over the last/first frames above which a clip ends/starts mid-motion
	unsettledSpan  = 8
	minTrimmed     = 30
	idleFlagFrames = 30 // a second of standing still at either end is padding, not motion
)

// Mean joint speed (m/s) per frame step: speed[f] between frame f and f+1. Ends, eyes and jaw are left out.
func jointSpeeds(pos [][][3]float32, skeleton skeletonDefinition) []float64 {
	var use []int
	for j, n := range skeleton.names {
		l := len(n)
		if l > 3 && (n[l-3:] == "End" || n[l-3:] == "Eye") || n == "Jaw" || n == "jaw" {
			continue
		}
		use = append(use, j)
	}
	out := make([]float64, 0, len(pos))
	for f := 1; f < len(pos); f++ {
		s := 0.0
		for _, j := range use {
			a, b := pos[f-1][j], pos[f][j]
			s += math.Sqrt(float64((b[0]-a[0])*(b[0]-a[0]) + (b[1]-a[1])*(b[1]-a[1]) + (b[2]-a[2])*(b[2]-a[2])))
		}
		out = append(out, s/float64(len(use))*fps)
	}
	return out
}

// How a clip begins and ends: mean speed over its first and last unsettledSpan frames.
func endSpeeds(pos [][][3]float32, skeleton skeletonDefinition) (start, end float64) {
	v := jointSpeeds(pos, skeleton)
	if len(v) < unsettledSpan {
		return 0, 0
	}
	for i := 0; i < unsettledSpan; i++ {
		start += v[i]
		end += v[len(v)-1-i]
	}
	return start / unsettledSpan, end / unsettledSpan
}

// The frames to keep: from settleHold frames before the motion starts (frame 0 when trimStart is false) to
// settleHold frames into the first rest after the prompted motion. promptFrames is how many frames the user asked
// for: motion after them belongs to the settle segment, which only exists to bring a cut-off move to rest (it can add
// a step of its own after a move that had already settled, and that is cut too). ok is false when nothing changes.
// handsDown (optional): a rest also needs the hands down (a strike that should end calm: a held guard is not the end)
func settleWindow(roots, rotations []float32, skeleton skeletonDefinition, trimStart bool, promptFrames int, handsDown ...bool) (from, to int, ok bool) {
	pos := forwardKinematics(roots, rotations, skeleton)
	frames := len(pos)
	raw := jointSpeeds(pos, skeleton)
	if len(raw) < 2*settleHold {
		return 0, frames - 1, false
	}
	v := make([]float64, len(raw)) // 5-frame mean: a single twitch is not motion
	for i := range raw {
		s, n := 0.0, 0
		for k := max(0, i-2); k <= min(len(raw)-1, i+2); k++ {
			s += raw[k]
			n++
		}
		v[i] = s / float64(n)
	}
	limit := min(promptFrames, len(v)) - 1
	// "moving" scales with the move: a flip peaking at 3.5 m/s is done when it is down to its settling sway, a slow
	// stretch keeps its quiet motion (12 % of the peak, never below movingSpeed)
	peak := 0.0
	for i := 0; i <= limit; i++ {
		peak = math.Max(peak, v[i])
	}
	thr := math.Max(movingSpeed, 0.12*peak)
	// the frames kept at the ends must also be calm in absolute terms (inside the completeness check's 0.15 m/s), or
	// a big move's settling would be cut while it still reads as moving
	calm := math.Min(thr, unsettledEnd-0.01)
	first, last := -1, -1
	for i := 0; i <= limit; i++ {
		if v[i] > thr {
			if first < 0 {
				first = i
			}
			last = i
		}
	}
	if first < 0 { // never moves: nothing to trim around
		return 0, frames - 1, false
	}
	// feet: a rest is only a rest when both feet have come down and stopped (a kick is not over while its foot is
	// still travelling back to the floor, however quiet the rest of the body is)
	var feetJ []int
	for j, n := range skeleton.names {
		if n == "LeftFoot" || n == "RightFoot" || n == "left_foot" || n == "right_foot" {
			feetJ = append(feetJ, j)
		}
	}
	footMoving := func(i int) bool {
		for _, j := range feetJ {
			a, b := pos[i][j], pos[i+1][j]
			if math.Sqrt(float64((b[0]-a[0])*(b[0]-a[0])+(b[1]-a[1])*(b[1]-a[1])+(b[2]-a[2])*(b[2]-a[2])))*fps > 0.25 {
				return true
			}
		}
		return false
	}
	// a rest is also a body on its feet: the lowest foot within reach of the floor and the trunk upright (a take
	// that stalls upside down in a handstand, or hangs in the air, is not settled, however still it is)
	floor := clipFloor(pos, skeleton)
	var hipsJ, chestJ int = -1, -1
	for j, n := range skeleton.names {
		switch n {
		case "Hips", "hips", "pelvis":
			hipsJ = j
		case "Chest", "chest", "spine3":
			chestJ = j
		}
	}
	standing := func(i int) bool {
		if len(feetJ) == 0 {
			return true
		}
		lowest := math.Inf(1)
		for _, j := range feetJ {
			lowest = math.Min(lowest, float64(pos[i][j][1]))
		}
		if lowest-floor > 0.15 {
			return false
		}
		if len(handsDown) > 0 && handsDown[0] && handsUpAt(pos[i], skeleton) {
			return false
		}
		if hipsJ >= 0 && chestJ >= 0 {
			a, b := pos[i][hipsJ], pos[i][chestJ]
			dy := float64(b[1] - a[1])
			l := math.Sqrt(float64((b[0]-a[0])*(b[0]-a[0]) + (b[1]-a[1])*(b[1]-a[1]) + (b[2]-a[2])*(b[2]-a[2])))
			if l > 1e-6 && dy/l < 0.3 {
				return false
			}
		}
		return true
	}
	// the first rest (settleHold frames below the line, feet still, body on its feet) after the last prompted motion
	end := -1
	for i := last + 1; i+settleHold <= len(v); i++ {
		still := true
		for k := i; k < i+settleHold; k++ {
			if v[k] > calm || footMoving(k) || !standing(k) {
				still = false
				break
			}
		}
		if still {
			end = i
			break
		}
	}
	from, to = 0, frames-1
	if trimStart {
		from = max(0, first-settleHold)
		calmFrom := func(f int) bool { // the opening frames (as the completeness check reads them) are calm
			s := 0.0
			for k := f; k < min(f+unsettledSpan, len(v)); k++ {
				s += v[k]
			}
			return s/float64(unsettledSpan) <= calm
		}
		for from > 0 && !calmFrom(from) { // back up until the clip opens calm
			from--
		}
	}
	if end >= 0 {
		to = min(frames-1, end+settleHold)
	}
	if to-from+1 < minTrimmed || (from == 0 && to == frames-1) {
		return 0, frames - 1, false
	}
	return from, to, true
}

// Cut the streams to [from, to]; the clip still starts at the origin (x/z), as Kimodo's do.
func trimStreams(roots, rotations []float32, joints, from, to int) ([]float32, []float32) {
	r := append([]float32(nil), roots[from*3:(to+1)*3]...)
	q := append([]float32(nil), rotations[from*joints*4:(to+1)*joints*4]...)
	x0, z0 := r[0], r[2]
	for f := 0; f*3 < len(r); f++ {
		r[f*3] -= x0
		r[f*3+2] -= z0
	}
	return r, q
}

// The user's segments after a trim: frames taken off the first and the last, so the timeline still adds up.
func trimSegments(segments []promptSegment, cutStart, newFrames int) []promptSegment {
	out := append([]promptSegment(nil), segments...)
	if len(out) == 0 {
		return out
	}
	out[0].Frames -= cutStart
	total := 0
	for _, s := range out {
		total += s.Frames
	}
	for i := len(out) - 1; i >= 0 && total > newFrames; i-- {
		cut := min(total-newFrames, out[i].Frames-1)
		out[i].Frames -= cut
		total -= cut
	}
	for i := len(out) - 1; i >= 0 && total < newFrames; i-- { // the settle frames that were kept belong to the last
		out[i].Frames += newFrames - total
		total = newFrames
	}
	if out[0].Frames < 1 {
		return []promptSegment{{Prompt: out[0].Prompt, Frames: newFrames}}
	}
	return out
}

func promptTotal(segments []promptSegment, fallback int) int {
	t := 0
	for _, s := range segments {
		t += s.Frames
	}
	if t == 0 {
		return fallback
	}
	return t
}

// "X and then Y" / "X, then Y" / "X then Y" in one prompt: Kimodo tends to skip the first part (a "sit down and then
// stand up" that starts seated), and given as two segments it does both. Returns nil when the prompt is not compound.
var compoundSplit = regexp.MustCompile(`(?i)^(.+?)(?:,\s*and then|\s+and then|,\s*then|\s+then)\s+(.+)$`)

func splitCompound(prompt string) []string {
	m := compoundSplit.FindStringSubmatch(strings.TrimSpace(prompt))
	if m == nil {
		return nil
	}
	first, second := strings.TrimSpace(m[1]), strings.TrimSpace(strings.TrimSuffix(m[2], "."))
	if len(first) < 6 || len(second) < 4 {
		return nil
	}
	// the second part needs its subject: "stands up" -> "A person stands up"
	lower := strings.ToLower(second)
	if !strings.HasPrefix(lower, "a ") && !strings.HasPrefix(lower, "the ") && !strings.HasPrefix(lower, "he ") && !strings.HasPrefix(lower, "she ") && !strings.HasPrefix(lower, "they ") && !strings.HasPrefix(lower, "actor") {
		second = "The person " + second
	}
	return []string{first, second}
}

// What the model is asked for. With Finish settled: a compound prompt becomes its parts (shown as the clip's
// segments) after a short standing lead, and a settle segment follows. lead = frames before the user's motion.
// withSettle: append the settle segment. The worker first asks without it (most moves finish within the frames
// given, and the extra segment both costs ~2 s and changes the take) and only asks again with it when the take ends
// mid-motion.
func generationSegments(item *animation, segments []promptSegment, withSettle bool) (gen []promptSegment, lead int) {
	gen, lead = generationSegmentsBase(item, segments, withSettle)
	if item.Preroll > 0 && item.prerollText != "" {
		if lead > 0 && len(gen) > 0 && gen[0].Prompt == standPrompt {
			gen = gen[1:] // the pre-roll replaces the standing lead
		}
		gen = append([]promptSegment{{Prompt: item.prerollText, Frames: item.Preroll}}, gen...)
		lead = item.Preroll
	}
	return gen, lead
}

func generationSegmentsBase(item *animation, segments []promptSegment, withSettle bool) (gen []promptSegment, lead int) {
	segments = append([]promptSegment(nil), segments...)
	for i := range segments { // clearer wordings from the first take (action.go firstWordings); the clip keeps the user's words
		segments[i].Prompt = firstWording(segments[i].Prompt)
	}
	if item.reword {
		segments = append([]promptSegment(nil), segments...)
		for i := range segments {
			if w := retryWording(segments[i].Prompt); w != "" {
				segments[i].Prompt = w
			}
		}
	}
	if !item.FinishSettled {
		return segments, 0
	}
	if len(segments) == 1 && len(item.Constraints) == 0 {
		if parts := splitCompound(segments[0].Prompt); parts != nil && segments[0].Frames >= 2*minSegmentFrames {
			half := segments[0].Frames / 2
			split := []promptSegment{{Prompt: parts[0], Frames: half}, {Prompt: parts[1], Frames: segments[0].Frames - half}}
			item.Segments = split
			segments = split
			gen = append(gen, promptSegment{Prompt: standPrompt, Frames: minSegmentFrames})
			lead = minSegmentFrames
		}
	}
	// a plain move starts from a calm stance a game can blend from: a short "stands still" lead in words (no pinned
	// pose: the arms and body are free), trimmed back to a short hold. Judges marked every plain take that opened
	// mid-motion down (turns, 4-5/10). A styled move skips it: it must be in character from frame 1 (owner, 10-29)
	if lead == 0 && !item.noCalmLead && item.Preroll == 0 && item.Actor == 0 && len(item.Constraints) == 0 && !characterWords.MatchString(promptText(item)) && !holdWords.MatchString(promptText(item)) {
		gen = append(gen, promptSegment{Prompt: standPrompt, Frames: minSegmentFrames})
		lead = minSegmentFrames
	}
	gen = append(gen, segments...)
	if !withSettle {
		return gen, lead
	}
	// a travelling move needs room to slow down (90 frames stopped a jog, 60 did not); anything else settles in 60
	// (each settle frame costs generation time: ~1 s per 30)
	frames := 60
	if hasWord(strings.ToLower(promptTotalText(segments)), "walk", "jog", "run", "sprint", "sneak", "crawl", "skip", "march", "stroll", "circle") {
		frames = settleFrames
	}
	words := settlePrompt
	if item.settleText != "" {
		words = item.settleText
	}
	gen = append(gen, promptSegment{Prompt: words, Frames: frames})
	return gen, lead
}

const guardSettlePrompt = "The person lowers their hands to their sides and stands relaxed"

var combatWords = regexp.MustCompile(`(?i)\b(punch(es)?|jabs?|hooks?|uppercuts?|strikes?|kicks?|hits?|swings? (a|the|at))\b`)
var keepGuardWords = regexp.MustCompile(`(?i)\b(guard|stance|ready|fighting pose|hands up|keeps? (his|her|their) hands)\b`)

// combatEnd: a strike that should end back in a calm stance (the words do not ask to stay in guard)
func combatEnd(prompt string) bool {
	return combatWords.MatchString(prompt) && !keepGuardWords.MatchString(prompt)
}

// handsUpAtEnd: over the last frames, a hand stays well above the hips (a fist at the chest or chin)
func handsUpAtEnd(pos [][][3]float32, skeleton skeletonDefinition) bool {
	h, l, r := -1, -1, -1
	for j, n := range skeleton.names {
		switch n {
		case "Hips":
			h = j
		case "LeftHand":
			l = j
		case "RightHand":
			r = j
		}
	}
	n := len(pos)
	if h < 0 || l < 0 || r < 0 || n < 8 {
		return false
	}
	up := 0.0
	for f := n - 6; f < n; f++ {
		up += float64(max(pos[f][l][1], pos[f][r][1]) - pos[f][h][1])
	}
	return up/6 > 0.15 // relaxed hanging hands sit 5 cm below to 7 cm above the hips; a rib-height "shelf" is still raised
}

// handsUpAt: one frame's hands well above the hips
func handsUpAt(p [][3]float32, skeleton skeletonDefinition) bool {
	h, l, r := -1, -1, -1
	for j, n := range skeleton.names {
		switch n {
		case "Hips":
			h = j
		case "LeftHand":
			l = j
		case "RightHand":
			r = j
		}
	}
	return h >= 0 && l >= 0 && r >= 0 && max(p[l][1], p[r][1])-p[h][1] > 0.15
}

func promptTotalText(segments []promptSegment) string {
	var b strings.Builder
	for _, s := range segments {
		b.WriteString(s.Prompt)
		b.WriteByte(' ')
	}
	return b.String()
}

// stopPose (2026-10-28): the settle pass ("stops and stands still", same seed) still ended walks mid-stride (2 of 3).
// It now also gets a place to stop: the standing pose on the last two frames, facing the way the body was going,
// a stopping distance ahead of where the first pass ended (0.3-0.9 m, from the end speed). Kimodo steps into it.
func (g *gallery) stopPose(skeletonKey string, roots, rotations []float32, skeleton skeletonDefinition, endSpeed float64, total int) (motionConstraint, bool) {
	if skeletonKey != "soma30" || total < 8 {
		return motionConstraint{}, false
	}
	var root []float64
	var rots [][]float64
	g.poses.mu.RLock()
	for _, sp := range g.poses.items {
		if sp.SkeletonKey == skeletonKey && strings.HasSuffix(strings.ToLower(sp.Name), "standing") {
			root = []float64{float64(sp.Root[0]), float64(sp.Root[1]), float64(sp.Root[2])}
			for _, r := range sp.Rotations {
				rots = append(rots, []float64{float64(r[0]), float64(r[1]), float64(r[2]), float64(r[3])})
			}
			break
		}
	}
	g.poses.mu.RUnlock()
	if root == nil {
		return motionConstraint{}, false
	}
	pos := forwardKinematics(roots, rotations, skeleton)
	n := len(pos)
	if n == 0 {
		return motionConstraint{}, false
	}
	l, r := -1, -1
	for j, name := range skeleton.names {
		switch name {
		case "LeftLeg":
			l = j
		case "RightLeg":
			r = j
		}
	}
	if l < 0 || r < 0 {
		return motionConstraint{}, false
	}
	// facing: the left-of-body vector crossed with up
	lx, lz := float64(pos[n-1][l][0]-pos[n-1][r][0]), float64(pos[n-1][l][2]-pos[n-1][r][2])
	fx, fz := -lz, lx // (left x up): left (x, 0, z) x (0, 1, 0) = (-z, 0, x)
	if norm := math.Hypot(fx, fz); norm > 1e-6 {
		fx, fz = fx/norm, fz/norm
	} else {
		return motionConstraint{}, false
	}
	h := math.Atan2(fx, fz)
	// braking room grows with speed: a 3.5 m/s runner pinned to stop within 0.9 m stuttered and recoiled backwards
	d := math.Max(0.3, math.Min(2.2, 0.5*endSpeed+0.22*endSpeed*endSpeed))
	// the stop lies ahead along the way the body was TRAVELLING, not the way it faces: a side step faces forward while
	// it moves sideways, and a stop placed ahead of its chest pulled it into a forward lunge (review 2026-10-29)
	dx, dz := fx, fz
	if k := max(0, n-11); n-1 > k {
		vx, vz := float64(roots[(n-1)*3]-roots[k*3]), float64(roots[(n-1)*3+2]-roots[k*3+2])
		if v := math.Hypot(vx, vz); v > 0.05 {
			dx, dz = vx/v, vz/v
		}
	}
	px, pz := float64(roots[(n-1)*3])+dx*d, float64(roots[(n-1)*3+2])+dz*d
	tr, tq := turnedPose(root, rots, h)
	tr = []float64{tr[0] + px, tr[1], tr[2] + pz}
	// the hips only: where the body stops, how high and which way it faces; the feet land where the last step puts
	// them (a whole standing pose made the walker shuffle its feet into that exact stance: 7-22 cm slides)
	return motionConstraint{Type: "end-effector", JointNames: []string{"Hips"}, FrameIndices: []int{total - 2, total - 1}, RootPositions: [][]float64{tr, tr},
		LocalJointsRotXYZW: [][][]float64{tq, tq}, Label: "Standing stop"}, true
}

// turnedPose: the pose turned about the vertical axis through the origin by h radians (+ = toward +X, the body's left)
func turnedPose(root []float64, rots [][]float64, h float64) ([]float64, [][]float64) {
	c, s := math.Cos(h), math.Sin(h)
	r := []float64{c*root[0] + s*root[2], root[1], -s*root[0] + c*root[2]}
	q := make([][]float64, len(rots))
	copy(q, rots)
	ys, yc := math.Sin(h/2), math.Cos(h/2)
	x, y, z, w := rots[0][0], rots[0][1], rots[0][2], rots[0][3]
	q[0] = []float64{yc*x + ys*z, yc*y + ys*w, yc*z - ys*x, yc*w - ys*y}
	return r, q
}

// characterWords: the words give the move a character (a mood, a manner, a state), so it must be in character from
// frame 1 and gets no neutral lead (owner 2026-10-29: "start off wrong and then become the animation we want")
var characterWords = regexp.MustCompile(`(?i)\b(scared|afraid|frightened|terrified|nervous|anxious|angry|furious|happy|joyful|excited|sad|depressed|tired|exhausted|weary|drunk|dizzy|injured|hurt|wounded|limping|old|elderly|zombie|confident|proud|shy|sneaky|cautious|careful|lazy|bored|energetic|aggressive|cheerful|sleepy|sick|cold|while|like an?|as if|\w+ly)\b`)
