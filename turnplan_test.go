package main

import (
	"math"
	"testing"
)

func TestTurnFromPrompt(t *testing.T) {
	deg := func(r float64) int { return int(math.Round(r * 180 / math.Pi)) }
	for prompt, want := range map[string]int{
		"A person turns around to face the other way.": 180,
		"A person turns to the right.":                 -90,
		"a person turns left and waves":                90,
		"A person turns 135 degrees to the right.":     -135,
		"A person faces the other way.":                180,
	} {
		got, ok := turnFromPrompt(prompt)
		if !ok || deg(got) != want {
			t.Errorf("%q: got %d %v, want %d", prompt, deg(got), ok, want)
		}
	}
	for _, prompt := range []string{"A person walks forward and turns left.", "A person spins around.", "A person waves and then, after a long pause, turns around."} {
		if _, ok := turnFromPrompt(prompt); ok {
			t.Errorf("%q should not plan a turn in place", prompt)
		}
	}
}

func TestTurnKeyPlans(t *testing.T) {
	plans := turnKeyPlans()
	if len(plans) != 8 {
		t.Fatalf("plans %d", len(plans))
	}
	for _, c := range []struct {
		turn   float64
		frames int
		want   bool
	}{{math.Pi, 90, true}, {-math.Pi / 2, 75, true}, {math.Pi, 40, false}, {math.Pi * 100 / 180, 75, true}} {
		plan, end := turnPlanFor(c.turn, c.frames)
		if (plan != nil) != c.want {
			t.Fatalf("turn %.2f in %d frames: plan %v", c.turn, c.frames, plan != nil)
		}
		if plan == nil {
			continue
		}
		if _, err := parseConstraint(plan[0], "soma30", 30, c.frames); err != nil {
			t.Fatalf("turn %.2f: %v (end %d)", c.turn, err, end)
		}
	}
}

func TestTurnContinues(t *testing.T) {
	for prompt, want := range map[string]bool{
		"A person turns around and waves.":             true,
		"A person turns around to face the other way.": false,
		"A person turns to the left, then sits down.":  true,
		"A person turns 90 degrees to the right.":      false,
	} {
		if got := turnContinues(prompt); got != want {
			t.Errorf("%q: %v", prompt, got)
		}
	}
	full, _ := turnPlanFor(math.Pi, 90)
	open, _ := turnPlanFor(math.Pi, 90, true)
	if len(open[0].FrameIndices) != len(full[0].FrameIndices)-2 {
		t.Fatalf("open plan %d frames, full %d", len(open[0].FrameIndices), len(full[0].FrameIndices))
	}
}

func TestTurnSplit(t *testing.T) {
	for prompt, want := range map[string][2]string{
		"A person turns around and waves.":              {"A person turns around.", "A person waves."},
		"A person turns to the left, then sits down.":   {"A person turns to the left.", "A person sits down."},
		"A person turns around and then walks forward.": {"A person turns around.", "A person walks forward."},
	} {
		a, b, ok := turnSplit(prompt)
		if !ok || a != want[0] || b != want[1] {
			t.Errorf("%q: %q + %q (%v)", prompt, a, b, ok)
		}
	}
	if _, _, ok := turnSplit("A person turns around to face the other way."); ok {
		t.Error("a plain turn must not split")
	}
}

func TestSidePlan(t *testing.T) {
	for prompt, want := range map[string][2]int{
		"A person sidesteps to the right.":         {-1, 0},
		"A person side-steps to the left.":         {1, 0},
		"A person takes two steps to the left.":    {1, 2},
		"A person shuffles sideways to the right.": {-1, 0},
	} {
		d, n, ok := sideFromPrompt(prompt)
		if !ok || d != want[0] || n != want[1] {
			t.Errorf("%q: %d %d %v", prompt, d, n, ok)
		}
	}
	if _, _, ok := sideFromPrompt("A person walks forward and sidesteps."); ok {
		t.Error("a walk is not a side step in place")
	}
	for frames, steps := range map[int]int{90: 3, 120: 4, 60: 1} {
		c, end := sidePlanFor(-1, 0, frames, false)
		if c == nil {
			t.Fatalf("%d frames: no plan", frames)
		}
		if want := 10 + 20*steps + 7; end != want {
			t.Errorf("%d frames: end %d, want %d", frames, end, want)
		}
		if _, err := parseConstraint(c[0], "soma30", 30, frames); err != nil {
			t.Fatal(err)
		}
	}
	a, b, ok := turnSplit("A person sidesteps to the right and waves.")
	if !ok || a != "A person sidesteps to the right." || b != "A person waves." {
		t.Errorf("split %q + %q %v", a, b, ok)
	}
}

