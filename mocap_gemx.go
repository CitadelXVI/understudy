// GEM-X video tracking (NVIDIA GEM-X, NVlabs/GEM-X): a reference video goes in, SOMA joints per 30 Hz
// frame come out (the same skeleton family as Kimodo). It runs as a background job in GEM-X's own Python
// environment; the page turns the joints into keys (js/mocap.js loadSomaTrack). One job at a time.
//
// Enabled with -gemx <dir>: the GEM-X checkout holding weights/, assets/soma/, gemx_export.py and either
// .venv-rocm (PyTorch on ROCm: runs on the Radeon) or .venv (CPU).
package main

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type gemxJob struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Status    string   `json:"status"` // running, done, failed
	Stage     string   `json:"stage"`
	Device    string   `json:"device"`
	StartedAt string   `json:"started_at"`
	EndedAt   string   `json:"ended_at,omitempty"`
	Log       []string `json:"log"`
	Error     string   `json:"error,omitempty"`
	dir       string
}

var gemxStage = regexp.MustCompile(`^(Normalizing|Detecting|Extracting|Estimating|Predicting|Applying|Contact|Exporting)\b`)

var gemx = struct {
	sync.Mutex
	dir  string
	jobs map[string]*gemxJob
	busy bool
}{jobs: map[string]*gemxJob{}}

func gemxPython(name string) (string, string) {
	for _, env := range []struct{ venv, device string }{{".venv-rocm", "cuda"}, {".venv", "cpu"}} {
		p := filepath.Join(gemx.dir, env.venv, "Scripts", name)
		if _, err := os.Stat(p); err == nil {
			return p, env.device
		}
	}
	return "", ""
}

func (g *gallery) registerGemx(mux *http.ServeMux) {
	mux.HandleFunc("/api/mocap/gemx", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, device := gemxPython("gem-infer.exe")
			writeJSON(w, 200, map[string]any{"enabled": gemx.dir != "" && device != "" && g.output != "", "device": device})
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST a video", http.StatusMethodNotAllowed)
			return
		}
		if gemx.dir == "" || g.output == "" {
			http.Error(w, "GEM-X is not set up: start the server with -gemx <GEM-X folder>", 400)
			return
		}
		infer, device := gemxPython("gem-infer.exe")
		if infer == "" {
			http.Error(w, "GEM-X has no Python environment (.venv-rocm or .venv) in "+gemx.dir, 400)
			return
		}
		gemx.Lock()
		if gemx.busy {
			gemx.Unlock()
			// the upload is read (and dropped) before the answer: answering an unread video made the browser see a
			// reset connection ("Failed to fetch") instead of this message (control audit, 2026-10-29)
			_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, 512<<20))
			http.Error(w, "a GEM-X job is already running: wait for it to finish, then try again", http.StatusConflict)
			return
		}
		gemx.busy = true
		job := &gemxJob{ID: token(), Name: r.URL.Query().Get("name"), Status: "running", Stage: "receiving the video", Device: device, StartedAt: time.Now().UTC().Format(time.RFC3339), Log: []string{}}
		job.dir = filepath.Join(g.output, ".mocap", job.ID)
		if abs, err := filepath.Abs(job.dir); err == nil { // GEM-X runs from its own folder
			job.dir = abs
		}
		gemx.jobs[job.ID] = job
		gemx.Unlock()
		fail := func(msg string) {
			gemx.Lock()
			job.Status, job.Error, job.EndedAt, gemx.busy = "failed", msg, time.Now().UTC().Format(time.RFC3339), false
			gemx.Unlock()
		}
		if err := os.MkdirAll(job.dir, 0o755); err != nil {
			fail(err.Error())
			http.Error(w, err.Error(), 500)
			return
		}
		input := filepath.Join(job.dir, "input.mp4")
		f, err := os.Create(input)
		if err == nil {
			_, err = io.Copy(f, http.MaxBytesReader(w, r.Body, 512<<20))
			f.Close()
		}
		if err != nil {
			fail("upload: " + err.Error())
			http.Error(w, "upload: "+err.Error(), 400)
			return
		}
		// the video is in: from here on it is the tracker's work (the stage said "receiving the video" for the whole
		// two-minute run when the pipeline printed no stage line the regexp knows)
		gemx.Lock()
		job.Stage = "loading the tracker and tracking the video"
		gemx.Unlock()
		go runGemx(job, infer, input, fail)
		writeJSON(w, http.StatusAccepted, job)
	})
	mux.HandleFunc("/api/mocap/gemx-image", g.handleGemxImage)
	mux.HandleFunc("/api/mocap/gemx/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/mocap/gemx/")
		id, file, _ := strings.Cut(rest, "/")
		gemx.Lock()
		job := gemx.jobs[id]
		var copyJob gemxJob
		if job != nil {
			copyJob = *job
			copyJob.Log = append([]string(nil), job.Log...)
		}
		gemx.Unlock()
		if job == nil {
			http.NotFound(w, r)
			return
		}
		if file == "" {
			writeJSON(w, 200, copyJob)
			return
		}
		if file != "cam.json" && file != "world.json" && file != "rot.json" {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(copyJob.dir, "motion_"+file))
	})
}

