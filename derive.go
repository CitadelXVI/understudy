// Derived clips: a mirrored or retimed copy of a finished clip, saved as a
// new record that remembers its source. Nothing is generated; the streams are
// transformed and rescored.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type clipMarker struct {
	Frame int    `json:"frame"`
	Name  string `json:"name"`
}

// Left/right partner of a joint by name, for mirroring. Joints without a
// partner (spine, head) map to themselves.
func mirrorPartners(names []string) []int {
	index := map[string]int{}
	for i, n := range names {
		index[n] = i
	}
	swap := func(n string) string {
		for _, pair := range [][2]string{{"Left", "Right"}, {"left_", "right_"}, {"left", "right"}} {
			if strings.HasPrefix(n, pair[0]) {
				return pair[1] + strings.TrimPrefix(n, pair[0])
			}
			if strings.HasPrefix(n, pair[1]) {
				return pair[0] + strings.TrimPrefix(n, pair[1])
			}
		}
		return n
	}
	partners := make([]int, len(names))
	for i, n := range names {
		if j, ok := index[swap(n)]; ok {
			partners[i] = j
		} else {
			partners[i] = i
		}
	}
	return partners
}

// Mirror across the character's own left/right: x negated on the root,
// rotations reflected (x, -y, -z, w) and swapped between partner joints.
func mirrorStreams(roots, rotations []float32, skeleton skeletonDefinition) ([]float32, []float32) {
	joints := len(skeleton.parents)
	frames := len(roots) / 3
	partners := mirrorPartners(skeleton.names)
	outRoots := make([]float32, len(roots))
	outRot := make([]float32, len(rotations))
	for f := 0; f < frames; f++ {
		outRoots[f*3], outRoots[f*3+1], outRoots[f*3+2] = -roots[f*3], roots[f*3+1], roots[f*3+2]
		for j := 0; j < joints; j++ {
			src := (f*joints + partners[j]) * 4
			dst := (f*joints + j) * 4
			outRot[dst], outRot[dst+1], outRot[dst+2], outRot[dst+3] = rotations[src], -rotations[src+1], -rotations[src+2], rotations[src+3]
		}
	}
	return outRoots, outRot
}

func slerp(a, b [4]float32, t float32) [4]float32 {
	dot := a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]
	if dot < 0 {
		b = [4]float32{-b[0], -b[1], -b[2], -b[3]}
		dot = -dot
	}
	var out [4]float32
	if dot > 0.9995 {
		for i := range out {
			out[i] = a[i] + t*(b[i]-a[i])
		}
	} else {
		theta := float32(math.Acos(float64(dot)))
		sa, sb := float32(math.Sin(float64((1-t)*theta))), float32(math.Sin(float64(t*theta)))
		st := float32(math.Sin(float64(theta)))
		for i := range out {
			out[i] = (a[i]*sa + b[i]*sb) / st
		}
	}
	l := float32(math.Sqrt(float64(out[0]*out[0] + out[1]*out[1] + out[2]*out[2] + out[3]*out[3])))
	if l > 0 {
		for i := range out {
			out[i] /= l
		}
	}
	return out
}

// Resample at `speed` times the original pace: 2 = twice as fast (half the frames).
func retimeStreams(roots, rotations []float32, joints int, speed float64) ([]float32, []float32) {
	frames := len(roots) / 3
	count := int(math.Round(float64(frames-1)/speed)) + 1
	if count < 2 {
		count = 2
	}
	outRoots := make([]float32, 0, count*3)
	outRot := make([]float32, 0, count*joints*4)
	for i := 0; i < count; i++ {
		t := float64(i) * speed
		if t > float64(frames-1) {
			t = float64(frames - 1)
		}
		f0 := int(math.Floor(t))
		f1 := f0 + 1
		if f1 > frames-1 {
			f1 = frames - 1
		}
		w := float32(t - float64(f0))
		for k := 0; k < 3; k++ {
			outRoots = append(outRoots, roots[f0*3+k]*(1-w)+roots[f1*3+k]*w)
		}
		for j := 0; j < joints; j++ {
			a := (f0*joints + j) * 4
			b := (f1*joints + j) * 4
			q := slerp([4]float32{rotations[a], rotations[a+1], rotations[a+2], rotations[a+3]}, [4]float32{rotations[b], rotations[b+1], rotations[b+2], rotations[b+3]}, w)
			outRot = append(outRot, q[0], q[1], q[2], q[3])
		}
	}
	return outRoots, outRot
}

