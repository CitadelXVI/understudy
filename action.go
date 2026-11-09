// Action checks: does the clip do what its prompt names? Kimodo often makes something near the prompt (a "front flip"
// that dives into a roll, a "jump" that is a long stride, a "sit down" that starts seated). For prompts whose verb has
// a measurable meaning the clip is checked, and a miss is the flag "action" with what was missing. Takes are ranked by
// flags, so with several takes the one that really flips is shown. SOMA skeleton (body proxy) only.
package main

import (
	"fmt"
	"math"
	"strings"
)

type actionCheck struct {
	ok    bool
	notes []string
}

func promptText(a *animation) string {
	var parts []string
	for _, s := range a.Segments {
		parts = append(parts, s.Prompt)
	}
	if len(parts) == 0 {
		parts = append(parts, a.Prompt)
	}
	return strings.ToLower(strings.Join(parts, " "))
}

// hasWord: the phrase appears as whole words ("lying" is not in "flying", "run" is not in "drunk")
func hasWord(text string, words ...string) bool {
	isLetter := func(b byte) bool { return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' }
	for _, w := range words {
		for i := strings.Index(text, w); i >= 0; {
			if (i == 0 || !isLetter(text[i-1])) && (i+len(w) >= len(text) || !isLetter(text[i+len(w)])) {
				return true
			}
			j := strings.Index(text[i+1:], w)
			if j < 0 {
				break
			}
			i += 1 + j
		}
	}
	return false
}

func tokenIndex(text string, words ...string) int {
	for i, f := range strings.FieldsFunc(text, func(r rune) bool { return !(r >= 'a' && r <= 'z') }) {
		for _, w := range words {
			if f == w {
				return i
			}
		}
	}
	return -1
}

func hasToken(text string, words ...string) bool {
	return tokenIndex(text, words...) >= 0
}

// withAction adds the action flag (and notes) to metrics computed for a clip with this prompt.
func withAction(m *clipMetrics, prompt string, roots, rotations []float32, skeleton skeletonDefinition, props ...stageProp) *clipMetrics {
	if m == nil || prompt == "" {
		return m
	}
	if isFallPrompt(strings.ToLower(prompt)) { // a falling body is off balance by design
		kept := m.Flags[:0]
		for _, f := range m.Flags {
			if f != "balance" {
				kept = append(kept, f)
			}
		}
		m.Flags = kept
	}
	c := checkAction(strings.ToLower(prompt), roots, rotations, skeleton, props...)
	if c == nil {
		return m
	}
	m.ActionNotes = c.notes
	if !c.ok {
		m.Flags = append(m.Flags, "action")
	}
	return m
}

// withActionClip: withAction for a clip, which knows its pins. A clip with a Point (reach.go) changes posture at the
// touch by design -- it walks up, then stoops or reaches -- so "the character arrives late" (the first second's posture
// against the rest, meant for a styled walk) does not apply: it flagged every walk-up pickup and sent it round the
// retries for a posture change the pin asked for.
func withActionClip(m *clipMetrics, a *animation, roots, rotations []float32, skeleton skeletonDefinition) *clipMetrics {
	m = withAction(m, promptText(a), roots, rotations, skeleton, a.Props...)
	if m == nil || !hasReach(a.Constraints) || len(m.ActionNotes) == 0 {
		return m
	}
	notes := m.ActionNotes[:0:0]
	for _, n := range m.ActionNotes {
		if !strings.HasPrefix(n, "the character arrives late") {
			notes = append(notes, n)
		}
	}
	m.ActionNotes = notes
	if len(notes) == 0 {
		kept := m.Flags[:0:0]
		for _, f := range m.Flags {
			if f != "action" {
				kept = append(kept, f)
			}
		}
		m.Flags = kept
	}
	return m
}

func checkAction(p string, roots, rotations []float32, skeleton skeletonDefinition, props ...stageProp) *actionCheck {
	if bodyProxies[skeleton.key] == nil {
		return nil
	}
	pos := forwardKinematics(roots, rotations, skeleton)
	cf := contactFrames(roots, rotations, skeleton, clipFloor(pos, skeleton), props...)
	frames := len(pos)
	if frames < 10 || cf == nil {
		return nil
	}
	ix := map[string]int{}
	for i, n := range skeleton.names {
		ix[n] = i
	}
	hips, chest := ix["Hips"], ix["Chest"]
	up := func(f int) [3]float64 {
		a, b := pos[f][hips], pos[f][chest]
		v := [3]float64{float64(b[0] - a[0]), float64(b[1] - a[1]), float64(b[2] - a[2])}
		l := math.Sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2])
		return [3]float64{v[0] / l, v[1] / l, v[2] / l}
	}
	// total turn of the trunk in the plane across `axis` (a horizontal axis fixed at frame 0)
	turn := func(axis [3]float64) float64 {
		total, maxAbs := 0.0, 0.0
		proj := func(v [3]float64) [3]float64 {
			d := v[0]*axis[0] + v[1]*axis[1] + v[2]*axis[2]
			w := [3]float64{v[0] - d*axis[0], v[1] - d*axis[1], v[2] - d*axis[2]}
			l := math.Sqrt(w[0]*w[0] + w[1]*w[1] + w[2]*w[2])
			if l < 1e-9 {
				return w
			}
			return [3]float64{w[0] / l, w[1] / l, w[2] / l}
		}
		prev := proj(up(0))
		for f := 1; f < frames; f++ {
			cur := proj(up(f))
			cx := prev[1]*cur[2] - prev[2]*cur[1]
			cy := prev[2]*cur[0] - prev[0]*cur[2]
			cz := prev[0]*cur[1] - prev[1]*cur[0]
			s := cx*axis[0] + cy*axis[1] + cz*axis[2]
			total += math.Atan2(s, prev[0]*cur[0]+prev[1]*cur[1]+prev[2]*cur[2])
			maxAbs = math.Max(maxAbs, math.Abs(total))
			prev = cur
		}
		return maxAbs * 180 / math.Pi
	}
	// the body's side (left-right) and forward axes at frame 0, horizontal
	l, r := pos[0][ix["LeftLeg"]], pos[0][ix["RightLeg"]]
	side := [3]float64{float64(l[0] - r[0]), 0, float64(l[2] - r[2])}
	sl := math.Hypot(side[0], side[2])
	side = [3]float64{side[0] / sl, 0, side[2] / sl}
	fwd := [3]float64{-side[2], 0, side[0]}
	touching := func(f int, names ...string) bool {
		for _, n := range names {
			if v, ok := cf[f].low[n]; ok && v < touchM {
				return true
			}
		}
		return false
	}
	trunk := []string{"Head", "Neck1", "Neck2", "Chest", "Spine1", "Spine2", "Hips", "LeftShoulder", "RightShoulder"}
	feet := []string{"LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase"}
	endsUpright := func() bool {
		u := up(frames - 1)
		return u[1] > 0.8 && touching(frames-1, feet...)
	}
	c := &actionCheck{ok: true}
	miss := func(format string, args ...any) {
		c.ok = false
		c.notes = append(c.notes, fmt.Sprintf(format, args...))
	}
	matched := false

	switch {
	case hasWord(p, "flip", "somersault", "handspring", "walkover"):
		matched = true
		if t := turn(side); t < 300 {
			miss("no full flip (the body turns %.0f° of 360)", t)
		}
		inverted, grounded := 0, 0
		for f := 0; f < frames; f++ {
			if up(f)[1] < 0 {
				inverted++
				if touching(f, trunk...) {
					grounded++
				}
			}
		}
		if grounded > 2 {
			miss("touches down on the head or back mid-flip (%d frames) — a roll, not a flip", grounded)
		}
		// a flip or handspring goes through the hands, not onto them: a take that pauses in a handstand (hands planted
		// while inverted for more than a quarter second; a real handspring plants them 3–5 frames) is a miss
		onHands := 0
		for f := 0; f < frames; f++ {
			if up(f)[1] < 0 && touching(f, "LeftHand", "RightHand") {
				onHands++
			}
		}
		if onHands > 8 {
			miss("pauses on the hands mid-move (%d frames in a handstand)", onHands)
		}
		if !endsUpright() {
			miss("does not land on its feet")
		}
	case hasWord(p, "cartwheel", "round-off", "roundoff"):
		matched = true
		if t := turn(fwd); t < 300 {
			miss("no full cartwheel (the body turns sideways %.0f° of 360)", t)
		}
		if !endsUpright() {
			miss("does not end on its feet")
		}
	}
	if hasWord(p, "jump", "leap", "hop") && !hasWord(p, "jumping jack") {
		matched = true
		run, best := 0, 0
		for f := 0; f < frames; f++ {
			if cf[f].gap > 0.03 {
				run++
				best = max(best, run)
			} else {
				run = 0
			}
		}
		if best < 6 {
			miss("never leaves the floor for long (%d frames in the air)", best)
		}
	}
	if _, ok := prerollPrompt(p); ok && frames >= 120 {
		matched = true
		// the character arrives late: a continuous movement ("walks forward while scared") whose first second has another
		// posture than the rest (knee bend, head, trunk, hands). Blind start judges, 84 takes: posture change 3+ scored
		// 1.8/10 for the start (n=22), under 3 scored 5.5 (owner: "start off wrong and then become the animation we want")
		post := func(f int) [5]float64 {
			unit := func(a, b int) [3]float64 {
				d := [3]float64{float64(pos[f][b][0] - pos[f][a][0]), float64(pos[f][b][1] - pos[f][a][1]), float64(pos[f][b][2] - pos[f][a][2])}
				l := math.Sqrt(d[0]*d[0] + d[1]*d[1] + d[2]*d[2])
				return [3]float64{d[0] / l, d[1] / l, d[2] / l}
			}
			knee := func(s string) float64 {
				a, b, c := pos[f][ix[s+"Leg"]], pos[f][ix[s+"Shin"]], pos[f][ix[s+"Foot"]]
				u := [3]float64{float64(a[0] - b[0]), float64(a[1] - b[1]), float64(a[2] - b[2])}
				v := [3]float64{float64(c[0] - b[0]), float64(c[1] - b[1]), float64(c[2] - b[2])}
				return math.Acos(math.Max(-1, math.Min(1, (u[0]*v[0]+u[1]*v[1]+u[2]*v[2])/math.Sqrt((u[0]*u[0]+u[1]*u[1]+u[2]*u[2])*(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]))))) * 180 / math.Pi
			}
			lh, rh := pos[f][ix["LeftHand"]], pos[f][ix["RightHand"]]
			spread := math.Sqrt(sq(lh[0]-rh[0]) + sq(lh[1]-rh[1]) + sq(lh[2]-rh[2]))
			return [5]float64{unit(hips, ix["Neck1"])[1] * 10, unit(ix["Neck1"], ix["Head"])[1] * 10, (knee("Left") + knee("Right")) / 20,
				(float64(lh[1]+rh[1])/2 - float64(pos[f][hips][1])) * 10, spread * 10}
		}
		mean := func(a, b int) [5]float64 {
			var m [5]float64
			for f := a; f < b; f++ {
				v := post(f)
				for k := range m {
					m[k] += v[k] / float64(b-a)
				}
			}
			return m
		}
		early, late := mean(3, 33), mean(45, min(frames-20, 150))
		d := 0.0
		for k := range early {
			d += (early[k] - late[k]) * (early[k] - late[k])
		}
		if d = math.Sqrt(d); d >= lateStartChange {
			miss("the character arrives late: the first second moves like someone else (posture change %.1f)", d)
		} else if styledMove(p) {
			// the character never shows at the start: a styled movement ("walks forward while scared") whose first second
			// is a plain walk's posture. Blind start judges, 180 takes: within 1.0 of a plain walk 2.8/10, further 4.8
			plain := [5]float64{9.96, 6.26, 14.86, -1.30, 5.24} // 8 plain "walks forward and stops" takes, mid-walk
			e := 0.0
			for k := range early {
				e += (early[k] - plain[k]) * (early[k] - plain[k])
			}
			if e = math.Sqrt(e); e < plainStartDistance {
				miss("the character does not show at the start: the first second is a plain walk (distance %.1f)", e)
			}
		}
	}
	if hasWord(p, "punch", "punches", "jab", "jabs") && !hasWord(p, "punching bag", "gets punched", "is punched") {
		// a punch is a fast fist in front of the chest: blind judges scored lazy arm swings (fist under 2.5 m/s, at hip
		// height) 2-3/10 and a 5.2 m/s punch at chest height 6-8/10 (2026-10-29). Reach alone says nothing: a hanging
		// arm is straight too.
		matched = true
		hands := []string{"RightHand", "LeftHand"}
		if hasWord(p, "right") && !hasWord(p, "left") {
			hands = []string{"RightHand"}
		} else if hasWord(p, "left") && !hasWord(p, "right") {
			hands = []string{"LeftHand"}
		}
		ch := ix["Chest"]
		best := 0.0
		for _, n := range hands {
			h, ok := ix[n]
			if !ok {
				continue
			}
			for f := 1; f < frames; f++ {
				d := [3]float64{float64(pos[f][h][0] - pos[f][ch][0]), float64(pos[f][h][1] - pos[f][ch][1]), float64(pos[f][h][2] - pos[f][ch][2])}
				front := d[0]*fwd[0] + d[2]*fwd[2]
				if front < 0.40 || d[1] < -0.10 {
					continue
				}
				v := math.Sqrt(sq(pos[f][h][0]-pos[f-1][h][0])+sq(pos[f][h][1]-pos[f-1][h][1])+sq(pos[f][h][2]-pos[f-1][h][2])) * 30
				best = math.Max(best, v)
			}
		}
		if best < 3.5 {
			miss("no real punch: the fist never moves fast in front of the chest (%.1f m/s, needs 3.5)", best)
		}
	}
	if hasToken(p, "kick", "kicks", "kicking") && !hasWord(p, "kick off", "kicks off", "gets kicked", "is kicked") {
		// a kick snaps the leg out at strike height: blind judges scored a slow hip-height float (3.1 m/s, 98 cm) 4-5/10
		// and a bent-knee chamber that folded back limp (137° max knee) 3/10, while straight snaps (152-166°, 3.7-7.3 m/s) pass
		matched = true
		need, what := 0.50, "a kick"
		if hasToken(p, "high") {
			need, what = float64(pos[0][hips][1])-clipFloor(pos, skeleton)+0.05, "a high kick (above hip height)"
		}
		sides := []string{"Right", "Left"}
		if hasWord(p, "right leg", "right foot", "right kick") && !hasWord(p, "left leg", "left foot", "left kick") {
			sides = []string{"Right"}
		} else if hasWord(p, "left leg", "left foot", "left kick") && !hasWord(p, "right leg", "right foot", "right kick") {
			sides = []string{"Left"}
		}
		zone := 0.80 * need
		top, bestKnee, bestSpeed, inZone := 0.0, 0.0, 0.0, false
		for _, s := range sides {
			leg, ok1 := ix[s+"Leg"]
			shin, ok2 := ix[s+"Shin"]
			foot, ok3 := ix[s+"Foot"]
			if !ok1 || !ok2 || !ok3 {
				continue
			}
			for f := 0; f < frames; f++ {
				lo := cf[f].low[s+"Foot"]
				top = math.Max(top, lo)
				if lo < zone {
					continue
				}
				inZone = true
				pa, pb, pc := pos[f][leg], pos[f][shin], pos[f][foot]
				u := [3]float64{float64(pa[0] - pb[0]), float64(pa[1] - pb[1]), float64(pa[2] - pb[2])}
				v := [3]float64{float64(pc[0] - pb[0]), float64(pc[1] - pb[1]), float64(pc[2] - pb[2])}
				den := math.Sqrt((u[0]*u[0] + u[1]*u[1] + u[2]*u[2]) * (v[0]*v[0] + v[1]*v[1] + v[2]*v[2]))
				if den > 1e-9 {
					k := math.Acos(math.Max(-1, math.Min(1, (u[0]*v[0]+u[1]*v[1]+u[2]*v[2])/den))) * 180 / math.Pi
					bestKnee = math.Max(bestKnee, k)
				}
				if f > 0 {
					spd := math.Sqrt(sq(pos[f][foot][0]-pos[f-1][foot][0])+sq(pos[f][foot][1]-pos[f-1][foot][1])+sq(pos[f][foot][2]-pos[f-1][foot][2])) * fps
					bestSpeed = math.Max(bestSpeed, spd)
				}
			}
		}
		if top < need {
			miss("the foot never gets high enough for %s (%.0f cm, needs %.0f)", what, top*100, need*100)
		}
		if inZone && bestKnee < 146 {
			miss("bent-knee kick: the knee straightens only to %.0f° at kick height (needs 146°)", bestKnee)
		}
		if inZone && bestSpeed < 3.5 {
			miss("limp kick: the foot moves at %.1f m/s at kick height (needs 3.5)", bestSpeed)
		}
	}
	if runAt := tokenIndex(p, "run", "runs", "running", "sprint", "sprints", "sprinting", "jog", "jogs", "jogging"); runAt >= 0 &&
		!hasWord(p, "run out", "runs out", "running out", "run into", "runs into", "running into", "run-up", "run up") {
		// running and jogging have flight phases (both feet off the floor, gap > touchM): Kimodo sometimes crouch-walks
		// double-support steps instead (0-4 airborne frames, or walking the first 2 seconds before breaking into a run:
		// r4 run take 2 had 1 airborne frame in its first moving half and scored 4/10, while real runs/jogs have 7-18)
		matched = true
		airTotal := 0
		m0, m1 := -1, -1
		for f := 0; f < frames; f++ {
			if cf[f].gap > touchM {
				airTotal++
			}
			if f > 0 {
				v := math.Hypot(float64(roots[f*3]-roots[(f-1)*3]), float64(roots[f*3+2]-roots[(f-1)*3+2])) * fps
				if v >= 0.8 {
					if m0 < 0 {
						m0 = f
					}
					m1 = f
				}
			}
		}
		walkAt := tokenIndex(p, "walk", "walks", "walking")
		walkFirst := walkAt >= 0 && walkAt < runAt
		if airTotal < 6 {
			miss("never leaves the floor to run (%d frames in the air, needs 6)", airTotal)
		} else if !walkFirst && m1-m0 >= 30 {
			// the first half of the FAST stretch: a sprint launch drives for its first second with both feet on the
			// floor before any flight (a 6.5 m/s launch was called "walks instead of running" here, 2026-10-30)
			fast := m0
			for f := m0; f <= m1; f++ {
				if f+1 < len(pos) && rootSpeedAt(pos, f) >= 2.0 {
					fast = f
					break
				}
			}
			mid := (fast + m1) / 2
			airEarly := 0
			for f := fast; f <= mid; f++ {
				if cf[f].gap > touchM {
					airEarly++
				}
			}
			if airEarly < 3 {
				miss("walks instead of running for the first half (%d frames in the air, needs 3)", airEarly)
			}
		}
	}
	if hasWord(p, "sit", "sits", "seated") && hasWord(p, "floor", "ground") {
		matched = true
		// sitting = the pelvis on the floor for a while; a deep squat brushes the floor for a frame and is not a sit
		sat, run := false, 0
		for f := 0; f < frames; f++ {
			if touching(f, "Hips") {
				run++
				if run >= 8 {
					sat = true
					break
				}
			} else {
				run = 0
			}
		}
		if !sat {
			miss("never sits on the floor (the pelvis never rests on it)")
		}
		if hasWord(p, "sits down", "sit down") && touching(0, "Hips") {
			miss("starts already seated: the sit-down is missing")
		}
	}
	// a move that ends standing ("stands back up", "gets up") must end upright: a stooped stand (trunk 25+ degrees off
	// vertical over the last frames) is the move half done (a floor sit came back as a hunched lean, 2026-10-30)
	if hasWord(p, "stands up", "stands back up", "stand up", "stand back up", "gets up", "get up", "gets back up", "rises to", "stands up again", "and stands") && frames > 12 {
		matched = true
		lean := 0.0
		for f := frames - 8; f < frames; f++ {
			lean += up(f)[1]
		}
		if lean/8 < 0.9 {
			miss("ends stooped (trunk %.0f degrees off vertical) instead of standing upright", math.Acos(math.Max(-1, math.Min(1, lean/8)))*180/math.Pi)
		}
	}
	if hasWord(p, "kneel") {
		matched = true
		knelt := false
		for f := 0; f < frames && !knelt; f++ {
			knelt = touching(f, "LeftShin", "RightShin")
		}
		if !knelt {
			miss("no knee ever reaches the floor")
		}
		if hasWord(p, "kneels down", "kneel down") && touching(0, "LeftShin", "RightShin") {
			miss("starts already kneeling: the kneel-down is missing")
		}
	}
	if hasWord(p, "crouch", "crouches", "squat", "squats", "ducks down", "duck down") {
		matched = true
		stand := float64(pos[0][hips][1]) - clipFloor(pos, skeleton)
		lowest := stand
		for f := 0; f < frames; f++ {
			lowest = math.Min(lowest, float64(pos[f][hips][1])-clipFloor(pos, skeleton))
		}
		if lowest > 0.70 {
			miss("never crouches (the hips stay at %.0f cm)", lowest*100)
		}
		if hasWord(p, "crouches down", "crouch down", "squats down", "squat down", "ducks down", "duck down") && stand < 0.72 {
			miss("starts already crouched (hips at %.0f cm): the crouch-down is missing", stand*100)
		}
	}
	if hasWord(p, "lie down", "lies down", "lying", "lay down", "lays down") {
		matched = true
		lay := false
		for f := 0; f < frames && !lay; f++ {
			lay = math.Abs(up(f)[1]) < 0.5 && touching(f, "Chest", "Spine1", "Spine2", "Hips")
		}
		if !lay {
			miss("never lies on the floor")
		}
		if hasWord(p, "lies down", "lie down", "lays down") && math.Abs(up(0)[1]) < 0.5 {
			miss("starts already lying: the lie-down is missing")
		}
	}
	if hasWord(p, "push-up", "pushup", "push up") {
		matched = true
		down := 0
		for f := 0; f < frames; f++ {
			if math.Abs(up(f)[1]) < 0.6 && touching(f, "LeftHand", "RightHand") {
				down++
			}
		}
		if down < frames/3 {
			miss("the hands are not on the floor in a push-up position (%d frames)", down)
		}
	}
	// A fall: starts upright, ends down on the floor, and never leaves the floor on the way (a body that launches
	// into the air spinning is a dive or a flip, which Kimodo offers for "falls over" now and then)
	if isFallPrompt(p) {
		matched = true
		if !hasWord(p, "lying", "sitting", "kneeling", "seated") && (up(0)[1] < 0.8 || !touching(0, feet...)) {
			miss("starts already down: the fall is missing")
		}
		// down = trunk horizontal and within 8 cm of the floor with something touching (a body lying propped on its
		// hands and toes after Clean up lifted its feet out of the floor is still down)
		trunkLow := func(f int) float64 {
			lo := math.Inf(1)
			for _, n := range trunk {
				if v, ok := cf[f].low[n]; ok {
					lo = math.Min(lo, v)
				}
			}
			return lo
		}
		down := 0
		for f := max(0, frames-8); f < frames; f++ {
			if math.Abs(up(f)[1]) < 0.6 && trunkLow(f) < 0.08 && cf[f].gap <= 0.03 {
				down++
			}
		}
		if down < 4 {
			miss("never ends up on the floor")
		}
		run, best := 0, 0
		for f := 0; f < frames; f++ {
			if cf[f].gap > 0.03 {
				run++
				best = max(best, run)
			} else {
				run = 0
			}
		}
		if best >= 5 {
			miss("leaves the floor for %d frames (a dive, not a fall)", best)
		}
	}
	if hasWord(p, "stands up", "stand up", "gets up", "get up", "then stands", "and stands") && !endsUpright() {
		matched = true
		miss("does not end standing")
	}
	// Every move that is not a floor move ends on its feet, upright. Kimodo sometimes leaves a body upside down in a
	// handstand or hanging in the air after an acrobatic move; kept as it is, the settle trim then froze that pose for
	// fifty frames (a back handspring ended as a frozen inverted hover). Such a take is a miss to retry.
	if !floorMove(p) {
		u := up(frames - 1)
		switch {
		case u[1] < 0.3:
			matched = true
			miss("ends upside down or lying (not on its feet)")
		case !touching(frames-1, feet...):
			matched = true
			miss("ends with no foot on the floor")
		}
	}
	if !matched {
		return nil
	}
	return c
}

