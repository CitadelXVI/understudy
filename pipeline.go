// Send to pipeline: run the Unreal import/retarget script for a clip as a
// background job. One Unreal process at a time; the editor must be closed.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Per-project pipeline settings, stored on the project record.
type pipelineConfig struct {
	UProject    string `json:"uproject"`               // C:\...\Game.uproject
	Editor      string `json:"editor,omitempty"`       // UnrealEditor-Cmd.exe; default UE 5.8
	TargetMesh  string `json:"target_mesh,omitempty"`  // /Game/Characters/Mannequins/Meshes/SKM_Manny
	ContentPath string `json:"content_path,omitempty"` // /Game/Understudy
	ExportDir   string `json:"export_dir,omitempty"`   // where FBX files land; default <uproject dir>/Understudy
	ExtraArgs   string `json:"extra_args,omitempty"`   // e.g. -DisablePlugins=Aura
}

const defaultEditor = `C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe`

type pipelineJob struct {
	ID        string   `json:"id"`
	Clip      string   `json:"clip"`
	Project   string   `json:"project"`
	Name      string   `json:"name"`
	Status    string   `json:"status"` // queued, running, done, failed
	StartedAt string   `json:"started_at"`
	EndedAt   string   `json:"ended_at,omitempty"`
	Log       []string `json:"log"`
	Assets    []string `json:"assets,omitempty"`
	FBX       string   `json:"fbx,omitempty"`
	Error     string   `json:"error,omitempty"`
}

type jobStore struct {
	mu    sync.Mutex
	items map[string]*pipelineJob
	busy  bool
}

var jobs = &jobStore{items: map[string]*pipelineJob{}}

func (g *gallery) handlePipeline(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	if runtime.GOOS != "windows" {
		http.Error(w, "the Unreal pipeline runs on Windows", 400)
		return
	}
	g.mu.RLock()
	a := g.items[id]
	var clip animation
	if a != nil {
		clip = *a
	}
	g.mu.RUnlock()
	if a == nil || clip.Status != "ready" {
		http.Error(w, "no such ready clip", http.StatusNotFound)
		return
	}
	g.projects.mu.RLock()
	project, ok := g.projects.items[clip.Project]
	g.projects.mu.RUnlock()
	if !ok || project.Pipeline == nil || project.Pipeline.UProject == "" {
		http.Error(w, "this clip's project has no Unreal project set: open the project's ⋯ menu → Pipeline settings", 400)
		return
	}
	cfg := *project.Pipeline
	if cfg.Editor == "" {
		cfg.Editor = defaultEditor
	}
	if cfg.ContentPath == "" {
		cfg.ContentPath = "/Game/Understudy"
	}
	if cfg.ExportDir == "" {
		cfg.ExportDir = filepath.Join(filepath.Dir(cfg.UProject), "Understudy")
	}
	if abs, err := filepath.Abs(cfg.ExportDir); err == nil {
		cfg.ExportDir = abs
	}
	if _, err := os.Stat(cfg.UProject); err != nil {
		http.Error(w, "the .uproject was not found: "+cfg.UProject, 400)
		return
	}
	if _, err := os.Stat(cfg.Editor); err != nil {
		http.Error(w, "UnrealEditor-Cmd.exe was not found: "+cfg.Editor, 400)
		return
	}
	if g.output == "" {
		http.Error(w, "the pipeline needs a persisted library (-output)", 400)
		return
	}
	jobs.mu.Lock()
	if jobs.busy {
		jobs.mu.Unlock()
		http.Error(w, "a pipeline job is already running; one Unreal process at a time", http.StatusConflict)
		return
	}
	if editorRunning() {
		jobs.mu.Unlock()
		http.Error(w, "close the Unreal Editor first: the pipeline needs the project to itself", http.StatusConflict)
		return
	}
	jobs.busy = true
	job := &pipelineJob{ID: token(), Clip: clip.ID, Project: clip.Project, Name: clip.fileStem(), Status: "queued", StartedAt: time.Now().UTC().Format(time.RFC3339), Log: []string{}}
	jobs.items[job.ID] = job
	jobs.mu.Unlock()
	go g.runPipeline(job, clip, cfg)
	writeJSON(w, http.StatusAccepted, job)
}

func editorRunning() bool {
	out, err := exec.Command("tasklist", "/fi", "imagename eq UnrealEditor.exe").Output()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), "unrealeditor.exe")
}