// POST /api/animations/<id>/derive {"op": "mirror"} or {"op": "retime", "speed": 1.5}
func (g *gallery) handleDerive(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Op        string      `json:"op"`
		Speed     float64     `json:"speed"`
		Frame     int         `json:"frame"`     // pose: the edited frame
		Root      []float32   `json:"root"`      // pose: hips position at that frame
		Rotations [][]float32 `json:"rotations"` // pose: parent-local XYZW per joint at that frame
		Falloff   int         `json:"falloff"`   // pose: frames either side that blend toward the edit
		InPlace   bool        `json:"in_place"`  // pose: rewrite this clip (undoable) instead of a copy
		Layer     *keyLayer   `json:"layer"`     // layer: the clip's timeline keys (all of them), always in place
		Keys      []poseKey   `json:"keys"`      // pose: several keyed frames at once (a hold over a range)
		From      int         `json:"from"`      // tween / mirror_range: first frame of the range
		To        int         `json:"to"`        // tween / mirror_range: last frame of the range
		Amount    float64     `json:"amount"`    // tween: 0..1 pull toward the smooth curve through the range's ends
		Strength  float64     `json:"strength"`  // cleanup: 0..1 how tightly the physics body follows the clip (default 0.95)
		Tokens    int         `json:"tokens"`    // mb_*: force the generated length (valid frames = 4*tokens - 6), 0 = fit the gap / the model's choice
		NoClean   bool        `json:"no_clean"`  // mb_*: skip the Clean up that follows the generation
		Single    bool        `json:"single"`    // mb_regen: one generation, not the best of several
		KeepSnap  bool        `json:"keep_snap"` // cleanup: the tracked-motion profile (keep the clip's speed and snap)
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<18)).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	g.mu.RLock()
	src := g.items[id]
	var copySrc animation
	if src != nil {
		copySrc = *src
	}
	g.mu.RUnlock()
	if src == nil || copySrc.Status != "ready" {
		http.Error(w, "no such ready clip", http.StatusNotFound)
		return
	}
	if body.Op == "undo_pose" || body.Op == "redo_pose" {
		g.mu.Lock()
		from, to := &src.undo, &src.redo
		if body.Op == "redo_pose" {
			from, to = &src.redo, &src.undo
		}
		if len(*from) == 0 {
			g.mu.Unlock()
			http.Error(w, "nothing to "+strings.TrimSuffix(body.Op, "_pose"), 400)
			return
		}
		step := (*from)[len(*from)-1]
		*from = (*from)[:len(*from)-1]
		curBaseR, curBaseRot, _ := g.layerBase(src)
		*to = append(*to, &previousStreams{roots: src.roots, rotations: src.rotations, glb: src.glb, metrics: src.Metrics, segments: src.Segments, label: step.label, layer: src.Layer, layerRoots: curBaseR, layerRot: curBaseRot})
		src.roots, src.rotations, src.glb, src.Metrics = step.roots, step.rotations, step.glb, step.metrics
		src.Layer = step.layer
		if step.layer != nil {
			g.setLayerBase(src, step.layerRoots, step.layerRot)
		} else {
			g.setLayerBase(src, nil, nil)
		}
		src.Frames = len(step.roots) / 3
		if step.segments != nil {
			src.Segments = step.segments
		}
		src.Edits, src.Redos = len(src.undo), len(src.redo)
		src.Warnings = nil
		err := g.save(src)
		out := *src
		g.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, http.StatusOK, &out)
		return
	}
	model, ok := g.models[copySrc.Model]
	if !ok {
		http.Error(w, "the clip's model is unknown", 400)
		return
	}
	skeleton := skeletonDefinitions[model.SkeletonKey]
	joints := len(skeleton.parents)
	var roots, rotations []float32
	var suffix string
	var editNote string
	var pendingAlts []regenAlt             // runners-up of a best-of regenerate, kept on the clip after the edit
	var layerBaseR, layerBaseRot []float32 // layer: the motion under the keys
	trimFrom := -1
	switch body.Op {
	case "mirror":
		roots, rotations = mirrorStreams(copySrc.roots, copySrc.rotations, skeleton)
		suffix = " (mirrored)"
	case "retime":
		if math.IsNaN(body.Speed) || body.Speed < 0.25 || body.Speed > 4 {
			http.Error(w, errors.New("speed must be 0.25..4").Error(), 400)
			return
		}
		roots, rotations = retimeStreams(copySrc.roots, copySrc.rotations, joints, body.Speed)
		suffix = " (×" + strconv.FormatFloat(body.Speed, 'f', -1, 64) + ")"
	case "tween":
		if body.From < 0 || body.To >= copySrc.Frames || body.To-body.From < 2 || body.Amount <= 0 || body.Amount > 1 {
			http.Error(w, "tween needs from < to inside the clip and amount 0..1", 400)
			return
		}
		roots, rotations = tweenStreams(copySrc.roots, copySrc.rotations, joints, body.From, body.To, float32(body.Amount))
		suffix = " (tweened)"
	case "trim": // a copy cut to frames [from, to] (a game clip is the move, not the run-up and the hold around it)
		if body.From < 0 || body.To >= copySrc.Frames || body.To-body.From+1 < 2 {
			http.Error(w, "trim needs from <= to inside the clip", 400)
			return
		}
		roots, rotations = trimStreams(copySrc.roots, copySrc.rotations, joints, body.From, body.To)
		trimFrom = body.From
		suffix = fmt.Sprintf(" (frames %d-%d)", body.From+1, body.To+1)
	case "trim_idle":
		from, to, ok := settleWindow(copySrc.roots, copySrc.rotations, skeleton, true, copySrc.Frames)
		if !ok {
			http.Error(w, "no idle to trim (the clip moves almost to its ends, or barely moves at all)", 400)
			return
		}
		roots, rotations = trimStreams(copySrc.roots, copySrc.rotations, joints, from, to)
		trimFrom = from
		suffix = " (trimmed)"
	case "revert":
		var err error
		roots, rotations, err = g.readOriginal(src)
		if err == nil && len(roots) != len(copySrc.roots) {
			err = errors.New("the kept original has a different length")
		}
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		suffix = " (original)"
	case "arc":
		var res arcResult
		roots, res = arcStreams(copySrc.roots, copySrc.rotations, skeleton)
		if res.stretches == 0 {
			http.Error(w, "Could not put this jump on a gravity arc without a jolt in the hips. The landing slows down in mid-air; keep the take-off and landing and regenerate the flight instead.", 400)
			return
		}
		rotations = append([]float32(nil), copySrc.rotations...)
		suffix = " (arc)"
	case "mirror_range":
		if body.From < 0 || body.To >= copySrc.Frames || body.To < body.From {
			http.Error(w, "mirror_range needs from <= to inside the clip", 400)
			return
		}
		mr, mrot := mirrorStreams(copySrc.roots, copySrc.rotations, skeleton)
		roots = append([]float32(nil), copySrc.roots...)
		rotations = append([]float32(nil), copySrc.rotations...)
		for f := body.From; f <= body.To; f++ {
			copy(roots[f*3:f*3+3], mr[f*3:f*3+3])
			copy(rotations[f*joints*4:(f+1)*joints*4], mrot[f*joints*4:(f+1)*joints*4])
		}
		suffix = " (mirrored range)"
	case "layer":
		if body.Layer == nil {
			http.Error(w, "layer needs {keys, blend}", 400)
			return
		}
		g.mu.Lock()
		baseR, baseRot, ok := g.layerBase(src)
		hadLayer := src.Layer != nil
		g.mu.Unlock()
		if !hadLayer || !ok { // the first keys (or the base was lost): the clip as it is now is the base
			baseR, baseRot = copySrc.roots, copySrc.rotations
		}
		if err := prepareLayer(body.Layer, baseR, baseRot, joints, copySrc.Frames); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		roots, rotations = applyLayer(baseR, baseRot, skeleton, body.Layer)
		layerBaseR, layerBaseRot = baseR, baseRot
		body.InPlace = true
		suffix = " (keyed)"
	case "wrists":
		roots = append([]float32(nil), copySrc.roots...)
		rotations = wristCleanStreams(copySrc.rotations, skeleton)
		suffix = " (wrists)"
	case "pose":
		if body.Falloff < 0 || body.Falloff > 120 {
			http.Error(w, "falloff must be 0..120 frames", 400)
			return
		}
		keys := body.Keys
		if len(keys) == 0 {
			keys = []poseKey{{Frame: body.Frame, Root: body.Root, Rotations: body.Rotations}}
		}
		if len(keys) > 400 {
			http.Error(w, "at most 400 keyed frames", 400)
			return
		}
		for _, k := range keys {
			if k.Frame < 0 || k.Frame >= copySrc.Frames || len(k.Root) != 3 || len(k.Rotations) != joints {
				http.Error(w, "each key needs frame, root[3] and one rotation per joint", 400)
				return
			}
		}
		var err error
		roots, rotations, err = poseEditStreamsMulti(copySrc.roots, copySrc.rotations, joints, keys, body.Falloff)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		suffix = " (edited)"
	case "hands":
		roots, rotations, _ = cleanHandsStreams(copySrc.roots, copySrc.rotations, skeleton)
		suffix = " (hands)"
	case "ground":
		roots, rotations, _ = groundHandsStreams(copySrc.roots, copySrc.rotations, skeleton)
		suffix = " (ground)"
	case "smooth":
		// smooth the shakes, then the clean-ups a smoothed arm or leg could undo: hands out of the face, feet on the floor
		roots, rotations, _ = smoothJitterStreams(copySrc.roots, copySrc.rotations, skeleton)
		roots, rotations, _ = cleanHandsStreams(roots, rotations, skeleton)
		roots, _ = groundRootStreams(roots, rotations, skeleton)
		suffix = " (smoothed)"
	case "cleanup":
		strength := body.Strength
		if strength <= 0 || strength > 1 {
			strength = 0.95
		}
		var err error
		t0 := time.Now()
		roots, rotations, _, err = cleanupStreamsOpts(copySrc.roots, copySrc.rotations, skeleton, strength, body.KeepSnap, copySrc.Props...)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if m2 := withActionClip(computeMetrics(roots, rotations, skeleton, copySrc.Props...), &copySrc, roots, rotations, skeleton); copySrc.Metrics != nil {
			log.Printf("%s: clean-up (button) %.1f s %v -> %v", copySrc.ID, time.Since(t0).Seconds(), copySrc.Metrics.Flags, m2.Flags)
		}
		suffix = " (cleaned)"
	case "plant_feet":
		// the Checks fix for a slide that keeps the motion: planted feet held where they land, then stepped (plant.py)
		var err error
		t0 := time.Now()
		roots, rotations, _, err = cleanupStreamsWith(copySrc.roots, copySrc.rotations, skeleton, 0.95, cleanupOptions{plantOnly: true}, copySrc.Props...)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		log.Printf("%s: plant the feet %.1f s", copySrc.ID, time.Since(t0).Seconds())
		suffix = " (feet planted)"
	case "mb_regen_next":
		// the next runner-up of the last best-of regenerate on this clip ("Try another version"), cleaned up and applied
		g.mu.Lock()
		set := g.regenAlts[copySrc.ID]
		var alt regenAlt
		ok := set != nil && len(set.alts) > 0 && set.edits == copySrc.Edits
		if ok {
			alt, set.alts = set.alts[0], set.alts[1:]
		}
		g.mu.Unlock()
		if !ok {
			http.Error(w, "There is no other version of that stretch: regenerate it again for new ones.", http.StatusConflict)
			return
		}
		roots, rotations = alt.roots, alt.rot
		if cr, cq, _, cerr := cleanupStreams(roots, rotations, skeleton, 0.95, copySrc.Props...); cerr == nil {
			roots, rotations = cr, cq
		}
		left := 0
		if set != nil {
			left = len(set.alts)
		}
		total := 1 + left + 1 // the kept best, this one, and those still waiting
		if set != nil {
			total = set.total
		}
		editNote = fmt.Sprintf("Version %d of %d of frames %d–%d (%s).", total-left, total, alt.from+1, alt.to+1, map[string]string{"as asked": "regenerated as asked", "wider window": "with more of the clip around it", "shorter": "a little quicker", "longer": "a little slower", "in steps": "rebuilt as steps", "in steps, wider": "rebuilt as steps, wider"}[alt.name])
		if left > 0 {
			editNote += fmt.Sprintf(" %d more to try.", left)
		}
		pendingAlts = nil
		suffix = " (regenerated)"
	case "mb_regen", "mb_settle", "mb_loop":
		// MotionBricks: regenerate a range from the frames around it, settle into a standing pose, or loop
		t0 := time.Now()
		op := strings.TrimPrefix(body.Op, "mb_")
		var rep mbReport
		var err error
		if op == "regen" && body.Tokens == 0 && !body.Single {
			// best of several: in-betweening is deterministic, so "Regenerate" again gave the same frames; variants
			// (bestRegen) are scored by the checks and the best kept, or none when none beats the clip as it is
			var note string
			var keep bool
			var alts []regenAlt
			roots, rotations, note, keep, alts, err = bestRegenAlts(copySrc.roots, copySrc.rotations, skeleton, body.From, body.To, copySrc.Metrics, promptText(&copySrc), copySrc.Props)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			if !keep {
				http.Error(w, note, http.StatusUnprocessableEntity)
				return
			}
			editNote = note
			body.NoClean = true // bestRegen cleaned the winner
			pendingAlts = alts
		} else {
			roots, rotations, rep, err = mbStreams(op, copySrc.roots, copySrc.rotations, skeleton, body.From, body.To, body.Tokens)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
		}
		cleaned := false
		if !body.NoClean { // the generated frames sit a few cm in our floor (its floor is the sole): Clean up puts them right
			if cr, cq, _, cerr := cleanupStreams(roots, rotations, skeleton, 0.95, copySrc.Props...); cerr == nil {
				roots, rotations, cleaned = cr, cq, true
			} else {
				log.Printf("%s: %s: clean-up after MotionBricks failed: %v", copySrc.ID, body.Op, cerr)
			}
		}
		log.Printf("%s: %s %.1f s frames %d -> %d (tokens %v, cleaned %v)", copySrc.ID, body.Op, time.Since(t0).Seconds(), len(copySrc.roots)/3, len(roots)/3, rep["tokens"], cleaned)
		suffix = map[string]string{"regen": " (regenerated)", "settle": " (settled)", "loop": " (looped)"}[op]
	case "floor":
		rotations = copySrc.rotations
		roots, _ = groundRootStreams(copySrc.roots, copySrc.rotations, skeleton)
		suffix = " (grounded)"
	default:
		http.Error(w, "op must be layer, mirror, retime, pose, wrists, hands, ground, floor, smooth, cleanup, arc, trim_idle, tween, mirror_range, revert, undo_pose or redo_pose", 400)
		return
	}
	glb, err := buildMotionGLB(roots, rotations, model.SkeletonKey)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if (body.Op == "layer" || body.Op == "pose" || body.Op == "wrists" || body.Op == "hands" || body.Op == "ground" || body.Op == "floor" || body.Op == "smooth" || body.Op == "tween" || body.Op == "mirror_range" || body.Op == "cleanup" || body.Op == "plant_feet" || body.Op == "arc" || body.Op == "revert" || strings.HasPrefix(body.Op, "mb_")) && body.InPlace {
		g.mu.Lock()
		g.keepOriginal(src)
		src.HasOriginal = g.hasOriginal(src)
		beforeRoots, beforeRot, beforeMetrics := src.roots, src.rotations, src.Metrics
		bakedKeys := 0
		curBaseR, curBaseRot, _ := g.layerBase(src)
		src.undo = append(src.undo, &previousStreams{roots: src.roots, rotations: src.rotations, glb: src.glb, metrics: src.Metrics, segments: src.Segments, label: body.Op, layer: src.Layer, layerRoots: curBaseR, layerRot: curBaseRot})
		// the timeline keys: set by a layer edit; any other edit bakes them into the motion
		if body.Op == "layer" && len(body.Layer.Keys) > 0 {
			src.Layer = body.Layer
			g.setLayerBase(src, layerBaseR, layerBaseRot)
		} else if src.Layer != nil || src.layerRoots != nil {
			if src.Layer != nil && body.Op != "layer" {
				bakedKeys = len(src.Layer.Keys)
			}
			src.Layer = nil
			g.setLayerBase(src, nil, nil)
		}
		if len(src.undo) > 20 {
			src.undo = src.undo[1:]
		}
		src.redo = nil
		src.roots, src.rotations, src.glb = roots, rotations, glb
		src.Metrics = withActionClip(computeMetrics(roots, rotations, skeleton, src.Props...), src, roots, rotations, skeleton)
		if n := len(roots) / 3; n != src.Frames { // an edit that changed the length (a regenerated range, a settle, a loop)
			src.Segments = trimSegments(src.Segments, 0, n)
			src.Frames = n
		}
		src.Edits, src.Redos = len(src.undo), 0
		src.Warnings = editWarnings(body.Op, beforeRoots, beforeRot, roots, rotations, beforeMetrics, src.Metrics, skeleton)
		src.EditNote = editNote
		// the runners-up of a best-of regenerate stay with the clip until any other edit (they would be stale)
		if g.regenAlts == nil {
			g.regenAlts = map[string]*regenAltSet{}
		}
		if len(pendingAlts) > 0 {
			g.regenAlts[src.ID] = &regenAltSet{alts: pendingAlts, edits: len(src.undo), total: len(pendingAlts) + 1}
		} else if body.Op == "mb_regen_next" {
			if set := g.regenAlts[src.ID]; set != nil {
				set.edits = len(src.undo)
			}
		} else {
			delete(g.regenAlts, src.ID)
		}
		src.RegenAlts = 0
		if set := g.regenAlts[src.ID]; set != nil {
			src.RegenAlts = len(set.alts)
		}
		if bakedKeys > 0 {
			src.Warnings = append([]string{fmt.Sprintf("your %d timeline key%s are now part of the motion and can't be moved; Undo brings them back as keys", bakedKeys, map[bool]string{true: "", false: "s"}[bakedKeys == 1])}, src.Warnings...)
		}
		err = g.save(src)
		out := *src
		g.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, http.StatusOK, &out)
		return
	}
	a := copySrc
	a.ID = token()
	a.Kind = "derived"
	a.Source = copySrc.ID
	a.Derivation = body.Op
	a.Frames = len(roots) / 3
	a.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	a.Name = strings.TrimSpace(firstNonEmpty(copySrc.Name, truncate(copySrc.Prompt, 48))) + suffix
	a.Batch, a.Take, a.Takes = "", 0, 0
	a.Favorite, a.Archived = false, false
	a.Trashed, a.TrashedAt = false, "" // a copy of a trashed clip is a live clip
	a.Edits, a.Redos, a.undo, a.redo = 0, 0, nil, nil
	a.Warnings, a.HasOriginal = nil, false
	a.Lineage, a.Actor, a.ActorPrompt, a.HandTrack = nil, 0, "", nil
	a.Layer, a.layerRoots, a.layerRot = nil, nil, nil // a copy has the keys baked in
	a.roots, a.rotations, a.glb = roots, rotations, glb
	a.Metrics = withActionClip(computeMetrics(roots, rotations, skeleton, a.Props...), &a, roots, rotations, skeleton)
	if trimFrom >= 0 { // trim_idle: the timeline, markers and keeps follow the cut
		a.Segments = trimSegments(copySrc.Segments, trimFrom, a.Frames)
		kept := make([]clipMarker, 0, len(copySrc.Markers))
		for _, m := range copySrc.Markers {
			if m.Frame-trimFrom >= 0 && m.Frame-trimFrom < a.Frames {
				kept = append(kept, clipMarker{Frame: m.Frame - trimFrom, Name: m.Name})
			}
		}
		a.Markers = kept
	}
	if body.Op == "retime" {
		scaled := make([]clipMarker, 0, len(copySrc.Markers))
		for _, m := range copySrc.Markers {
			scaled = append(scaled, clipMarker{Frame: int(math.Round(float64(m.Frame) / body.Speed)), Name: m.Name})
		}
		a.Markers = scaled
	}
	g.mu.Lock()
	g.items[a.ID] = &a
	err = g.save(&a)
	out := a
	g.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, http.StatusCreated, &out)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// One level of undo for in-place pose edits, in memory only.
