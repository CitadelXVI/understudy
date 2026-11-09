// MotionBricks (NVIDIA): in-betweening on SOMA clips, through tools/motionbricks/mb_serve.py (ONNX Runtime on the
// CPU, ~30 ms a generation). Three edits use it: regenerate a range of frames from the frames around it, settle a
// clip that ends mid-motion into a standing pose, and bridge a clip's end back to its start so it loops. The worker
// is one kept process, like the Clean up worker.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	mbDir    = filepath.Join("tools", "motionbricks") // -motionbricks flag
	mbPython = mbDefaultPython()                      // -motionbricks-python flag
)

// mbDefaultPython is the MotionBricks Python: $MOTIONBRICKS_PYTHON, else the .venv-ort inside the MotionBricks
// checkout ($MOTIONBRICKS, else ./motionbricks), the same folder tools/motionbricks/mb.py loads the ONNX model from.
func mbDefaultPython() string {
	if p := os.Getenv("MOTIONBRICKS_PYTHON"); p != "" {
		return p
	}
	root := os.Getenv("MOTIONBRICKS")
	if root == "" {
		root = "motionbricks"
	}
	return filepath.Join(root, ".venv-ort", "Scripts", "python.exe")
}

type mbReport map[string]any

type mbWorker struct {
	mu  sync.Mutex
	cmd *exec.Cmd
	in  io.WriteCloser
	out *bufio.Reader
}

var bricks mbWorker

// A key pose for a sequence: a saved pose's streams, placed relative to where the body is when it gets there
// (place = metres back along the facing, turn = degrees) unless absolute.
type mbPose struct {
	Root      [3]float32   `json:"root"`
	Rotations [][4]float32 `json:"rotations"`
	Place     float64      `json:"place,omitempty"`
	Turn      float64      `json:"turn,omitempty"`
	Absolute  bool         `json:"absolute,omitempty"`
	Tokens    []int        `json:"tokens,omitempty"`
	Onto      string       `json:"onto,omitempty"` // "sit": the hips go over the nearest box top; "hands": the hands' midpoint does (the box ahead)
	Hold      float64      `json:"hold,omitempty"` // seconds to stay in this pose once reached (a seat held, a lean held)
}

// mbSequence generates a clip through key poses in order (the first held as the start).
func mbSequence(poses []mbPose, skeleton skeletonDefinition, props []stageProp) ([]float32, []float32, mbReport, error) {
	return mbRun("sequence", nil, nil, skeleton, map[string]any{"poses": poses, "props": props})
}

// mbStreams runs one MotionBricks edit. op: regen (from..to replaced), settle, loop. tokens 0 = the worker's choice.
func mbStreams(op string, roots, rotations []float32, skeleton skeletonDefinition, from, to, tokens int) ([]float32, []float32, mbReport, error) {
	extra := map[string]any{"from": from, "to": to}
	if tokens > 0 {
		extra["tokens"] = tokens
	}
	return mbRun(op, roots, rotations, skeleton, extra)
}

func mbRun(op string, roots, rotations []float32, skeleton skeletonDefinition, extra map[string]any) ([]float32, []float32, mbReport, error) {
	script := filepath.Join(mbDir, "mb_serve.py")
	if _, err := os.Stat(mbPython); err != nil {
		return nil, nil, nil, fmt.Errorf("MotionBricks is not installed (%s)", mbPython)
	}
	if _, err := os.Stat(script); err != nil {
		return nil, nil, nil, fmt.Errorf("MotionBricks worker missing (%s)", script)
	}
	work, err := os.MkdirTemp("", "understudy-mb-")
	if err != nil {
		return nil, nil, nil, err
	}
	defer os.RemoveAll(work)
	in, out := filepath.Join(work, "in"), filepath.Join(work, "out")
	if err := os.MkdirAll(in, 0o755); err != nil {
		return nil, nil, nil, err
	}
	sk := map[string]any{"names": skeleton.names, "parents": skeleton.parents, "offsets": skeleton.offsets}
	b, _ := json.Marshal(sk)
	if err := os.WriteFile(filepath.Join(in, "skeleton.json"), b, 0o644); err != nil {
		return nil, nil, nil, err
	}
	if roots != nil {
		if err := writeF32(filepath.Join(in, "root_positions.f32"), roots); err != nil {
			return nil, nil, nil, err
		}
		if err := writeF32(filepath.Join(in, "local_rotations_xyzw.f32"), rotations); err != nil {
			return nil, nil, nil, err
		}
	}
	job := map[string]any{"in": in, "out": out, "op": op}
	for k, v := range extra {
		job[k] = v
	}
	if werr := bricks.run(mbPython, script, job); werr != nil {
		return nil, nil, nil, fmt.Errorf("MotionBricks: %v", werr)
	}
	newRoots, err := readF32(filepath.Join(out, "root_positions.f32"))
	if err != nil {
		return nil, nil, nil, err
	}
	newRot, err := readF32(filepath.Join(out, "local_rotations_xyzw.f32"))
	if err != nil {
		return nil, nil, nil, err
	}
	joints := len(skeleton.parents)
	if len(newRoots)/3 != len(newRot)/(joints*4) || len(newRoots) < 3 {
		return nil, nil, nil, fmt.Errorf("MotionBricks returned %d/%d values", len(newRoots), len(newRot))
	}
	var rep mbReport
	if b, err := os.ReadFile(filepath.Join(out, "report.json")); err == nil {
		_ = json.Unmarshal(b, &rep)
	}
	return newRoots, newRot, rep, nil
}

