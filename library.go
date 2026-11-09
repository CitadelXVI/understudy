// Library organisation: projects (one per game), and per-clip name, project,
// favourite and archived flags. Clips keep their files where they are; archiving
// is a flag, so nothing moves on disk. Only a permanent delete removes files.
package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type project struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
	// Sub-buckets, as paths: "Locomotion", "Locomotion/Male". A folder exists
	// once created here even while no clip is in it.
	Folders []string `json:"folders"`
	// Where "Send to Unreal" puts this project's clips.
	Pipeline *pipelineConfig `json:"pipeline,omitempty"`
	// Coverage board: the animations this project needs, as tags.
	Slots []string `json:"slots"`
	// Saved prompts that worked, with the settings they ran with.
	Prompts []savedPrompt `json:"prompts"`
	// The project's scene: actors (clip, placement, frame offset), kept as the page wrote it.
	Scene json.RawMessage `json:"scene,omitempty"`
}

type savedPrompt struct {
	Name     string          `json:"name"`
	Prompt   string          `json:"prompt"`
	Settings json.RawMessage `json:"settings,omitempty"`
}

// A folder path cleaned for storage: segments trimmed, empty ones dropped,
// "/" between them. "" means no folder.
func cleanFolder(path string) (string, error) {
	var parts []string
	for _, seg := range strings.Split(strings.ReplaceAll(path, "\\", "/"), "/") {
		seg = strings.TrimSpace(seg)
		if seg == "" {
			continue
		}
		if len(seg) > 60 {
			return "", errors.New("a folder name is at most 60 characters")
		}
		parts = append(parts, seg)
	}
	if len(parts) > 6 {
		return "", errors.New("folders nest at most 6 deep")
	}
	return strings.Join(parts, "/"), nil
}

func inFolder(folder, path string) bool {
	return folder == path || strings.HasPrefix(folder, path+"/")
}

// projects.json beside the clips. Without -output it lives in memory only.
type projectStore struct {
	mu    sync.RWMutex
	path  string
	items map[string]project
}

// The projects a fresh library starts with.
var defaultProjects = []string{"My Game"}