type previousStreams struct {
	roots, rotations []float32
	glb              []byte
	metrics          *clipMetrics
	segments         []promptSegment // the timeline as it was (an edit may change the length)
	label            string          // "pose", "wrists", "cleanup", "mb_regen"…
	layer            *keyLayer       // the timeline keys as they were, and the motion under them
	layerRoots       []float32
	layerRot         []float32
}

func qmul(a, b [4]float32) [4]float32 {
	return [4]float32{
		a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
		a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
		a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
		a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
	}
}

// A pose edit at one frame, blended into the neighbours: each joint's change
// (edit × original⁻¹, parent-local) is applied to the surrounding frames with a
// smoothstep weight that reaches 1 on the edited frame and 0 past the falloff,
// so hands, feet and hips move where they were put and the motion around it
// eases into the change instead of popping.
func poseEditStreams(roots, rotations []float32, joints, frame int, root []float32, pose [][]float32, falloff int) ([]float32, []float32, error) {
	frames := len(roots) / 3
	outRoots := append([]float32(nil), roots...)
	outRot := append([]float32(nil), rotations...)
	delta := make([][4]float32, joints)
	for j := 0; j < joints; j++ {
		if len(pose[j]) != 4 {
			return nil, nil, errors.New("each rotation is an XYZW quaternion")
		}
		at := (frame*joints + j) * 4
		orig := [4]float32{rotations[at], rotations[at+1], rotations[at+2], rotations[at+3]}
		edit := [4]float32{pose[j][0], pose[j][1], pose[j][2], pose[j][3]}
		n := float32(math.Sqrt(float64(edit[0]*edit[0] + edit[1]*edit[1] + edit[2]*edit[2] + edit[3]*edit[3])))
		if n < 1e-6 {
			return nil, nil, errors.New("a rotation is zero")
		}
		for k := range edit {
			edit[k] /= n
		}
		inv := [4]float32{-orig[0], -orig[1], -orig[2], orig[3]}
		delta[j] = qmul(edit, inv)
	}
	rootDelta := [3]float32{root[0] - roots[frame*3], root[1] - roots[frame*3+1], root[2] - roots[frame*3+2]}
	for t := 0; t < frames; t++ {
		d := t - frame
		if d < 0 {
			d = -d
		}
		if d > falloff {
			continue
		}
		u := 1 - float32(d)/float32(falloff+1)
		wgt := u * u * (3 - 2*u)
		if d == 0 {
			wgt = 1
		}
		for k := 0; k < 3; k++ {
			outRoots[t*3+k] += wgt * rootDelta[k]
		}
		for j := 0; j < joints; j++ {
			at := (t*joints + j) * 4
			orig := [4]float32{rotations[at], rotations[at+1], rotations[at+2], rotations[at+3]}
			moved := qmul(delta[j], orig)
			q := slerp(orig, moved, wgt)
			outRot[at], outRot[at+1], outRot[at+2], outRot[at+3] = q[0], q[1], q[2], q[3]
		}
	}
	return outRoots, outRot, nil
}

