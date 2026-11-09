package main

import (
	_ "embed"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Turn in place (2026-10-28, redone after the owner: "turn in place is pretty awful"). Kimodo turned "a person turns
// around" by spinning on planted feet. Pinning each foot on every planted frame (first fix) stopped the spin but the
// body marched stiffly and the arms flailed. What works: a few whole-body key poses of a real turn and Kimodo moving
// between them. A turn-around is three steps: anticipation (head and chest lead, weight onto the trailing foot), the
// lead foot steps open to half the turn, the trailing foot comes round to its final spot, the lead foot squares up;
// each step has a lifted mid-swing key (knee bent, foot ~10 cm up). A quarter turn is two steps. Arms hang with a
// slight lag, the chin is lifted a little. Built from the Starter standing pose with leg IK
// (tools/turnplan/build_turn.py), precomputed per angle (tools/turnplan/precompute_turns.py) into turn_keys.json.
// Measured through the server (tools/turnplan/measure_steps.py): no check flags on 12/12 takes, every step lifts
// 7-10 cm, planted feet slip at most 3 cm, feet never closer than 12 cm. Tried and dropped: a two-step turn with the
// lead foot pivoting on its ball (the legs scissored, its planted foot slipped 10 cm; blind judge 2.5/10 vs 5/10).
//
// It applies to a prompt that starts with a turn in place (no walking turn: "walks forward and turns left" is a gait),
// when the clip starts standing and no other constraint touches those frames. "Turns around and waves" is split into
// two parts (turnSplit): the turn, then "A person waves."

//go:embed move_keys.json
var moveKeysJSON []byte

type turnKeyPlan struct {
	Names         []string      `json:"names"` // what each key is ("Left foot steps open"), for the Guide list
	Frames        []int         `json:"frames"`
	RootPositions [][]float64   `json:"root_positions"`
	Rotations     [][][]float64 `json:"rotations"`
}

// moveKeyPlans: the precomputed plans by key: turns by angle ("90", "-180"), side steps by direction and count
// ("side_left_2")
func moveKeyPlans() map[string]turnKeyPlan {
	var raw struct {
		Plans map[string]turnKeyPlan `json:"plans"`
	}
	if json.Unmarshal(moveKeysJSON, &raw) != nil {
		return nil
	}
	return raw.Plans
}

// turnKeyPlans: the turn plans by angle
func turnKeyPlans() map[int]turnKeyPlan {
	out := map[int]turnKeyPlan{}
	for k, p := range moveKeyPlans() {
		if d, err := strconv.Atoi(k); err == nil && len(p.Frames) > 0 {
			out[d] = p
		}
	}
	return out
}

// Side steps (2026-10-28): Kimodo slid sideways on flat feet (steps lifted 3-5 cm, "planted" feet travelled 30-130 cm).
// The plan: the foot on that side lifts and steps out 30 cm, the weight goes over it, the other foot lifts and closes;
// as many times as fit the clip (1-4). Measured: steps lift 5-7 cm, planted feet slip at most 4 cm.
var sideStep = regexp.MustCompile(`\bside[- ]?step(s|ping|ped)?\b|\bshuffles?\s+(sideways|to\s+the\s+(left|right))|\bsteps?\s+(sideways|to\s+the\s+(left|right))`)

// sideFromPrompt: +1 (to the left) or -1 (to the right) for a prompt that starts with side steps, and how many the words
// ask for (0 = as many as fit)
func sideFromPrompt(prompt string) (int, int, bool) {
	p := strings.ToLower(prompt)
	m := sideStep.FindStringIndex(p)
	if m == nil || m[0] > len(p)/2+8 {
		return 0, 0, false
	}
	for _, w := range []string{"walk", "run", "jog", "sprint", "spin", "jump", "hop", "dance", "turn"} {
		if strings.Contains(p[:m[1]], w) {
			return 0, 0, false
		}
	}
	dir := -1
	if strings.Contains(p, "left") && (!strings.Contains(p, "right") || strings.Index(p, "left") < strings.Index(p, "right")) {
		dir = 1
	}
	n := 0
	for w, k := range map[string]int{"a step": 1, "one step": 1, "once": 1, "two steps": 2, "twice": 2, "three steps": 3, "four steps": 4} {
		if strings.Contains(p, w) {
			n = k
		}
	}
	return dir, n, true
}

var turnInPlace = regexp.MustCompile(`\b(turns?|turning|pivots?)\s+(around|round|about|to face the other way|to face backwards?|(?:to\s+(?:the|his|her|their)\s+)?(left|right)|(\d{2,3})\s*(?:degrees|deg|°))|\bfaces?\s+the\s+other\s+way|\babout[- ]face`)

// turnFromPrompt: the signed turn in radians (+ = to the left, toward +X) for a prompt that starts with a turn in place.
func turnFromPrompt(prompt string) (float64, bool) {
	p := strings.ToLower(prompt)
	m := turnInPlace.FindStringSubmatchIndex(p)
	if m == nil {
		return 0, false
	}
	// a walking or spinning turn is not a turn in place: judged on the words up to the turn ("walks forward and turns
	// left"), and on all of them when the rest happens at the same time ("turns around while walking")
	scope := p[:m[1]]
	if strings.Contains(p[m[1]:], "while") {
		scope = p
	}
	for _, w := range []string{"walk", "run", "jog", "sprint", "strafe", "march", "dash", "spin", "twirl", "pirouette", "jump", "hop", "leap", "cartwheel", "flip", "dance"} {
		if strings.Contains(scope, w) {
			return 0, false
		}
	}
	if m[0] > len(p)/2+8 { // the turn must come first: the plan puts it at the start of the clip
		return 0, false
	}
	match := p[m[0]:m[1]]
	sign := 1.0
	if strings.Contains(match, "right") || (!strings.Contains(match, "left") && strings.Contains(p[m[1]:], "to the right")) {
		sign = -1
	}
	deg := 180.0
	switch {
	case strings.Contains(match, "left") || strings.Contains(match, "right"):
		deg = 90
	case m[8] >= 0:
		d := 0.0
		for _, c := range p[m[8]:m[9]] {
			d = d*10 + float64(c-'0')
		}
		if d < 30 || d > 270 {
			return 0, false
		}
		deg = d
	}
	return sign * deg * math.Pi / 180, true
}

// turnContinues: the words go on after the turn ("turns around and waves"): the plan then stops at its squaring step
// and leaves the rest to the model. Held to the end, the standing pose swallowed the wave (2026-10-28).
func turnContinues(prompt string) bool {
	p := strings.ToLower(prompt)
	m := moveSpan(p)
	if m == nil {
		return false
	}
	rest := " " + strings.Trim(p[m[1]:], " .!") + " "
	for _, w := range []string{" and ", " then ", ", ", " before ", " while "} {
		if strings.Contains(rest, w) {
			return true
		}
	}
	return false
}

// turnSplit: a prompt that starts with a turn in place and goes on ("turns around and waves") as two parts: the turn
// alone, then the rest as its own sentence. Kept as one sentence, the turn's keys held the arms and the wave never came.
func turnSplit(prompt string) (string, string, bool) {
	_, turnOK := turnFromPrompt(prompt)
	_, _, sideOK := sideFromPrompt(prompt)
	_, _, kickOK := kickFromPrompt(prompt)
	if !(turnOK || sideOK || kickOK) || !turnContinues(prompt) {
		return "", "", false
	}
	p := strings.ToLower(prompt)
	m := moveSpan(p)
	turn := strings.TrimRight(strings.TrimSpace(prompt[:m[1]]), ",") + "."
	rest := strings.TrimSpace(prompt[m[1]:])
	for {
		r := strings.ToLower(rest)
		cut := false
		for _, w := range []string{",", "and ", "then ", "and then ", "before ", "while "} {
			if strings.HasPrefix(r, w) {
				rest, cut = strings.TrimSpace(rest[len(w):]), true
				break
			}
		}
		if !cut {
			break
		}
	}
	if len(strings.Fields(rest)) == 0 {
		return "", "", false
	}
	if !strings.HasPrefix(strings.ToLower(rest), "a person") {
		rest = "A person " + rest
	}
	return turn, rest, true
}

// Kneeling on one knee (2026-10-28): Kimodo shuffled the feet 8-13 cm on the way down (and once put the knee through
// the floor). The plan: the kneeling leg's foot steps back onto its toes, a lunge, the knee to the floor with the front
// shin leaning a little forward, held, and (when the words say so) up again with the foot stepping back in. Precomputed
// for clips of 90-180 frames. Measured: no check flags, front foot still (0 cm), the stepping foot lifts 9-10 cm.
var kneelWords = regexp.MustCompile(`\bkneel(s|ing)?\b`)

// kneelFromPrompt: which knee goes down ("Right" unless the words say left), and whether the person gets up again
func kneelFromPrompt(prompt string) (string, bool, bool) {
	p := strings.ToLower(prompt)
	m := kneelWords.FindStringIndex(p)
	if m == nil || m[0] > len(p)/2+8 || strings.Contains(p, "both knees") || strings.Contains(p, "kneeling position") {
		return "", false, false
	}
	for _, w := range []string{"walk", "run", "jog", "turn", "jump", "sits", "lies", "crawl"} {
		if strings.Contains(p[:m[1]], w) {
			return "", false, false
		}
	}
	side := "right"
	if strings.Contains(p, "left knee") {
		side = "left"
	}
	rise := false
	for _, w := range []string{"stand", "gets up", "get up", "rises", "back up", "comes up"} {
		if strings.Contains(p[m[1]:], w) {
			rise = true
		}
	}
	return side, rise, true
}

// kneelPlanFor: the longest precomputed kneel that fits the clip
func kneelPlanFor(side string, rise bool, frames int) ([]motionConstraint, int) {
	mode := map[bool]string{true: "rise", false: "stay"}[rise]
	for _, f := range []int{180, 150, 120, 90} {
		if f > frames {
			continue
		}
		if c, end := planConstraint("kneel_"+side+"_"+strconv.Itoa(f)+"_"+mode, frames, false); c != nil {
			return c, end
		}
	}
	return nil, 0
}

// Walk starts (2026-10-28): Kimodo began walks mid-stride ("starts mid-motion" on every walk); pinned standing, the
// first step dragged a foot 12 cm. The plan: standing, the weight shifts, the left foot lifts and steps forward, the
// right swings through to its first step; then the model walks on its own. Measured: 3/3 started from rest (0.14 m/s).
var walkWords = regexp.MustCompile(`^\s*(a person\s+)?(walks?|walking|strolls?|strolling|marches|marching)\b`)

func walkStartFromPrompt(prompt string) bool {
	p := strings.ToLower(prompt)
	if !walkWords.MatchString(p) {
		return false
	}
	for _, w := range []string{"backward", "sideways", "to the left", "to the right", "in a circle", "in place", "on the spot", "around"} {
		if strings.Contains(p, w) {
			return false
		}
	}
	return true
}

// walkStartConstraints: the standing start and the first two steps, for a prompt that starts with a forward walk
func (g *gallery) walkStartConstraints(skeletonKey, prompt string, frames int) []motionConstraint {
	if skeletonKey != "soma30" || !walkStartFromPrompt(prompt) {
		return nil
	}
	plan, _ := planConstraint("walkstart_left", frames, false)
	if plan == nil {
		return nil
	}
	start, ok := g.standingStart(skeletonKey, "a person stands", nil)
	if !ok {
		return nil
	}
	return append([]motionConstraint{start}, legsOnly(splitPlan(plan, "Walk start"))...)
}

// legsOnly: a plan's keys hold the hips and feet only; the arms, spine and head follow the words from the first frame.
// Whole-body keys held the arms at the sides through the plan: "walks forward looking terrified" moved its hands at
// 0.08 m/s for the first second (the fear only arrived around frame 60); hips and feet only: 0.28 m/s, hands up to the
// face by frame 13, the same lifted first steps (owner, 2026-10-29: "the take should drive the entire body from the start").
func legsOnly(cs []motionConstraint) []motionConstraint {
	out := make([]motionConstraint, len(cs))
	for i, c := range cs {
		c.Type = "end-effector"
		c.JointNames = []string{"Hips", "LeftFoot", "RightFoot"}
		out[i] = c
	}
	return out
}

// Front kicks (2026-10-28): "kicks high" reached 69-73 cm in 4 tries out of 4 (hip height ~98: the check said the move
// was missed). The plan: weight onto the standing foot, knee up (chamber), the leg out with the foot at hip height (high)
// or waist height, recoil, foot down. Measured: high kicks reach hip height 3/3. Roundhouse, side, back, spinning and
// jumping kicks and kicking a ball are left to the model (this is a front kick).
var kickWords = regexp.MustCompile(`\bkick(s|ing)?\b`)

func kickFromPrompt(prompt string) (string, bool, bool) {
	p := strings.ToLower(prompt)
	m := kickWords.FindStringIndex(p)
	if m == nil || m[0] > len(p)/2+8 {
		return "", false, false
	}
	for _, w := range []string{"roundhouse", "side kick", "sidekick", "back kick", "spin", "jump", "ball", "turning", "flying", "walk", "run", "sweep", "kicks back", "backward"} {
		if strings.Contains(p, w) {
			return "", false, false
		}
	}
	leg := "right"
	if strings.Contains(p, "left leg") || strings.Contains(p, "left foot") {
		leg = "left"
	}
	return leg, strings.Contains(p, "high") || strings.Contains(p, "head"), true
}

// Hit and stagger back (2026-10-28): Kimodo slid the feet back 19 cm (2/2). The plan: the chest and head thrown back
// on the impact, two catching steps backward (each foot lifted), balanced again. Measured: 2/3 clean, real steps.
var hitWords = regexp.MustCompile(`\b(hit|hits|struck|shoved|pushed|punched|kicked|shot|slapped)\b`)
var staggerWords = regexp.MustCompile(`\b(stagger(s|ing)?|stumbles?|stumbling|reels?|reeling|knocked back|recoils?)\b`)

func staggerFromPrompt(prompt string) bool {
	p := strings.ToLower(prompt)
	if !hitWords.MatchString(p) || !staggerWords.MatchString(p) {
		return false
	}
	for _, w := range []string{"falls down", "falls over", "to the ground", "to the floor", "collapses", "dies", "forward", "sideways"} {
		if strings.Contains(p, w) {
			return false
		}
	}
	return true
}

// moveSpan: where the planned move's words are (a turn in place or side steps)
func moveSpan(p string) []int {
	if m := turnInPlace.FindStringIndex(p); m != nil {
		return m
	}
	if m := kickWords.FindStringIndex(p); m != nil {
		// "kicks high with the right leg": the words that belong to the kick come with it
		if d := regexp.MustCompile(`^(\s+(high|low|forward|out|hard|fast|quickly))*(\s+with\s+(the|his|her|their)\s+(left|right)\s+(leg|foot))?`).FindStringIndex(p[m[1]:]); d != nil {
			m[1] += d[1]
		}
		return m
	}
	if m := sideStep.FindStringIndex(p); m != nil {
		// "sidesteps to the right": the direction belongs to the move
		if d := regexp.MustCompile(`^\s+(to\s+the\s+)?(left|right)\b`).FindStringIndex(p[m[1]:]); d != nil {
			m[1] += d[1]
		}
		return m
	}
	return nil
}

// turnPlanFor: the key-pose plan nearest the asked turn (45-degree steps, same direction), as one fullbody constraint,
// and its last frame; nil when the clip is too short to finish it and settle. open: leave off the final standing
// frames (the words carry on after the turn).
func turnPlanFor(turn float64, frames int, open ...bool) ([]motionConstraint, int) {
	deg := turn * 180 / math.Pi
	best, bestD := 0, math.Inf(1)
	for d := range turnKeyPlans() {
		if (d > 0) != (deg > 0) {
			continue
		}
		if x := math.Abs(float64(d) - deg); x < bestD {
			best, bestD = d, x
		}
	}
	return planConstraint(strconv.Itoa(best), frames, len(open) > 0 && open[0])
}

// sidePlanFor: the side-step plan for that direction, with the asked number of steps, or as many as fit the clip
func sidePlanFor(dir, steps, frames int, open bool) ([]motionConstraint, int) {
	side := map[int]string{1: "left", -1: "right"}[dir]
	if steps == 0 {
		steps = max(1, min(4, (frames-22)/20))
	}
	for n := steps; n >= 1; n-- {
		if c, end := planConstraint("side_"+side+"_"+strconv.Itoa(n), frames, open); c != nil {
			return c, end
		}
	}
	return nil, 0
}

// planConstraint: a precomputed plan as one fullbody constraint and its last frame; nil when the clip is too short to
// finish it and settle. open: leave off the final standing frames (the words carry on after the move).
func planConstraint(key string, frames int, open bool) ([]motionConstraint, int) {
	p, ok := moveKeyPlans()[key]
	if !ok || len(p.Frames) == 0 {
		return nil, 0
	}
	n := len(p.Frames)
	if open && n > 2 {
		n -= 2 // the last two frames are the standing pose at the end
	}
	end := p.Frames[n-1]
	if end+6 > frames {
		return nil, 0
	}
	c := motionConstraint{Type: "fullbody", FrameIndices: p.Frames[:n], RootPositions: p.RootPositions[:n], LocalJointsRotXYZW: p.Rotations[:n]}
	if len(p.Names) >= n {
		c.Label = strings.Join(p.Names[:n], "\x1f") // split again by splitPlan
	}
	return []motionConstraint{c}, end
}

// turnInPlaceConstraints: the key-pose plan for a prompt that starts with a turn in place, on top of the standing start
// (its frames 0-3), when nothing else is pinned from frame 4 on through the plan.
// plannedMoves: the key-pose plans in use. Blind HUMAN-FEEL A/B against free Kimodo, same seeds, 2026-10-28 (feel /10,
// planned vs free): stagger 9, 8.5 vs 3, 2 (free kept both feet glued) and the walk start 8, 6 vs 4, 3 won; kick 2, 2 vs
// 9, 8; turn 3, 3 vs 9, 8; side step 2.5, 2 vs 8.5, 5.5; kneel 2.5, 3 vs 7.5, 8.5 lost ("robotic hinge, dead arms,
// rigid spine, frozen bookends"). A plan comes back only when it beats free Kimodo on human feel.
var plannedMoves = map[string]bool{"stagger": true}

func (g *gallery) turnInPlaceConstraints(skeletonKey, prompt string, frames int, existing []motionConstraint) []motionConstraint {
	if skeletonKey != "soma30" {
		return nil // the keys are SOMA poses
	}
	var plan []motionConstraint
	var end int
	var name string
	if turn, ok := turnFromPrompt(prompt); ok && plannedMoves["turn"] {
		plan, end = turnPlanFor(turn, frames, turnContinues(prompt))
		deg := int(math.Round(math.Abs(turn) * 180 / math.Pi))
		name = map[bool]string{true: "Turn left", false: "Turn right"}[turn > 0] + " " + strconv.Itoa(deg) + "°"
		if deg >= 170 {
			name = "Turn around"
		}
	} else if dir, n, ok := sideFromPrompt(prompt); ok && plannedMoves["side"] {
		plan, end = sidePlanFor(dir, n, frames, turnContinues(prompt))
		name = map[int]string{1: "Side steps left", -1: "Side steps right"}[dir]
	} else if side, rise, ok := kneelFromPrompt(prompt); ok && plannedMoves["kneel"] {
		plan, end = kneelPlanFor(side, rise, frames)
		name = "Kneel on the " + side + " knee"
	} else if staggerFromPrompt(prompt) && plannedMoves["stagger"] {
		plan, end = planConstraint("stagger", frames, false)
		name = "Hit and stagger back"
	} else if leg, high, ok := kickFromPrompt(prompt); ok && plannedMoves["kick"] {
		h := map[bool]string{true: "high", false: "mid"}[high]
		plan, end = planConstraint("kick_"+leg+"_"+h, frames, turnContinues(prompt))
		name = map[bool]string{true: "High kick", false: "Kick"}[high] + ", " + leg + " leg"
	}
	if plan == nil {
		return nil
	}
	for _, c := range existing {
		if c.Type == "fullbody" && len(c.FrameIndices) > 0 && c.FrameIndices[len(c.FrameIndices)-1] < 4 {
			continue // the standing start
		}
		for _, f := range c.FrameIndices {
			if f >= 4 && f <= end {
				return nil
			}
		}
	}
	out := legsOnly(splitPlan(plan, name)) // hips and feet only: the words drive the arms, spine and head (see legsOnly)
	// a move that ends standing, with time left over: the hips held where it ended to the last frame (Kimodo wandered
	// or kept moving through 50 free frames after a kick or a stagger, 2 takes in 10; the idle is trimmed afterwards)
	if p := plan[len(plan)-1]; !turnContinues(prompt) && frames-1-end > 20 && len(p.RootPositions) > 0 {
		r, q := p.RootPositions[len(p.RootPositions)-1], p.LocalJointsRotXYZW[len(p.LocalJointsRotXYZW)-1]
		out = append(out, motionConstraint{Type: "end-effector", JointNames: []string{"Hips"}, FrameIndices: []int{frames - 2, frames - 1},
			RootPositions: [][]float64{r, r}, LocalJointsRotXYZW: [][][]float64{q, q}, Label: "Standing still"})
	}
	return out
}

// splitPlan: one labelled key per frame, so each step shows on the Guide lane as its own key and, loaded into the
// Guide card, can be retimed, removed or replaced by a pose of the person's own (owner, 2026-10-28: everything the
// tool decides should be visible and adjustable)
func splitPlan(plan []motionConstraint, name string) []motionConstraint {
	type group struct {
		step   string
		frames []int
		roots  [][]float64
		rots   [][][]float64
		typ    string
	}
	var groups []group
	for _, c := range plan {
		steps := strings.Split(c.Label, "")
		for i, f := range c.FrameIndices {
			step := ""
			if len(steps) == len(c.FrameIndices) {
				step = steps[i]
			}
			// the same step on the next frame (the final standing pose is held two frames): one key, not two
			if n := len(groups); n > 0 && step != "" && groups[n-1].step == step && f == groups[n-1].frames[len(groups[n-1].frames)-1]+1 {
				g := &groups[n-1]
				g.frames, g.roots, g.rots = append(g.frames, f), append(g.roots, c.RootPositions[i]), append(g.rots, c.LocalJointsRotXYZW[i])
				continue
			}
			groups = append(groups, group{step, []int{f}, [][]float64{c.RootPositions[i]}, [][][]float64{c.LocalJointsRotXYZW[i]}, c.Type})
		}
	}
	out := make([]motionConstraint, 0, len(groups))
	for i, g := range groups {
		label := name + " " + strconv.Itoa(i+1) + "/" + strconv.Itoa(len(groups))
		if g.step != "" {
			label += " · " + g.step
		}
		out = append(out, motionConstraint{Type: g.typ, FrameIndices: g.frames, RootPositions: g.roots, LocalJointsRotXYZW: g.rots, Label: label})
	}
	return out
}