// One image (a photo, an anime still, a video frame) -> one pose with native SOMA rotations. Synchronous:
// the Body Pose model loads per call (~20-40 s on the Radeon).
func (g *gallery) handleGemxImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST an image", http.StatusMethodNotAllowed)
		return
	}
	python, _ := gemxPython("python.exe")
	if gemx.dir == "" || g.output == "" || python == "" {
		http.Error(w, "GEM-X is not set up: start the server with -gemx <GEM-X folder>", 400)
		return
	}
	gemx.Lock()
	if gemx.busy {
		gemx.Unlock()
		_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, 64<<20)) // see the video handler
		http.Error(w, "a GEM-X job is already running: wait for it to finish, then try again", http.StatusConflict)
		return
	}
	gemx.busy = true
	gemx.Unlock()
	defer func() { gemx.Lock(); gemx.busy = false; gemx.Unlock() }()
	dir, err := filepath.Abs(filepath.Join(g.output, ".mocap", "image-"+token()))
	if err == nil {
		err = os.MkdirAll(dir, 0o755)
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	ext := ".png"
	if strings.Contains(r.Header.Get("Content-Type"), "jpeg") {
		ext = ".jpg"
	}
	input, out := filepath.Join(dir, "input"+ext), filepath.Join(dir, "pose.json")
	f, err := os.Create(input)
	if err == nil {
		_, err = io.Copy(f, http.MaxBytesReader(w, r.Body, 64<<20))
		f.Close()
	}
	if err != nil {
		http.Error(w, "upload: "+err.Error(), 400)
		return
	}
	cmd := exec.Command(python, "gemx_image.py", input, out)
	cmd.Dir = gemx.dir
	cmd.Env = append(os.Environ(), "HIP_VISIBLE_DEVICES=1", "PYTORCH_NO_HIP_MEMORY_CACHING=1", "GEMX_DML_DEVICE=0", "PYTHONIOENCODING=utf-8")
	if b, err := cmd.CombinedOutput(); err != nil {
		lines := strings.Split(strings.TrimSpace(string(b)), "\n")
		http.Error(w, "GEM-X: "+lines[len(lines)-1], 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	http.ServeFile(w, r, out)
}

func runGemx(job *gemxJob, infer, input string, fail func(string)) {
	logLine := func(s string) {
		gemx.Lock()
		job.Log = append(job.Log, s)
		if len(job.Log) > 200 {
			job.Log = job.Log[len(job.Log)-200:]
		}
		if gemxStage.MatchString(s) { // the pipeline's own stage lines, not library chatter
			job.Stage = s
		}
		gemx.Unlock()
	}
	run := func(name string, args ...string) error {
		cmd := exec.Command(name, args...)
		cmd.Dir = gemx.dir
		// ROCm: device 1 is the Radeon (0 is the integrated GPU); DirectML adapter 0 is the Radeon for the detector.
		cmd.Env = append(os.Environ(), "HIP_VISIBLE_DEVICES=1", "PYTORCH_NO_HIP_MEMORY_CACHING=1", "GEMX_DML_DEVICE=0", "PYTHONIOENCODING=utf-8", "PYTHONUNBUFFERED=1")
		out, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		cmd.Stderr = cmd.Stdout
		if err := cmd.Start(); err != nil {
			return err
		}
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		for sc.Scan() {
			logLine(strings.TrimRight(sc.Text(), "\r"))
		}
		return cmd.Wait()
	}
	// The models run on the GPU; contact/IK uses NVIDIA Warp, which has no AMD path, so it runs on the CPU
	// as a second step. The DirectML config puts the person detector on the Radeon too (ROCm env only).
	device := job.Device
	config := "body_video_native77_static.yaml"
	if device == "cuda" {
		config = "body_video_native77_static_dml.yaml"
	}
	raw, motion := filepath.Join(job.dir, "raw.pt"), filepath.Join(job.dir, "motion.pt")
	if err := run(infer, "motion-video", "--task", "body", "--input", input,
		"--config", filepath.Join("weights", config), "--device", device, "--output", raw); err != nil {
		fail(fmt.Sprintf("GEM-X: %v", err))
		return
	}
	logLine("Contact and foot clean-up")
	if err := run(infer, "motion-cache", "--task", "body", "--input", raw, "--postprocess",
		"--soma-assets", filepath.Join("assets", "soma"), "--device", "cpu", "--output", motion); err != nil {
		fail(fmt.Sprintf("GEM-X clean-up: %v", err))
		return
	}
	python, _ := gemxPython("python.exe")
	logLine("Exporting SOMA joints")
	if err := run(python, "gemx_export.py", motion, filepath.Join(job.dir, "motion")); err != nil {
		fail(fmt.Sprintf("export: %v", err))
		return
	}
	gemx.Lock()
	job.Status, job.Stage, job.EndedAt, gemx.busy = "done", "done", time.Now().UTC().Format(time.RFC3339), false
	gemx.Unlock()
}
