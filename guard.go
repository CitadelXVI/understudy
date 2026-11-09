package main

// Guardrails for in-place edits. Every edit is undoable, but undo lives in memory and a person may not notice
// what an edit did until later; so (1) the first in-place edit keeps the clip's original streams on disk, and
// "revert" brings them back at any time (itself undoable), and (2) every edit is compared with what it replaced
// and the response carries warnings when it removed much of the movement or bent a joint past its range.

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
)

const (
	originalRoots     = "original_root_positions.f32"
	originalRotations = "original_local_rotations_xyzw.f32"
	motionKeptWarn    = 0.75 // an edit that keeps less than this share of the movement it touched gets a warning
)

// keepOriginal writes the clip's streams as its original, once (the first in-place edit).
func (g *gallery) keepOriginal(a *animation) {
	if g.output == "" || a.roots == nil {
		return
	}
	dir := filepath.Join(g.output, a.ID)
	if _, err := os.Stat(filepath.Join(dir, originalRotations)); err == nil {
		return
	}
	if os.MkdirAll(dir, 0755) != nil {
		return
	}
	if writeF32File(filepath.Join(dir, originalRoots), a.roots) == nil {
		_ = writeF32File(filepath.Join(dir, originalRotations), a.rotations)
	}
}

func (g *gallery) readOriginal(a *animation) ([]float32, []float32, error) {
	dir := filepath.Join(g.output, a.ID)
	roots, err := readF32(filepath.Join(dir, originalRoots))
	if err != nil {
		return nil, nil, fmt.Errorf("no original kept for this clip (it has not been edited since originals were kept)")
	}
	rotations, err := readF32(filepath.Join(dir, originalRotations))
	if err != nil {
		return nil, nil, err
	}
	return roots, rotations, nil
}

func (g *gallery) hasOriginal(a *animation) bool {
	if g.output == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(g.output, a.ID, originalRotations))
	return err == nil
}

// What an edit did to the movement, on the frames it changed (±1):
//
//	kept  - joint travel after / before, sampled every 3rd frame so a pop does not count as movement
//	spin  - the body's turning (hips rotation, frame to frame) after / before; a flip turns ~360°
//	dev   - mean and max distance a joint moved from where it was (m)
//
// A whole-clip tween of a flip keeps most of its travel but moves joints 70 cm on average: the flip is gone.
type editChange struct {
	from, to        int
	kept, spin      float64
	meanDev, maxDev float64
	turn            float64 // degrees the body turned before the edit
}

func measureEdit(beforeRot, afterRot []float32, beforePos, afterPos [][][3]float32, joints int) editChange {
	c := editChange{from: -1, to: -1, kept: 1, spin: 1}
	frames := len(beforePos)
	if len(afterPos) != frames || frames < 2 {
		return c
	}
	dist := func(a, b [3]float32) float64 {
		return math.Sqrt(float64((b[0]-a[0])*(b[0]-a[0]) + (b[1]-a[1])*(b[1]-a[1]) + (b[2]-a[2])*(b[2]-a[2])))
	}
	n := 0
	for f := 0; f < frames; f++ {
		changed := false
		for j := range beforePos[f] {
			if d := dist(beforePos[f][j], afterPos[f][j]); d > 0.005 {
				changed = true
				c.maxDev = math.Max(c.maxDev, d)
			}
		}
		if changed {
			if c.from < 0 {
				c.from = f
			}
			c.to = f
		}
	}
	if c.from < 0 {
		return c
	}
	lo, hi := max(c.from-1, 0), min(c.to+1, frames-1)
	for f := lo; f <= hi; f++ {
		for j := range beforePos[f] {
			c.meanDev += dist(beforePos[f][j], afterPos[f][j])
			n++
		}
	}
	c.meanDev /= float64(n)
	travel := func(pos [][][3]float32) float64 {
		s := 0.0
		for f := lo + 3; f <= hi; f += 3 {
			for j := range pos[f] {
				s += dist(pos[f-3][j], pos[f][j])
			}
		}
		return s
	}
	if tb := travel(beforePos); tb > 0.05 {
		c.kept = travel(afterPos) / tb
	}
	spin := func(rots []float32) float64 {
		s := 0.0
		for f := lo + 1; f <= hi; f++ {
			a, b := rots[(f-1)*joints*4:], rots[f*joints*4:]
			d := math.Abs(float64(a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]))
			s += 2 * math.Acos(math.Min(1, d)) * 180 / math.Pi
		}
		return s
	}
	c.turn = spin(beforeRot)
	if c.turn > 90 {
		c.spin = spin(afterRot) / c.turn
	}
	return c
}

var jointWords = strings.NewReplacer("Neck1", "neck", "Neck2", "neck", "Head", "head", "Spine1", "spine", "Spine2", "spine", "Chest", "chest",
	"LeftShin", "left knee", "RightShin", "right knee", "LeftForeArm", "left elbow", "RightForeArm", "right elbow",
	"LeftShoulder", "left shoulder", "RightShoulder", "right shoulder", "LeftFoot", "left ankle", "RightFoot", "right ankle",
	"LeftToeBase", "left toes", "RightToeBase", "right toes")

func jointWord(name string) string { return jointWords.Replace(name) }

// editWarnings compares an in-place edit with what it replaced.
func editWarnings(op string, beforeRoots, beforeRot, afterRoots, afterRot []float32, before, after *clipMetrics, skeleton skeletonDefinition) []string {
	var out []string
	if op == "revert" { // the original is what it is; its own checks show in the Checks row
		return nil
	}
	// a pose edit or a mirrored range is meant to change the motion; the fixes are not
	fix := op != "pose" && op != "mirror_range"
	if fix && len(beforeRoots) == len(afterRoots) {
		joints := len(skeleton.parents)
		c := measureEdit(beforeRot, afterRot, forwardKinematics(beforeRoots, beforeRot, skeleton), forwardKinematics(afterRoots, afterRot, skeleton), joints)
		frames := fmt.Sprintf("frames %d–%d", c.from+1, c.to+1)
		switch {
		case c.spin < 0.8:
			out = append(out, fmt.Sprintf("This edit took out %d %% of the body's turning in %s (a flip or spin is being flattened). If that was not the point, undo it.", int(math.Round((1-c.spin)*100)), frames))
		case c.kept < motionKeptWarn:
			out = append(out, fmt.Sprintf("This edit removed %d %% of the movement in %s. If that was not the point, undo it.", int(math.Round((1-c.kept)*100)), frames))
		case c.meanDev > 0.15:
			out = append(out, fmt.Sprintf("This edit moved the body %.0f cm on average (up to %.0f cm) in %s: it changed the motion, not just fixed it. If that was not the point, undo it.", c.meanDev*100, c.maxDev*100, frames))
		}
	}
	if after != nil && after.AnatomyFrames > 0 && (before == nil || after.AnatomyFrames > before.AnatomyFrames) {
		out = append(out, fmt.Sprintf("This edit bent the %s %.0f° past what a body can do at frame %d. Clean up pulls it back, or undo the edit.", jointWord(after.AnatomyJoint), after.AnatomyDeg, after.AnatomyFrame+1))
	}
	if after != nil && before != nil && after.SelfClip > before.SelfClip+0.05 {
		out = append(out, fmt.Sprintf("This edit made the body clip through itself on %d %% more frames. Clean up fixes it, or undo the edit.", int(math.Round((after.SelfClip-before.SelfClip)*100))))
	}
	return out
}