// A prompt whose end state is on the floor or inverted on purpose.
func floorMove(p string) bool {
	return hasWord(p, "lie", "lying", "lies", "lay", "sit", "seated", "kneel", "crawl", "push-up", "pushup", "push up", "plank", "handstand", "headstand", "bridge", "roll", "floor", "ground", "yoga", "stretch", "crouch", "squat", "fall", "collapse", "faint", "trip", "swim", "climb", "hang", "jump", "leap", "hop", "dive")
}

func isFallPrompt(p string) bool {
	if hasWord(p, "from the sky", "jump", "dive", "asleep") {
		return false
	}
	return hasWord(p, "falls over", "fall over", "falls down", "fall down", "falls to the", "falls on", "falls onto", "falls backward", "falls forward", "falls flat", "falls off", "collapses", "faints", "trips", "stumbles and falls", "knocked down", "knocked over", "falls back")
}

// Clearer wordings for moves Kimodo often half-does, tried on retries (the first take always uses the user's words).
// Measured on 8 seeds each: "does a front flip" 2/8 real flips, "does an aerial front flip and lands on their feet"
// 5/8; "jumps forward" ~0/8 off the floor, "jumps forward with both feet, high in the air" 5/8.
var retryWordings = []struct{ match, use string }{
	{"does a front flip", "does an aerial front flip and lands on their feet"},
	{"does a backflip", "does an aerial backflip and lands on their feet"},
	{"does a back flip", "does an aerial back flip and lands on their feet"},
	{"jumps forward", "jumps forward with both feet, high in the air"},
	{"jumps for joy", "jumps up and down for joy with both feet, high in the air, arms raised"},
	{"jumps up", "jumps straight up with both feet, high in the air"},
	{"falls over", "loses their balance, falls over onto the floor and lies still"},
	// turns: Kimodo spins the body on planted feet; asked for steps it steps ("by taking two steps" 1/2 clean)
	{"turns around to face the other way", "pivots and steps around 180 degrees to face the opposite way, then stands upright and still"},
	{"turns around", "pivots and steps around 180 degrees to face the opposite way, then stands upright and still"},
	{"turns to face", "takes two steps to turn and face"},
	{"turns left", "takes a step to turn left"},
	{"turns right", "takes a step to turn right"},
	{"sidesteps", "takes two small sidesteps"},
	{"crouches down", "bends the knees to crouch down"},
	{"kicks high with the right leg", "swings their right leg straight up in a fast high front kick, sets the right foot back on the floor, and stands relaxed with arms down"},
	{"kicks high with the left leg", "swings their left leg straight up in a fast high front kick, sets the left foot back on the floor, and stands relaxed with arms down"},
}

