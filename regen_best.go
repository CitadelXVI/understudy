package main

import (
	"fmt"
	"log"
	"math"
	"strings"
	"time"
)

// bestRegen: "Regenerate frames a-b" as the best of several tries (polish round 2026-10-28). MotionBricks
// in-betweening is deterministic: the same range gave the same frames every time, so a regenerate that came back
// sliding could not be retried. The variants: the range as asked, a wider window (more context to step from), a
// shorter and a longer length, and the range rebuilt as alternating steps (mb_serve "step"). Each raw result is scored
// by the checks; the best is cleaned up and kept only when it scores better than the clip as it is (do no harm).
// regenAlt: a runner-up of a best-of regenerate, kept so the person can try it ("Try another version")
type regenAlt struct {
	name       string
	from, to   int
	roots, rot []float32
	cleaned    bool
}

type regenAltSet struct {
	total int // the kept version and its runners-up
	alts  []regenAlt
	edits int // the clip's edit count when they were made: any other edit makes them stale
}

func bestRegen(roots, rotations []float32, skeleton skeletonDefinition, from, to int, before *clipMetrics, prompt string, props []stageProp) ([]float32, []float32, string, bool, error) {
	r, q, note, keep, _, err := bestRegenAlts(roots, rotations, skeleton, from, to, before, prompt, props)
	return r, q, note, keep, err
}

// bestRegenAlts: bestRegen, and the next best tries (up to three, best first) for "Try another version"
func bestRegenAlts(roots, rotations []float32, skeleton skeletonDefinition, from, to int, before *clipMetrics, prompt string, props []stageProp) ([]float32, []float32, string, bool, []regenAlt, error) {
	frames := len(roots) / 3
	clamp := func(a, b int) (int, int) {
		if a < 4 {
			a = 4
		}
		if b > frames-2 {
			b = frames - 2
		}
		return a, b
	}
	from, to = clamp(from, to)
	if to < from {
		return nil, nil, "", false, nil, fmt.Errorf("regenerate needs 4 frames before the range and 1 after it")
	}
	gap := to - from + 1
	tok := int(math.Round(float64(gap+2+6) / 4))
	if tok < 6 {
		tok = 6
	}
	if tok > 16 {
		tok = 16
	}
	type variant struct {
		name   string
		op     string
		a, b   int
		tokens int
		extra  map[string]any
	}
	wa, wb := clamp(from-6, to+6)
	vs := []variant{
		{"as asked", "regen", from, to, 0, nil},
		{"wider window", "regen", wa, wb, 0, nil},
		{"shorter", "regen", from, to, max(6, tok-2), nil},
		{"longer", "regen", from, to, min(16, tok+2), nil},
		{"in steps", "step", from, to, 0, nil},
		{"in steps, wider", "step", wa, wb, 0, map[string]any{"step_deg": 55.0, "step_m": 0.3}},
	}
	score := func(m *clipMetrics) float64 {
		if m == nil {
			return math.Inf(1)
		}
		return float64(flagSeverity(m)) + m.SlideM*100 + m.PivotDeg/5
	}
	type result struct {
		v      variant
		r, q   []float32
		m      *clipMetrics
		points float64
	}
	var tried []result
	t0 := time.Now()
	for _, v := range vs {
		if v.a > v.b || (v.name == "wider window" && v.a == from && v.b == to) || (v.name == "in steps, wider" && v.a == from && v.b == to) {
			continue
		}
		extra := map[string]any{"from": v.a, "to": v.b}
		if v.tokens > 0 {
			extra["tokens"] = v.tokens
		}
		for k, x := range v.extra {
			extra[k] = x
		}
		r, q, _, err := mbRun(v.op, roots, rotations, skeleton, extra)
		if err != nil {
			log.Printf("best regenerate: %s: %v", v.name, err)
			continue
		}
		m := withAction(computeMetrics(r, q, skeleton, props...), prompt, r, q, skeleton, props...)
		tried = append(tried, result{v, r, q, m, score(m)})
	}
	if len(tried) == 0 {
		return nil, nil, "", false, nil, fmt.Errorf("MotionBricks could not regenerate frames %d-%d", from+1, to+1)
	}
	// the best two raw results are cleaned up (Clean up changes the score: feet locked, floor fixed); the better kept
	for i := 0; i < len(tried); i++ {
		for j := i + 1; j < len(tried); j++ {
			if tried[j].points < tried[i].points {
				tried[i], tried[j] = tried[j], tried[i]
			}
		}
	}
	var best *result
	for i := 0; i < len(tried) && i < 2; i++ {
		c := tried[i]
		if cr, cq, _, err := cleanupStreams(c.r, c.q, skeleton, 0.95, props...); err == nil {
			c.r, c.q = cr, cq
			c.m = withAction(computeMetrics(cr, cq, skeleton, props...), prompt, cr, cq, skeleton, props...)
			c.points = score(c.m)
		}
		if best == nil || c.points < best.points {
			cc := c
			best = &cc
		}
	}
	names := make([]string, 0, len(tried))
	for _, t := range tried {
		names = append(names, fmt.Sprintf("%s %.0f", t.v.name, t.points))
	}
	log.Printf("best regenerate %d-%d: %d tries in %.1f s (%s); kept %q %.0f vs the clip %.0f", from+1, to+1, len(tried), time.Since(t0).Seconds(), strings.Join(names, ", "), best.v.name, best.points, score(before))
	var alts []regenAlt
	for _, t := range tried {
		if t.v.name == best.v.name || len(alts) >= 3 {
			continue
		}
		alts = append(alts, regenAlt{name: t.v.name, from: t.v.a, to: t.v.b, roots: t.r, rot: t.q})
	}
	if before != nil && best.points >= score(before) {
		return nil, nil, fmt.Sprintf("Tried %d new versions of frames %d–%d; none was better than the clip as it is, so it was left unchanged. A cleaner fix: make a new clip whose words ask for the steps.", len(tried), from+1, to+1), false, alts, nil
	}
	what := map[string]string{"as asked": "regenerated", "wider window": "regenerated with more of the clip around them", "shorter": "regenerated a little quicker", "longer": "regenerated a little slower", "in steps": "rebuilt as steps", "in steps, wider": "rebuilt as steps, with more of the clip around them"}[best.v.name]
	return best.r, best.q, fmt.Sprintf("Frames %d–%d %s: the best of %d tries.", best.v.a+1, best.v.b+1, what, len(tried)), true, alts, nil
}