type poseKey struct {
	Frame     int         `json:"frame"`
	Root      []float32   `json:"root"`
	Rotations [][]float32 `json:"rotations"`
}

// Several keyed frames at once: each frame of the clip takes the change of the
// nearest key (its delta from the original there), weighted by that key's
// falloff. Keyed frames themselves land exactly on their key.
func poseEditStreamsMulti(roots, rotations []float32, joints int, keys []poseKey, falloff int) ([]float32, []float32, error) {
	frames := len(roots) / 3
	outRoots := append([]float32(nil), roots...)
	outRot := append([]float32(nil), rotations...)
	type keyDelta struct {
		frame int
		rot   [][4]float32
		root  [3]float32
	}
	deltas := make([]keyDelta, 0, len(keys))
	for _, k := range keys {
		d := keyDelta{frame: k.Frame, rot: make([][4]float32, joints)}
		for j := 0; j < joints; j++ {
			if len(k.Rotations[j]) != 4 {
				return nil, nil, errors.New("each rotation is an XYZW quaternion")
			}
			at := (k.Frame*joints + j) * 4
			orig := [4]float32{rotations[at], rotations[at+1], rotations[at+2], rotations[at+3]}
			edit := qnorm([4]float32{k.Rotations[j][0], k.Rotations[j][1], k.Rotations[j][2], k.Rotations[j][3]})
			d.rot[j] = qmul(edit, [4]float32{-orig[0], -orig[1], -orig[2], orig[3]})
		}
		d.root = [3]float32{k.Root[0] - roots[k.Frame*3], k.Root[1] - roots[k.Frame*3+1], k.Root[2] - roots[k.Frame*3+2]}
		deltas = append(deltas, d)
	}
	for t := 0; t < frames; t++ {
		// nearest key
		best, bd := -1, 1<<30
		for i, d := range deltas {
			dist := t - d.frame
			if dist < 0 {
				dist = -dist
			}
			if dist < bd {
				best, bd = i, dist
			}
		}
		if best < 0 || bd > falloff {
			continue
		}
		u := 1 - float32(bd)/float32(falloff+1)
		wgt := u * u * (3 - 2*u)
		if bd == 0 {
			wgt = 1
		}
		d := deltas[best]
		for k := 0; k < 3; k++ {
			outRoots[t*3+k] += wgt * d.root[k]
		}
		for j := 0; j < joints; j++ {
			at := (t*joints + j) * 4
			orig := [4]float32{rotations[at], rotations[at+1], rotations[at+2], rotations[at+3]}
			q := slerp(orig, qmul(d.rot[j], orig), wgt)
			outRot[at], outRot[at+1], outRot[at+2], outRot[at+3] = q[0], q[1], q[2], q[3]
		}
	}
	return outRoots, outRot, nil
}