var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(name string) string {
	s := strings.Trim(slugPattern.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if s == "" {
		s = "project"
	}
	return s
}

func loadProjects(output string) *projectStore {
	store := &projectStore{items: map[string]project{}}
	if output != "" {
		store.path = filepath.Join(output, "projects.json")
		if b, err := os.ReadFile(store.path); err == nil {
			var list []project
			if json.Unmarshal(b, &list) == nil {
				for _, p := range list {
					if p.ID != "" {
						store.items[p.ID] = p
					}
				}
				return store
			}
		}
	}
	for _, name := range defaultProjects {
		store.items[slugify(name)] = project{ID: slugify(name), Name: name, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	}
	store.save()
	return store
}

// Called with the lock held.
func (s *projectStore) save() {
	if s.path == "" {
		return
	}
	b, _ := json.MarshalIndent(s.list(), "", "  ")
	if err := os.WriteFile(s.path, b, 0644); err != nil {
		log.Printf("projects: %v", err)
	}
}

func (s *projectStore) list() []project {
	result := make([]project, 0, len(s.items))
	for _, p := range s.items {
		if p.Folders == nil {
			p.Folders = []string{}
		}
		if p.Slots == nil {
			p.Slots = []string{}
		}
		if p.Prompts == nil {
			p.Prompts = []savedPrompt{}
		}
		result = append(result, p)
	}
	sort.Slice(result, func(i, j int) bool { return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name) })
	return result
}

// A project id that exists, or "" (the Inbox) for anything else.
func (s *projectStore) valid(id string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.items[id]; ok {
		return id
	}
	return ""
}

func (s *projectStore) create(name string) (project, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 80 {
		return project{}, errors.New("a project needs a name of 1..80 characters")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := slugify(name)
	for i := 2; ; i++ {
		if _, taken := s.items[id]; !taken {
			break
		}
		id = slugify(name) + "-" + strconv.Itoa(i)
	}
	p := project{ID: id, Name: name, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	s.items[id] = p
	s.save()
	return p, nil
}

func (s *projectStore) rename(id, name string) (project, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 80 {
		return project{}, errors.New("a project needs a name of 1..80 characters")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[id]
	if !ok {
		return project{}, errors.New("no such project")
	}
	p.Name = name
	s.items[id] = p
	s.save()
	return p, nil
}

// Add a folder (and its parents) to a project.
func (s *projectStore) addFolder(id, path string) (project, error) {
	path, err := cleanFolder(path)
	if err != nil {
		return project{}, err
	}
	if path == "" {
		return project{}, errors.New("a folder needs a name")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[id]
	if !ok {
		return project{}, errors.New("no such project")
	}
	parts := strings.Split(path, "/")
	for i := range parts {
		prefix := strings.Join(parts[:i+1], "/")
		found := false
		for _, f := range p.Folders {
			if f == prefix {
				found = true
				break
			}
		}
		if !found {
			p.Folders = append(p.Folders, prefix)
		}
	}
	sort.Strings(p.Folders)
	s.items[id] = p
	s.save()
	return p, nil
}

// Rename a folder path (and everything under it); returns the clean old and new paths.
func (s *projectStore) renameFolder(id, from, to string) (string, string, error) {
	from, err := cleanFolder(from)
	if err != nil {
		return "", "", err
	}
	to, err = cleanFolder(to)
	if err != nil {
		return "", "", err
	}
	if from == "" || to == "" {
		return "", "", errors.New("give the folder's old and new names")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[id]
	if !ok {
		return "", "", errors.New("no such project")
	}
	var folders []string
	for _, f := range p.Folders {
		if inFolder(f, from) {
			f = to + strings.TrimPrefix(f, from)
		}
		folders = append(folders, f)
	}
	sort.Strings(folders)
	p.Folders = folders
	s.items[id] = p
	s.save()
	return from, to, nil
}

// Remove a folder path and everything under it; the clips are re-filed by the caller.
func (s *projectStore) removeFolder(id, path string) (string, error) {
	path, err := cleanFolder(path)
	if err != nil || path == "" {
		return "", errors.New("give the folder to remove")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[id]
	if !ok {
		return "", errors.New("no such project")
	}
	var folders []string
	for _, f := range p.Folders {
		if !inFolder(f, path) {
			folders = append(folders, f)
		}
	}
	p.Folders = folders
	s.items[id] = p
	s.save()
	return path, nil
}

func (s *projectStore) setPipeline(id string, cfg *pipelineConfig) (project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[id]
	if !ok {
		return project{}, errors.New("no such project")
	}
	if cfg.UProject == "" {
		p.Pipeline = nil
	} else {
		c := *cfg
		p.Pipeline = &c
	}
	s.items[id] = p
	s.save()
	return p, nil
}

func (s *projectStore) setSlots(id string, slots []string) (project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[id]
	if !ok {
		return project{}, errors.New("no such project")
	}
	if slots == nil {
		slots = []string{}
	}
	p.Slots = slots
	s.items[id] = p
	s.save()
	return p, nil
}

func (s *projectStore) setScene(id string, scene json.RawMessage) (project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[id]
	if !ok {
		return project{}, errors.New("no such project")
	}
	p.Scene = scene
	s.items[id] = p
	s.save()
	return p, nil
}

func (s *projectStore) setPrompts(id string, prompts []savedPrompt) (project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.items[id]
	if !ok {
		return project{}, errors.New("no such project")
	}
	if prompts == nil {
		prompts = []savedPrompt{}
	}
	p.Prompts = prompts
	s.items[id] = p
	s.save()
	return p, nil
}

func parentFolder(path string) string {
	if i := strings.LastIndex(path, "/"); i >= 0 {
		return path[:i]
	}
	return ""
}

func (s *projectStore) remove(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.items[id]; !ok {
		return false
	}
	delete(s.items, id)
	s.save()
	return true
}

// Name for downloads: the given name when there is one, else the id.
func (a *animation) fileStem() string {
	if a.Name != "" {
		stem := slugPattern.ReplaceAllString(strings.ToLower(a.Name), "-")
		if stem = strings.Trim(stem, "-"); stem != "" {
			return stem
		}
	}
	return "understudy-" + a.ID
}

// A hand-shape key: both hands' shapes from this frame on.
type handKey struct {
	Frame int    `json:"frame"`
	Left  string `json:"left"`
	Right string `json:"right"`
}

type clipPatch struct {
	Name      *string       `json:"name"`
	Project   *string       `json:"project"`
	Folder    *string       `json:"folder"`
	Favorite  *bool         `json:"favorite"`
	Archived  *bool         `json:"archived"`
	Trashed   *bool         `json:"trashed"`
	Markers   *[]clipMarker `json:"markers"`
	HandTrack *[]handKey    `json:"hand_track"`
	Tags      *[]string     `json:"tags"`
	Props     *[]stageProp  `json:"props"` // stage boxes; the checks are recomputed against them
}

// Tags: lower-case, trimmed, unique, at most 16 of up to 40 characters.
func cleanTags(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, t := range in {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" || len(t) > 40 || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
		if len(out) == 16 {
			break
		}
	}
	return out
}

// Apply a patch to one clip. Called with the gallery lock held.
func (g *gallery) applyPatch(a *animation, p clipPatch) error {
	if p.Props != nil {
		props := make([]stageProp, 0, len(*p.Props))
		for _, pr := range *p.Props {
			if pr.Kind == "" {
				pr.Kind = "box"
			}
			if pr.Kind != "box" || pr.Size[0] <= 0 || pr.Size[1] <= 0 || pr.Size[2] <= 0 || pr.Size[0] > 10 || pr.Size[1] > 5 || pr.Size[2] > 10 {
				return errors.New("a prop is a box with a positive size (at most 10 × 5 × 10 m)")
			}
			props = append(props, pr)
		}
		if len(props) > 16 {
			return errors.New("at most 16 props on a clip")
		}
		a.Props = props
		if model, ok := g.models[a.Model]; ok && a.roots != nil {
			sk := skeletonDefinitions[model.SkeletonKey]
			a.Metrics = withActionClip(computeMetrics(a.roots, a.rotations, sk, a.Props...), a, a.roots, a.rotations, sk)
		}
	}
	if p.Name != nil {
		name := strings.TrimSpace(*p.Name)
		if len(name) > 120 {
			return errors.New("a name is at most 120 characters")
		}
		a.Name = name
	}
	if p.Project != nil {
		project := g.projects.valid(*p.Project)
		if project != a.Project {
			a.Folder = "" // a folder belongs to its project
		}
		a.Project = project
	}
	if p.Folder != nil {
		folder, err := cleanFolder(*p.Folder)
		if err != nil {
			return err
		}
		if folder != "" && a.Project != "" {
			if _, err := g.projects.addFolder(a.Project, folder); err != nil {
				return err
			}
		}
		if a.Project == "" {
			folder = "" // the Inbox has no folders
		}
		a.Folder = folder
	}
	if p.Favorite != nil {
		a.Favorite = *p.Favorite
	}
	if p.Tags != nil {
		a.Tags = cleanTags(*p.Tags)
	}
	if p.Markers != nil {
		if len(*p.Markers) > 64 {
			return errors.New("at most 64 markers")
		}
		markers := make([]clipMarker, 0, len(*p.Markers))
		for _, m := range *p.Markers {
			m.Name = strings.TrimSpace(m.Name)
			if m.Frame < 0 || m.Frame >= a.Frames || m.Name == "" || len(m.Name) > 40 {
				return errors.New("each marker needs a frame inside the clip and a name of 1..40 characters")
			}
			markers = append(markers, m)
		}
		sort.Slice(markers, func(i, j int) bool { return markers[i].Frame < markers[j].Frame })
		a.Markers = markers
	}
	if p.HandTrack != nil {
		keys := *p.HandTrack
		if len(keys) > 256 {
			return errors.New("at most 256 hand keys")
		}
		valid := map[string]bool{"auto": true, "relaxed": true, "fist": true, "open": true, "point": true, "flat": true}
		for i := range keys {
			if keys[i].Frame < 0 || keys[i].Frame >= a.Frames {
				return errors.New("a hand key is outside the clip")
			}
			if keys[i].Left == "" {
				keys[i].Left = "auto"
			}
			if keys[i].Right == "" {
				keys[i].Right = "auto"
			}
			if !valid[keys[i].Left] || !valid[keys[i].Right] {
				return errors.New("hand shapes are auto, relaxed, fist, open, point or flat")
			}
		}
		sort.Slice(keys, func(i, j int) bool { return keys[i].Frame < keys[j].Frame })
		a.HandTrack = keys
	}
	if p.Trashed != nil {
		a.Trashed = *p.Trashed
		if a.Trashed {
			a.TrashedAt = time.Now().UTC().Format(time.RFC3339)
		} else {
			a.TrashedAt = ""
		}
	}
	if p.Archived != nil {
		a.Archived = *p.Archived
	}
	return g.save(a)
}

// Remove a clip and its files for good. Called with the gallery lock held.
func (g *gallery) remove(a *animation) {
	delete(g.items, a.ID)
	if g.output == "" || !safePathPart(a.ID) {
		return
	}
	// Nothing is destroyed at once: the files move to .deleted/<day>/ and are purged a week later.
	hold := filepath.Join(g.output, ".deleted", time.Now().Format("2006-01-02"))
	_ = os.MkdirAll(hold, 0755)
	if err := os.Rename(filepath.Join(g.output, a.ID+".json"), filepath.Join(hold, a.ID+".json")); err != nil {
		_ = os.Remove(filepath.Join(g.output, a.ID+".json"))
	}
	if err := os.Rename(filepath.Join(g.output, a.ID), filepath.Join(hold, a.ID)); err != nil {
		_ = os.RemoveAll(filepath.Join(g.output, a.ID))
	}
}

// Drop holding-area days older than a week.
func (g *gallery) purgeDeleted() {
	if g.output == "" {
		return
	}
	entries, err := os.ReadDir(filepath.Join(g.output, ".deleted"))
	if err != nil {
		return
	}
	for _, e := range entries {
		day, err := time.Parse("2006-01-02", e.Name())
		if err != nil || time.Since(day) < 7*24*time.Hour {
			continue
		}
		_ = os.RemoveAll(filepath.Join(g.output, ".deleted", e.Name()))
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// PATCH or DELETE /api/animations/<id>
func (g *gallery) handleAnimation(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodPatch:
		var p clipPatch
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&p); err != nil {
			http.Error(w, "invalid JSON: "+err.Error(), 400)
			return
		}
		g.mu.Lock()
		a := g.items[id]
		if a == nil {
			g.mu.Unlock()
			http.NotFound(w, r)
			return
		}
		err := g.applyPatch(a, p)
		copy := *a
		g.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		writeJSON(w, 200, &copy)
	case http.MethodDelete:
		g.mu.Lock()
		a := g.items[id]
		if a == nil {
			g.mu.Unlock()
			http.NotFound(w, r)
			return
		}
		if a.Status == "queued" || a.Status == "running" {
			g.mu.Unlock()
			http.Error(w, "that clip is still generating", http.StatusConflict)
			return
		}
		if r.URL.Query().Get("permanent") == "1" && a.Trashed {
			g.remove(a)
		} else {
			a.Trashed, a.TrashedAt = true, time.Now().UTC().Format(time.RFC3339)
			g.saveLogged(a)
		}
		g.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "PATCH, DELETE")
		http.Error(w, "PATCH or DELETE", http.StatusMethodNotAllowed)
	}
}

func registerLibraryRoutes(mux *http.ServeMux, g *gallery) {
	mux.HandleFunc("/api/projects", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			g.projects.mu.RLock()
			list := g.projects.list()
			g.projects.mu.RUnlock()
			writeJSON(w, 200, list)
		case http.MethodPost:
			var body struct {
				Name string `json:"name"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&body); err != nil {
				http.Error(w, "invalid JSON", 400)
				return
			}
			p, err := g.projects.create(body.Name)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			writeJSON(w, http.StatusCreated, p)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "GET or POST", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/api/projects/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/api/projects/")
		if strings.HasSuffix(id, "/folders") {
			g.handleFolders(w, r, strings.TrimSuffix(id, "/folders"))
			return
		}
		if id == "" || strings.Contains(id, "/") {
			http.NotFound(w, r)
			return
		}
		switch r.Method {
		case http.MethodPatch:
			var body struct {
				Name     *string         `json:"name"`
				Pipeline *pipelineConfig `json:"pipeline"`
				Slots    *[]string       `json:"slots"`
				Prompts  *[]savedPrompt  `json:"prompts"`
				Scene    json.RawMessage `json:"scene"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&body); err != nil {
				http.Error(w, "invalid JSON", 400)
				return
			}
			var p project
			var err error
			if body.Name != nil {
				if p, err = g.projects.rename(id, *body.Name); err != nil {
					http.Error(w, err.Error(), 400)
					return
				}
			}
			if body.Pipeline != nil {
				if p, err = g.projects.setPipeline(id, body.Pipeline); err != nil {
					http.Error(w, err.Error(), 400)
					return
				}
			}
			if body.Slots != nil {
				if p, err = g.projects.setSlots(id, cleanTags(*body.Slots)); err != nil {
					http.Error(w, err.Error(), 400)
					return
				}
			}
			if body.Prompts != nil {
				if len(*body.Prompts) > 200 {
					http.Error(w, "at most 200 saved prompts", 400)
					return
				}
				if p, err = g.projects.setPrompts(id, *body.Prompts); err != nil {
					http.Error(w, err.Error(), 400)
					return
				}
			}
			if len(body.Scene) > 0 {
				if len(body.Scene) > 1<<13 || !json.Valid(body.Scene) {
					http.Error(w, "scene must be valid JSON under 8 KB", 400)
					return
				}
				if p, err = g.projects.setScene(id, body.Scene); err != nil {
					http.Error(w, err.Error(), 400)
					return
				}
			}
			if body.Name == nil && body.Pipeline == nil && body.Slots == nil && body.Prompts == nil && len(body.Scene) == 0 {
				http.Error(w, "give a name, pipeline, slots, prompts or scene", 400)
				return
			}
			writeJSON(w, 200, p)
		case http.MethodDelete:
			// Clips filed under it go back to the Inbox.
			if !g.projects.remove(id) {
				http.NotFound(w, r)
				return
			}
			trash := r.URL.Query().Get("trash") == "1"
			g.mu.Lock()
			for _, a := range g.items {
				if a.Project == id {
					a.Project, a.Folder = "", ""
					if trash && a.Status != "queued" && a.Status != "running" {
						a.Trashed, a.TrashedAt = true, time.Now().UTC().Format(time.RFC3339)
					}
					g.saveLogged(a)
				}
			}
			g.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			w.Header().Set("Allow", "PATCH, DELETE")
			http.Error(w, "PATCH or DELETE", http.StatusMethodNotAllowed)
		}
	})
	// Bulk: {"ids": [...], "patch": {...}} or {"ids": [...], "delete": true}
	mux.HandleFunc("/api/trash/empty", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		n := 0
		g.mu.Lock()
		for _, a := range g.items {
			if a.Trashed && a.Status != "queued" && a.Status != "running" {
				g.remove(a)
				n++
			}
		}
		g.mu.Unlock()
		log.Printf("trash emptied: %d clips removed for good (from %s, %q, referer %q)", n, r.RemoteAddr, r.UserAgent(), r.Referer())
		writeJSON(w, 200, map[string]int{"removed": n})
	})
	mux.HandleFunc("/api/animations/batch", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			IDs       []string   `json:"ids"`
			Patch     *clipPatch `json:"patch"`
			Delete    bool       `json:"delete"`    // to the Trash (files kept)
			Permanent bool       `json:"permanent"` // with Delete: remove for good, only clips already in the Trash
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
			http.Error(w, "invalid JSON: "+err.Error(), 400)
			return
		}
		if len(body.IDs) == 0 || len(body.IDs) > 1000 || (body.Patch == nil && !body.Delete) {
			http.Error(w, "give 1..1000 ids and a patch or delete", 400)
			return
		}
		done, skipped := 0, 0
		g.mu.Lock()
		for _, id := range body.IDs {
			a := g.items[id]
			if a == nil {
				skipped++
				continue
			}
			if body.Delete {
				if a.Status == "queued" || a.Status == "running" {
					skipped++
					continue
				}
				if body.Permanent {
					if !a.Trashed {
						skipped++
						continue
					}
					log.Printf("deleted for good: %s %q (from %s, %q)", a.ID, a.Name, r.RemoteAddr, r.UserAgent())
					g.remove(a)
				} else {
					a.Trashed, a.TrashedAt = true, time.Now().UTC().Format(time.RFC3339)
					g.saveLogged(a)
				}
			} else if err := g.applyPatch(a, *body.Patch); err != nil {
				skipped++
				continue
			}
			done++
		}
		g.mu.Unlock()
		writeJSON(w, 200, map[string]int{"done": done, "skipped": skipped})
	})
}

// Folders of a project: POST {name} adds one, PATCH {from, to} renames one
// (re-filing its clips), DELETE ?name= removes one (its clips move up a level).
func (g *gallery) handleFolders(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&body); err != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		p, err := g.projects.addFolder(id, body.Name)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		writeJSON(w, http.StatusCreated, p)
	case http.MethodPatch:
		var body struct{ From, To string }
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&body); err != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		from, to, err := g.projects.renameFolder(id, body.From, body.To)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		g.mu.Lock()
		for _, a := range g.items {
			if a.Project == id && a.Folder != "" && inFolder(a.Folder, from) {
				a.Folder = to + strings.TrimPrefix(a.Folder, from)
				g.saveLogged(a)
			}
		}
		g.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		path, err := g.projects.removeFolder(id, r.URL.Query().Get("name"))
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		parent := parentFolder(path)
		g.mu.Lock()
		for _, a := range g.items {
			if a.Project == id && a.Folder != "" && inFolder(a.Folder, path) {
				a.Folder = parent
				g.saveLogged(a)
			}
		}
		g.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "POST, PATCH, DELETE")
		http.Error(w, "POST, PATCH or DELETE", http.StatusMethodNotAllowed)
	}
}