func (w *mbWorker) run(python, script string, job map[string]any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.cmd == nil {
		cmd := exec.Command(python, script, "--serve")
		cmd.Env = append(os.Environ(), "PYTHONIOENCODING=utf-8", "PYTHONUNBUFFERED=1")
		in, err := cmd.StdinPipe()
		if err != nil {
			return err
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		cmd.Stderr = nil
		if err := cmd.Start(); err != nil {
			return err
		}
		w.cmd, w.in, w.out = cmd, in, bufio.NewReader(out)
		log.Printf("MotionBricks worker started")
	}
	line, _ := json.Marshal(job)
	if _, err := w.in.Write(append(line, '\n')); err != nil {
		w.stop()
		return err
	}
	reply, err := w.out.ReadString('\n')
	if err != nil {
		w.stop()
		return err
	}
	reply = strings.TrimSpace(reply)
	if reply != "OK" {
		return fmt.Errorf("%s", strings.TrimPrefix(reply, "ERR "))
	}
	return nil
}

func (w *mbWorker) stop() {
	if w.cmd != nil && w.cmd.Process != nil {
		_ = w.cmd.Process.Kill()
		_ = w.cmd.Wait()
	}
	w.cmd, w.in, w.out = nil, nil, nil
}

// POST /api/animations/sequence {name, project, model, prompt, poses: [{id | root+rotations, place, turn, absolute, tokens}], clean_up}
// A clip generated through saved poses in order (MotionBricks), Clean up after unless clean_up is false. The
// first pose is the start (held 4 frames as the context), each later pose is reached in turn.
func (g *gallery) handleSequence(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Name    string      `json:"name"`
		Project string      `json:"project"`
		Model   string      `json:"model"`
		Prompt  string      `json:"prompt"`
		CleanUp *bool       `json:"clean_up"`
		Props   []stageProp `json:"props"` // stage boxes: poses over a box top are seated/stood on it; the clip keeps them
		Poses   []struct {
			ID string `json:"id"`
			mbPose
		} `json:"poses"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
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
	joints := len(skeleton.parents)
	poses := make([]mbPose, 0, len(body.Poses))
	for i, p := range body.Poses {
		mp := p.mbPose
		if p.ID != "" {
			g.poses.mu.RLock()
			sp, found := g.poses.items[p.ID]
			g.poses.mu.RUnlock()
			if !found {
				http.Error(w, fmt.Sprintf("pose %d: unknown id %q", i+1, p.ID), 400)
				return
			}
			if sp.SkeletonKey != model.SkeletonKey {
				http.Error(w, fmt.Sprintf("pose %d (%s) is for another skeleton", i+1, sp.Name), 400)
				return
			}
			mp.Root, mp.Rotations = sp.Root, sp.Rotations
		}
		if len(mp.Rotations) != joints {
			http.Error(w, fmt.Sprintf("pose %d needs %d joint rotations", i+1, joints), 400)
			return
		}
		poses = append(poses, mp)
	}
	if len(poses) < 2 {
		http.Error(w, "a sequence needs at least two poses", 400)
		return
	}
	t0 := time.Now()
	roots, rotations, rep, err := mbSequence(poses, skeleton, body.Props)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	cleaned := false
	if body.CleanUp == nil || *body.CleanUp {
		if cr, cq, _, cerr := cleanupStreams(roots, rotations, skeleton, 0.95, body.Props...); cerr == nil {
			roots, rotations, cleaned = cr, cq, true
		} else {
			log.Printf("sequence: clean-up failed: %v", cerr)
		}
	}
	glb, err := buildMotionGLB(roots, rotations, model.SkeletonKey)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	frames := len(roots) / 3
	a := animation{ID: token(), Prompt: body.Prompt, Frames: frames, CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Status: "ready", Kind: "sequence", Model: body.Model, Name: body.Name, Project: body.Project, Tags: []string{"motionbricks", "poses"}, Props: body.Props}
	a.roots, a.rotations, a.glb = roots, rotations, glb
	a.Metrics = withActionClip(computeMetrics(roots, rotations, skeleton, a.Props...), &a, roots, rotations, skeleton)
	log.Printf("%s: sequence of %d poses %.1f s -> %d frames (stages %v, cleaned %v) flags %v", a.ID, len(poses), time.Since(t0).Seconds(), frames, rep["stages"], cleaned, a.Metrics.Flags)
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