// Tween (Cascadeur's tween machine, the useful half): pull every frame of a
// range toward the smooth path between the range's two end frames — a cubic
// ease between the end poses — by `amount`. 1.0 replaces the range with a
// clean in-between; 0.3 settles a pop while keeping most of the motion.
func tweenStreams(roots, rotations []float32, joints, from, to int, amount float32) ([]float32, []float32) {
	outRoots := append([]float32(nil), roots...)
	outRot := append([]float32(nil), rotations...)
	span := float32(to - from)
	for f := from + 1; f < to; f++ {
		u := float32(f-from) / span
		t := u * u * (3 - 2*u)
		for k := 0; k < 3; k++ {
			smooth := roots[from*3+k] + t*(roots[to*3+k]-roots[from*3+k])
			outRoots[f*3+k] = roots[f*3+k] + amount*(smooth-roots[f*3+k])
		}
		for j := 0; j < joints; j++ {
			a := [4]float32{rotations[(from*joints+j)*4], rotations[(from*joints+j)*4+1], rotations[(from*joints+j)*4+2], rotations[(from*joints+j)*4+3]}
			b := [4]float32{rotations[(to*joints+j)*4], rotations[(to*joints+j)*4+1], rotations[(to*joints+j)*4+2], rotations[(to*joints+j)*4+3]}
			at := (f*joints + j) * 4
			cur := [4]float32{rotations[at], rotations[at+1], rotations[at+2], rotations[at+3]}
			smooth := slerp(a, b, t)
			q := slerp(cur, smooth, amount)
			outRot[at], outRot[at+1], outRot[at+2], outRot[at+3] = q[0], q[1], q[2], q[3]
		}
	}
	return outRoots, outRot
}