func TestKneelPlan(t *testing.T) {
	for prompt, want := range map[string]struct {
		side string
		rise bool
	}{
		"A person kneels down on one knee and stands up again.": {"right", true},
		"A person kneels on their left knee.":                   {"left", false},
		"A person kneels down on one knee, then gets up.":       {"right", true},
	} {
		side, rise, ok := kneelFromPrompt(prompt)
		if !ok || side != want.side || rise != want.rise {
			t.Errorf("%q: %s %v %v", prompt, side, rise, ok)
		}
	}
	if _, _, ok := kneelFromPrompt("A person kneels down on both knees."); ok {
		t.Error("both knees has no plan")
	}
	for _, frames := range []int{90, 120, 150, 200} {
		c, _ := kneelPlanFor("right", true, frames)
		if c == nil {
			t.Fatalf("%d frames: no plan", frames)
		}
		if _, err := parseConstraint(c[0], "soma30", 30, frames); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSplitPlan(t *testing.T) {
	plan, _ := turnPlanFor(math.Pi, 90)
	keys := splitPlan(plan, "Turn around")
	if len(keys) != 8 || keys[0].Label != "Turn around 1/8 · Head turns, weight shifts" || keys[2].Label != "Turn around 3/8 · Left foot steps open" || len(keys[3].FrameIndices) != 1 || len(keys[7].FrameIndices) != 2 {
		t.Fatalf("%d keys, first %q", len(keys), keys[0].Label)
	}
	for _, k := range keys {
		if _, err := parseConstraint(k, "soma30", 30, 90); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWalkStart(t *testing.T) {
	for prompt, want := range map[string]bool{
		"A person walks forward.":               true,
		"A person walks forward and stops.":     true,
		"A person walks backward.":              false,
		"A person walks in a circle.":           false,
		"A person turns around and walks away.": false,
		"Walking forward slowly.":               true,
		"A person runs forward.":                false, // runs: not human-feel tested yet
		"A person jogs forward and stops.":      false,
	} {
		if got := walkStartFromPrompt(prompt); got != want {
			t.Errorf("%q: %v", prompt, got)
		}
	}
	c, _ := planConstraint("walkstart_left", 120, false)
	if c == nil {
		t.Fatal("no walk start plan")
	}
}

func TestKickPlan(t *testing.T) {
	for prompt, want := range map[string]struct {
		leg  string
		high bool
	}{
		"A person kicks high with the right leg.": {"right", true},
		"A person kicks with the left leg.":       {"left", false},
		"A person kicks to head height.":          {"right", true},
	} {
		leg, high, ok := kickFromPrompt(prompt)
		if !ok || leg != want.leg || high != want.high {
			t.Errorf("%q: %s %v %v", prompt, leg, high, ok)
		}
	}
	for _, p := range []string{"A person does a roundhouse kick.", "A person kicks a ball.", "A person does a spinning kick."} {
		if _, _, ok := kickFromPrompt(p); ok {
			t.Errorf("%q should be left to the model", p)
		}
	}
	a, b, ok := turnSplit("A person kicks high with the right leg and then punches.")
	if !ok || a != "A person kicks high with the right leg." || b != "A person punches." {
		t.Errorf("split %q + %q %v", a, b, ok)
	}
	if c, _ := planConstraint("kick_right_high", 90, false); c == nil {
		t.Fatal("no kick plan")
	}
}

func TestStaggerPlan(t *testing.T) {
	for prompt, want := range map[string]bool{
		"A person gets hit in the chest and staggers back.": true,
		"A person is shoved and stumbles backwards.":        true,
		"A person gets hit and falls down.":                 false,
		"A person staggers forward.":                        false,
	} {
		if got := staggerFromPrompt(prompt); got != want {
			t.Errorf("%q: %v", prompt, got)
		}
	}
	if c, _ := planConstraint("stagger", 90, false); c == nil {
		t.Fatal("no stagger plan")
	}
}