// Clearer wordings used from the FIRST take (the user's words stay on the clip; only the model reads these). Blind
// gauntlet judges, same seeds, 2026-10-29 (feel / correctness, user's words -> this): "stands idle" 3.5/4.5 -> 6.0/6.5;
// "jogs forward and stops" 4.0/4.5 -> 6.5/7.5; "sidesteps to the right" 4.0/3.5 -> 6.5/5.0; "turns around" 6.0/5.5 ->
// 7.0/6.5. No wording helped "throws a right punch" or "kneels down on one knee" (both kept as typed).
var firstWordings = []struct{ match, use string }{
	// 2026-10-30 (from 40 blind video verdicts): "looking around" cued a crouched, searching stance and
	// restless hands, and "left to right and back" stalled halfway; mocap captions describe posture and arms
	{"stands idle, shifting their weight", "stands tall and relaxed with their arms hanging naturally at their sides, gently shifting their weight onto one leg and breathing calmly"},
	{"stands idle", "stands tall and relaxed with their arms hanging naturally at their sides, gently shifting their weight and breathing calmly"},
	{"jogs forward and stops", "jogs forward for a few strides, then slows to a walk and stops"},
	// runs: like the jog (7/10 with this shape), the stop is asked for in words instead of braking against a stop pin
	{"runs forward and stops", "runs forward for several strides, then slows down to a walk and stops"},
	// kicks: the bare words got slow chambered drills and a guard held for seconds (judged 3-5/10)
	{"kicks high with the right leg", "kicks high forward with their right leg, extending the leg out straight, then plants their right foot back down and lowers their arms to their sides"},
	{"kicks high with the left leg", "kicks high forward with their left leg, extending the leg out straight, then plants their left foot back down and lowers their arms to their sides"},
	{"sidesteps to the right", "shuffles sideways to the right with two side steps and stops"},
	{"sidesteps to the left", "shuffles sideways to the left with two side steps and stops"},
	// turns: "by taking two steps" read as crouched tactical stepping (151-degree knees, 5/10); captions say 180 degrees
	{"turns around to face the other way", "stands upright, steps and turns 180 degrees to face the opposite direction, and comes to a stop"},
	{"turns around", "stands upright, steps and turns 180 degrees to face the opposite direction, and comes to a stop"},
}