func (g *gallery) runPipeline(job *pipelineJob, clip animation, cfg pipelineConfig) {
	defer func() {
		jobs.mu.Lock()
		jobs.busy = false
		job.EndedAt = time.Now().UTC().Format(time.RFC3339)
		jobs.mu.Unlock()
	}()
	logf := func(format string, args ...any) {
		jobs.mu.Lock()
		job.Log = append(job.Log, fmt.Sprintf(format, args...))
		jobs.mu.Unlock()
	}
	fail := func(err error) {
		jobs.mu.Lock()
		job.Status = "failed"
		job.Error = err.Error()
		jobs.mu.Unlock()
	}
	jobs.mu.Lock()
	job.Status = "running"
	jobs.mu.Unlock()
	// Stage the clip beside the library as a skinned GLB so Interchange makes a skeletal mesh + skeleton.
	model, ok := g.models[clip.Model]
	if !ok {
		fail(errors.New("the clip's model is unknown"))
		return
	}
	skinned, err := buildSkinnedGLB(clip.roots, clip.rotations, skeletonDefinitions[model.SkeletonKey])
	if err != nil {
		fail(err)
		return
	}
	glbPath, err := filepath.Abs(filepath.Join(g.output, clip.ID, "skinned.glb"))
	if err != nil {
		fail(err)
		return
	}
	if err := os.WriteFile(glbPath, skinned, 0644); err != nil {
		fail(err)
		return
	}
	script, err := pipelineScriptPath()
	if err != nil {
		fail(err)
		return
	}
	if err := os.MkdirAll(cfg.ExportDir, 0755); err != nil {
		fail(err)
		return
	}
	markers, _ := json.Marshal(clip.Markers)
	hands, _ := json.Marshal(handCurve(&clip))
	logPath := filepath.Join(filepath.Dir(cfg.UProject), "Saved", "Logs", "Understudy.log")
	args := []string{cfg.UProject, "-run=pythonscript", "-script=" + script, "-unattended", "-nosplash", "-nullrhi", "-log=Understudy.log"}
	if cfg.ExtraArgs != "" {
		args = append(args, strings.Fields(cfg.ExtraArgs)...)
	}
	cmd := exec.Command(cfg.Editor, args...)
	cmd.Env = append(os.Environ(),
		"UNDERSTUDY_GLB="+glbPath,
		"UNDERSTUDY_NAME="+job.Name,
		"UNDERSTUDY_CONTENT="+cfg.ContentPath,
		"UNDERSTUDY_TARGET="+cfg.TargetMesh,
		"UNDERSTUDY_EXPORT_DIR="+cfg.ExportDir,
		"UNDERSTUDY_MARKERS="+string(markers),
		"UNDERSTUDY_HANDS="+string(hands),
		"UNDERSTUDY_FPS=30",
	)
	logf("Running Unreal on %s", filepath.Base(cfg.UProject))
	start := time.Now()
	out, err := cmd.CombinedOutput()
	logf("Unreal finished in %.0f s", time.Since(start).Seconds())
	// The script prints "UNDERSTUDY <key> <value>" lines; gather them from the log file (stdout is sparse in commandlets).
	var text string
	if b, readErr := os.ReadFile(logPath); readErr == nil {
		text = string(b)
	} else {
		text = string(out)
	}
	var failed bool
	for _, line := range strings.Split(text, "\n") {
		i := strings.Index(line, "UNDERSTUDY ")
		if i < 0 {
			if strings.Contains(line, "LogPython: Error:") {
				logf("%s", strings.TrimSpace(line[strings.Index(line, "LogPython: Error:"):]))
				failed = true
			}
			continue
		}
		rest := strings.TrimSpace(line[i+len("UNDERSTUDY "):])
		logf("%s", rest)
		switch {
		case strings.HasPrefix(rest, "asset "):
			jobs.mu.Lock()
			job.Assets = append(job.Assets, strings.TrimPrefix(rest, "asset "))
			jobs.mu.Unlock()
		case strings.HasPrefix(rest, "fbx "):
			jobs.mu.Lock()
			job.FBX = strings.TrimPrefix(rest, "fbx ")
			jobs.mu.Unlock()
		case strings.HasPrefix(rest, "error "):
			failed = true
		}
	}
	// The script's own "done" line is the verdict; the commandlet's exit code
	// is noisy (warnings on shutdown return 1 on some projects).
	done := strings.Contains(text, "UNDERSTUDY done ")
	if err != nil && !failed && !done {
		logf("Unreal exited with an error: %v", err)
		failed = true
	} else if err != nil && done {
		logf("Unreal exited with %v after finishing; ignored", err)
	}
	jobs.mu.Lock()
	if failed {
		job.Status = "failed"
		if job.Error == "" {
			job.Error = "see the job log"
		}
	} else {
		job.Status = "done"
	}
	jobs.mu.Unlock()
}

// The Unreal script ships beside the executable (understudy/pipeline/understudy_ue.py in the repo).
func pipelineScriptPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	candidates := []string{
		filepath.Join(filepath.Dir(exe), "..", "understudy", "pipeline", "understudy_ue.py"),
		filepath.Join(filepath.Dir(exe), "pipeline", "understudy_ue.py"),
		filepath.Join("understudy", "pipeline", "understudy_ue.py"),
	}
	for _, c := range candidates {
		if abs, err := filepath.Abs(c); err == nil {
			if _, err := os.Stat(abs); err == nil {
				return abs, nil
			}
		}
	}
	return "", errors.New("understudy_ue.py was not found beside the server")
}

func handleJobs(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/api/jobs"), "/")
	jobs.mu.Lock()
	defer jobs.mu.Unlock()
	if id == "" {
		list := make([]*pipelineJob, 0, len(jobs.items))
		for _, j := range jobs.items {
			list = append(list, j)
		}
		writeJSON(w, 200, list)
		return
	}
	j, ok := jobs.items[id]
	if !ok {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, 200, j)
}

// One hand shape per frame, from the clip's hand track (empty when the track is empty:
// the engine side then leaves the hands to its own rule).
func handCurve(a *animation) map[string]any {
	if len(a.HandTrack) == 0 {
		return map[string]any{}
	}
	left, right := make([]string, a.Frames), make([]string, a.Frames)
	curL, curR, k := "auto", "auto", 0
	for f := 0; f < a.Frames; f++ {
		for k < len(a.HandTrack) && a.HandTrack[k].Frame <= f {
			curL, curR = a.HandTrack[k].Left, a.HandTrack[k].Right
			k++
		}
		left[f], right[f] = curL, curR
	}
	return map[string]any{"left": left, "right": right}
}
