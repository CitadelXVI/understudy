// The pose library: named full-body poses saved from a clip's frame, reused
// as keyframes in other clips. Stored in <output>/poses.json.
package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type savedPose struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	SkeletonKey string       `json:"skeleton_key"`
	Root        [3]float32   `json:"root"`
	Rotations   [][4]float32 `json:"rotations"` // parent-local XYZW, joint order of the skeleton
	Heading     float64      `json:"heading"`   // hips yaw, radians, as Kimodo's first_heading
	Source      struct {
		Animation string `json:"animation,omitempty"`
		Frame     int    `json:"frame"`
	} `json:"source"`
	Project   string `json:"project,omitempty"`
	CreatedAt string `json:"created_at"`
}

type poseStore struct {
	mu    sync.RWMutex
	path  string
	items map[string]savedPose
}

func loadPoses(output string) *poseStore {
	store := &poseStore{items: map[string]savedPose{}}
	if output == "" {
		return store
	}
	store.path = filepath.Join(output, "poses.json")
	if b, err := os.ReadFile(store.path); err == nil {
		var list []savedPose
		if json.Unmarshal(b, &list) == nil {
			for _, p := range list {
				if p.ID != "" {
					store.items[p.ID] = p
				}
			}
		}
	}
	return store
}

// Called with the lock held.
func (s *poseStore) save() {
	if s.path == "" {
		return
	}
	b, _ := json.MarshalIndent(s.list(), "", "  ")
	if err := os.WriteFile(s.path, b, 0644); err != nil {
		log.Printf("poses: %v", err)
	}
}

func (s *poseStore) list() []savedPose {
	result := make([]savedPose, 0, len(s.items))
	for _, p := range s.items {
		result = append(result, p)
	}
	sort.Slice(result, func(i, j int) bool { return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name) })
	return result
}

func (g *gallery) handlePoses(w http.ResponseWriter, r *http.Request) {
	s := g.poses
	id := strings.TrimPrefix(r.URL.Path, "/api/poses")
	id = strings.TrimPrefix(id, "/")
	switch {
	case r.Method == http.MethodGet && id == "":
		s.mu.RLock()
		list := s.list()
		s.mu.RUnlock()
		writeJSON(w, 200, list)
	case r.Method == http.MethodPost && id == "":
		var p savedPose
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<18)).Decode(&p); err != nil {
			http.Error(w, "invalid JSON: "+err.Error(), 400)
			return
		}
		p.Name = strings.TrimSpace(p.Name)
		skeleton, ok := skeletonDefinitions[p.SkeletonKey]
		if p.Name == "" || len(p.Name) > 80 {
			http.Error(w, "a pose needs a name of 1..80 characters", 400)
			return
		}
		if !ok || len(p.Rotations) != len(skeleton.parents) {
			http.Error(w, "rotations must match the skeleton's joint count", 400)
			return
		}
		p.ID = token()
		p.Project = g.projects.valid(p.Project)
		p.CreatedAt = time.Now().UTC().Format(time.RFC3339)
		s.mu.Lock()
		s.items[p.ID] = p
		s.save()
		s.mu.Unlock()
		writeJSON(w, http.StatusCreated, p)
	case r.Method == http.MethodPatch && id != "":
		var body struct {
			Name    *string `json:"name"`
			Project *string `json:"project"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&body); err != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		s.mu.Lock()
		p, ok := s.items[id]
		if !ok {
			s.mu.Unlock()
			http.NotFound(w, r)
			return
		}
		if body.Name != nil {
			if n := strings.TrimSpace(*body.Name); n != "" && len(n) <= 80 {
				p.Name = n
			} else {
				s.mu.Unlock()
				http.Error(w, errors.New("a pose needs a name of 1..80 characters").Error(), 400)
				return
			}
		}
		if body.Project != nil {
			p.Project = g.projects.valid(*body.Project)
		}
		s.items[id] = p
		s.save()
		s.mu.Unlock()
		writeJSON(w, 200, p)
	case r.Method == http.MethodDelete && id != "":
		s.mu.Lock()
		_, ok := s.items[id]
		delete(s.items, id)
		s.save()
		s.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "GET or POST /api/poses, PATCH or DELETE /api/poses/<id>", http.StatusMethodNotAllowed)
	}
}
