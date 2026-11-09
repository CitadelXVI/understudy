package main

// POST /api/animations/blank {project, frames} — a blank clip: two seconds of the skeleton's rest pose (a T-pose on
// SOMA) standing on the floor, to pose and key from nothing. An untouched blank in the same project (no edits, no
// keys) is returned again rather than a new one, so clearing the stage does not litter the library.

import (
	"encoding/json"
	"net/http"
	"time"
)

func (g *gallery) handleBlank(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Project string `json:"project"`
		Frames  int    `json:"frames"`
		Model   string `json:"model"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body)
	if body.Frames <= 0 {
		body.Frames = 60
	}
	if body.Frames > 360 {
		body.Frames = 360
	}
	if body.Model == "" {
		body.Model = g.defaultModelID()
	}
	model, ok := g.models[body.Model]
	if !ok {
		http.Error(w, "unknown model", 400)
		return
	}
	skeleton := skeletonDefinitions[model.SkeletonKey]
	g.mu.RLock()
	for _, a := range g.items {
		if a.Kind == "blank" && !a.Trashed && a.Project == body.Project && a.Edits == 0 && a.Layer == nil && a.Frames == body.Frames && a.Model == body.Model {
			out := *a
			g.mu.RUnlock()
			writeJSON(w, http.StatusOK, &out)
			return
		}
	}
	g.mu.RUnlock()
	joints := len(skeleton.parents)
	rot := make([]float32, body.Frames*joints*4)
	for i := 0; i < body.Frames*joints; i++ {
		rot[i*4+3] = 1
	}
	// the rest pose standing on the floor: the lowest foot joint at the skeleton's nominal floor
	probe := forwardKinematics([]float32{0, 0, 0}, rot[:joints*4], skeleton)
	low := float32(0)
	for j, n := range skeleton.names {
		if isFootJoint(n) && probe[0][j][1] < low {
			low = probe[0][j][1]
		}
	}
	y := float32(clipFloor(probe, skeleton)) - low
	roots := make([]float32, body.Frames*3)
	for f := 0; f < body.Frames; f++ {
		roots[f*3+1] = y
	}
	glb, err := buildMotionGLB(roots, rot, model.SkeletonKey)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	a := animation{ID: token(), Prompt: "", Frames: body.Frames, CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Status: "ready", Kind: "blank", Model: body.Model, Name: "Blank · T-pose", Project: body.Project, Tags: []string{"blank"}}
	a.roots, a.rotations, a.glb = roots, rot, glb
	a.Metrics = computeMetrics(roots, rot, skeleton)
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
