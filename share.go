// Share packs: one clip as one .understudy file (plain JSON) that anyone can open in the Browse page and add to their
// own library. The pack carries the motion, its name, prompt, tags, author, stage boxes, the model it came from, the
// licence note, and the skeleton (so the Browse page draws it without the app).
//
// Licences (kimodo.cpp README): the SOMA and G1 checkpoints are under the NVIDIA Open Model License, which permits
// commercial use; the SMPL-X Kimodo checkpoint is NVIDIA's internal research licence (no production use, no
// redistribution of derivatives), so its clips are never packed for sharing.
package main

import (
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"time"
)

type sharePack struct {
	Format    string          `json:"understudy_pack"` // "1"
	Name      string          `json:"name"`
	Prompt    string          `json:"prompt,omitempty"`
	Tags      []string        `json:"tags,omitempty"`
	Author    string          `json:"author,omitempty"`
	Model     string          `json:"model"`
	License   string          `json:"license"`
	FPS       int             `json:"fps"`
	Frames    int             `json:"frames"`
	Props     []stageProp     `json:"props,omitempty"`
	Created   string          `json:"created_at"`
	Skeleton  json.RawMessage `json:"skeleton"`
	Root      [][3]float64    `json:"root"`
	Rotations [][][4]float64  `json:"rotations"`
}

// shareable reports whether clips from this model may be shared, and the licence line that goes with them.
func shareable(model string) (bool, string) {
	m := strings.ToLower(model)
	switch {
	case strings.HasPrefix(m, "soma"), strings.HasPrefix(m, "g1"):
		return true, "Made with Understudy from NVIDIA Kimodo (" + model + "), NVIDIA Open Model License: commercial use permitted by the model licence."
	default:
		return false, "Clips from " + model + " can't be shared: that model's licence is research-only (no production use, no redistribution of derivatives)."
	}
}

func round5(v float32) float64 { return math.Round(float64(v)*1e5) / 1e5 }

func (g *gallery) handlePack(w http.ResponseWriter, r *http.Request, id string) {
	g.mu.RLock()
	a := g.items[id]
	if a == nil || a.Status != "ready" {
		g.mu.RUnlock()
		http.NotFound(w, r)
		return
	}
	ok, license := shareable(a.Model)
	if !ok {
		g.mu.RUnlock()
		http.Error(w, license, http.StatusForbidden)
		return
	}
	model, known := g.models[a.Model]
	if !known {
		g.mu.RUnlock()
		http.Error(w, "unknown model", 400)
		return
	}
	sk := skeletonDefinitions[model.SkeletonKey]
	joints := len(sk.parents)
	frames := len(a.roots) / 3
	p := sharePack{Format: "1", Name: a.Name, Prompt: a.Prompt, Tags: append([]string(nil), a.Tags...), Model: a.Model, License: license,
		FPS: 30, Frames: frames, Props: append([]stageProp(nil), a.Props...), Created: time.Now().UTC().Format(time.RFC3339),
		Author: strings.TrimSpace(r.URL.Query().Get("author"))}
	p.Root = make([][3]float64, frames)
	p.Rotations = make([][][4]float64, frames)
	for f := 0; f < frames; f++ {
		p.Root[f] = [3]float64{round5(a.roots[f*3]), round5(a.roots[f*3+1]), round5(a.roots[f*3+2])}
		row := make([][4]float64, joints)
		for j := 0; j < joints; j++ {
			o := (f*joints + j) * 4
			row[j] = [4]float64{round5(a.rotations[o]), round5(a.rotations[o+1]), round5(a.rotations[o+2]), round5(a.rotations[o+3])}
		}
		p.Rotations[f] = row
	}
	stem := a.fileStem()
	g.mu.RUnlock()
	skel, _ := json.Marshal(map[string]any{"key": sk.key, "joint_names": sk.names, "parents": sk.parents, "offsets": sk.offsets})
	p.Skeleton = skel
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", "attachment; filename="+stem+".understudy")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(p)
}