func firstWording(prompt string) string {
	l := strings.ToLower(prompt)
	for _, w := range firstWordings {
		if i := strings.Index(l, w.match); i >= 0 && !strings.Contains(l, w.use) {
			return prompt[:i] + w.use + prompt[i+len(w.match):]
		}
	}
	return prompt
}

func retryWording(prompt string) string {
	l := strings.ToLower(prompt)
	for _, w := range retryWordings {
		if i := strings.Index(l, w.match); i >= 0 && !strings.Contains(l, w.use) {
			return prompt[:i] + w.use + prompt[i+len(w.match):]
		}
	}
	return ""
}

const lateStartChange = 3.0
const plainStartDistance = 1.0

// styledMove: the words ask for more than the plain movement ("while scared", "with an injured leg", "tired",
// "slowly"): what is left after the subject, the movement verb and directions.
func styledMove(prompt string) bool {
	plainWords := map[string]bool{"a": true, "an": true, "the": true, "person": true, "man": true, "woman": true, "someone": true,
		"character": true, "figure": true, "forward": true, "forwards": true, "ahead": true, "straight": true, "back": true,
		"backward": true, "backwards": true, "around": true, "in": true, "circle": true, "place": true, "then": true, "and": true,
		"stops": true, "stop": true, "to": true, "left": true, "right": true, "sideways": true, "across": true, "room": true,
		"on": true, "spot": true, "away": true, "towards": true, "toward": true, "camera": true,
		"sidesteps": true, "sidestep": true, "steps": true, "step": true, "strafes": true,
		"their": true, "his": true, "her": true, "its": true, "few": true, "several": true, "some": true, "couple": true, "of": true,
		"two": true, "three": true, "four": true, "five": true, "meters": true, "metres": true, "floor": true, "ground": true, "street": true,
		"path": true, "hall": true, "hallway": true, "stage": true, "along": true, "down": true, "up": true, "over": true, "from": true,
		"side": true, "other": true, "way": true, "direction": true, "at": true, "normal": true, "normally": true, "pace": true, "speed": true}
	for _, w := range strings.FieldsFunc(strings.ToLower(prompt), func(r rune) bool { return !(r >= 'a' && r <= 'z') }) {
		if plainWords[w] || prerollWords.MatchString(w) {
			continue
		}
		return true
	}
	return false
}

func sq(v float32) float64 { return float64(v) * float64(v) }

// rootSpeedAt: the hips' horizontal speed (m/s) between frame f and f+1
func rootSpeedAt(pos [][][3]float32, f int) float64 {
	a, b := pos[f][0], pos[f+1][0]
	return math.Hypot(float64(b[0]-a[0]), float64(b[2]-a[2])) * 30
}
