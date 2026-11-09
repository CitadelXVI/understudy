// Clean-up: physics + anti-clipping (tools/cleanup/cleanup.py, MuJoCo). The clip's streams go to the tool,
// which tracks them with a colliding body (no limb through the body, feet on the floor, shakes damped),
// smooths what still shakes and pushes out what still overlaps, eased; the result comes back as the clip's
// new streams. Runs as the derive op "cleanup" (in place and undoable, or as a copy).
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var cleanupDir = filepath.Join("tools", "cleanup") // -cleanup flag

type cleanupReport map[string]any

func cleanupStreams(roots, rotations []float32, skeleton skeletonDefinition, strength float64, props ...stageProp) ([]float32, []float32, cleanupReport, error) {
	return cleanupStreamsOpts(roots, rotations, skeleton, strength, false, props...)
}

// cleanupStreamsOpts: keepSnap is the tracked-motion profile (the clip's own detail is the truth: the physics body's
// corrections are taken smoothed, and a lone fast reversal is not smoothed as a shake). Off for generated clips: it
// keeps Kimodo's shakes too (5 of 24 bench clips gained a jitter flag).
func cleanupStreamsOpts(roots, rotations []float32, skeleton skeletonDefinition, strength float64, keepSnap bool, props ...stageProp) ([]float32, []float32, cleanupReport, error) {
	return cleanupStreamsWith(roots, rotations, skeleton, strength, cleanupOptions{keepSnap: keepSnap}, props...)
}

// cleanupOptions: keepSnap is the tracked-motion profile; holdFeet keeps each planted toe where it landed (in-place
// moves: a crouch's feet drifted 8-13 cm; contact.hold_feet).
type cleanupOptions struct {
	keepSnap, holdFeet bool
	liftOnly           [2]int // frames: only lift the glides there into steps (nothing else runs); zero = off
	plantOnly          bool   // only plant.py: a foot that glides or spins while down is held, then stepped
	loose              bool   // loose.py: follow-through springs on the arms (walks, turns, everyday moves)
}

// looseArms: blind A/B 2026-10-30, follow-through springs on the arms won walks (6-5, 5-4) and turns (7-6, 7-6) and
// lost runs (4-5, 4-5): fast cyclic arms and strikes are left as generated
func looseArms(prompt string) bool {
	return looseOffEnv == "" && !looseSkipWords.MatchString(prompt)
}

var looseOffEnv = os.Getenv("UNDERSTUDY_NO_LOOSE")
var looseSkipWords = regexp.MustCompile(`(?i)\b(runs?|running|jogs?|jogging|sprints?|sprinting|punch(es)?|jabs?|hooks?|uppercuts?|kicks?|strikes?|throws?|flips?|cartwheels?|handstands?|push[- ]?ups?|climbs?|jumps?|leaps?|hops?)\b`)

// inPlaceMove: words for a move done standing in one spot with the feet planted (crouch, squat, bend down, pick
// something up). Not kneeling or sitting (a foot steps back), not a gait, a turn or a jump.
func inPlaceMove(prompt string) bool {
	p := strings.ToLower(prompt)
	for _, w := range []string{"walk", "run", "jog", "step", "turn", "jump", "hop", "kneel", "sit", "lie ", "lies", "lying", "dance", "spin", "kick", "lunge", "crawl"} {
		if strings.Contains(p, w) {
			return false
		}
	}
	return inPlaceWords.MatchString(p)
}

var inPlaceWords = regexp.MustCompile(`\b(crouch|crouches|crouching|squat|squats|squatting|ducks?|ducking|bends?\s+(down|over)|bending\s+(down|over)|reach(es)?\s+down|picks?\s+(\w+\s+){0,3}up|ties?\s+(\w+\s+)?shoe|idles?|idling|stands?\s+(idle|still|around|relaxed|and\s+breathes|waiting)|shift(s|ing)?\s+(their|his|her)\s+weight|weight\s+shift)`)

func cleanupStreamsWith(roots, rotations []float32, skeleton skeletonDefinition, strength float64, opt cleanupOptions, props ...stageProp) ([]float32, []float32, cleanupReport, error) {
	keepSnap := opt.keepSnap
	python := filepath.Join(cleanupDir, ".venv", "Scripts", "python.exe")
	script := filepath.Join(cleanupDir, "cleanup.py")
	if _, err := os.Stat(python); err != nil {
		return nil, nil, nil, fmt.Errorf("the clean-up tool is not installed (%s)", python)
	}
	work, err := os.MkdirTemp("", "understudy-cleanup-")
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
	if err := writeF32(filepath.Join(in, "root_positions.f32"), roots); err != nil {
		return nil, nil, nil, err
	}
	if err := writeF32(filepath.Join(in, "local_rotations_xyzw.f32"), rotations); err != nil {
		return nil, nil, nil, err
	}
	if len(props) > 0 { // stage boxes: physics keeps the body on them, the floor passes leave those frames alone
		pb, _ := json.Marshal(props)
		if err := os.WriteFile(filepath.Join(in, "props.json"), pb, 0o644); err != nil {
			return nil, nil, nil, err
		}
	}
	args := []string{in, out, "--strength", fmt.Sprintf("%.2f", strength), "--no-report"}
	if keepSnap {
		args = append(args, "--residual", "2", "--keep-snap", "--denoise", "0.6") // tracked motion: a light denoise first (tracker flicker in the hands), the clip's own detail otherwise kept
	}
	if opt.holdFeet {
		args = append(args, "--hold-feet")
	}
	if opt.loose {
		args = append(args, "--loose")
	}
	if opt.plantOnly {
		args = append(args, "--plant-only")
	}
	if opt.liftOnly[1] > 0 {
		args = append(args, "--lift-only", fmt.Sprintf("%d:%d", opt.liftOnly[0], opt.liftOnly[1]))
	}
	if werr := cleaner.run(python, script, args); werr != nil {
		// the kept process failed (or would not start): one plain run, as before
		log.Printf("clean-up worker: %v; running it once on its own", werr)
		cmd := exec.Command(python, append([]string{script}, args...)...)
		cmd.Env = append(os.Environ(), "PYTHONIOENCODING=utf-8")
		if msg, err := cmd.CombinedOutput(); err != nil {
			lines := strings.Split(strings.TrimSpace(string(msg)), "\n")
			return nil, nil, nil, fmt.Errorf("clean-up: %s", lines[len(lines)-1])
		}
	}
	newRoots, err := readF32(filepath.Join(out, "root_positions.f32"))
	if err != nil {
		return nil, nil, nil, err
	}
	newRot, err := readF32(filepath.Join(out, "local_rotations_xyzw.f32"))
	if err != nil {
		return nil, nil, nil, err
	}
	if len(newRoots) != len(roots) || len(newRot) != len(rotations) {
		return nil, nil, nil, fmt.Errorf("clean-up returned %d/%d values for %d/%d", len(newRoots), len(newRot), len(roots), len(rotations))
	}
	var rep cleanupReport
	if b, err := os.ReadFile(filepath.Join(out, "report.json")); err == nil {
		_ = json.Unmarshal(b, &rep)
	}
	// physics settles a jump a little differently; the floaty-jump arc (hips height only, never adding a shake) goes last
	newRoots, _ = arcStreams(newRoots, newRot, skeleton)
	return newRoots, newRot, rep, nil
}

func writeF32(path string, v []float32) error {
	b := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(b[i*4:], math.Float32bits(x))
	}
	return os.WriteFile(path, b, 0o644)
}

func readF32(path string) ([]float32, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	v := make([]float32, len(b)/4)
	for i := range v {
		v[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return v, nil
}

// POST /api/animations/import {name, project, model, prompt, tags, root: [T][3], rotations: [T][J][4] XYZW}
// A motion made elsewhere (GEM-X raw tracking, another tool's mocap) becomes a library clip with the usual checks.
func (g *gallery) handleImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Name      string        `json:"name"`
		Project   string        `json:"project"`
		Model     string        `json:"model"`
		Prompt    string        `json:"prompt"`
		Tags      []string      `json:"tags"`
		Root      [][]float32   `json:"root"`
		Rotations [][][]float32 `json:"rotations"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20)).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	model, ok := g.models[body.Model]
	if !ok {
		http.Error(w, "unknown model", 400)
		return
	}
	skeleton := skeletonDefinitions[model.SkeletonKey]
	joints, frames := len(skeleton.parents), len(body.Root)
	if frames < 2 || len(body.Rotations) != frames {
		http.Error(w, "root and rotations need one row per frame", 400)
		return
	}
	roots := make([]float32, 0, frames*3)
	rotations := make([]float32, 0, frames*joints*4)
	for f := 0; f < frames; f++ {
		if len(body.Root[f]) != 3 || len(body.Rotations[f]) != joints {
			http.Error(w, fmt.Sprintf("frame %d needs root[3] and %d rotations", f, joints), 400)
			return
		}
		roots = append(roots, body.Root[f]...)
		for j := 0; j < joints; j++ {
			q := body.Rotations[f][j]
			if len(q) != 4 {
				http.Error(w, "rotations are XYZW quaternions", 400)
				return
			}
			n := float32(math.Sqrt(float64(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3])))
			if !(n > 1e-6) {
				http.Error(w, "zero or invalid rotation", 400)
				return
			}
			rotations = append(rotations, q[0]/n, q[1]/n, q[2]/n, q[3]/n)
		}
	}
	glb, err := buildMotionGLB(roots, rotations, model.SkeletonKey)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	a := animation{ID: token(), Prompt: body.Prompt, Frames: frames, CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Status: "ready", Kind: "imported", Model: body.Model, Name: body.Name, Project: body.Project, Tags: body.Tags}
	a.roots, a.rotations, a.glb = roots, rotations, glb
	a.Metrics = withActionClip(computeMetrics(roots, rotations, skeleton, a.Props...), &a, roots, rotations, skeleton)
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

// One clean-up process kept running (cleanup.py --serve): Python and its libraries load once, not per clip (~2.4 s).
type cleanupWorker struct {
	mu  sync.Mutex
	cmd *exec.Cmd
	in  io.WriteCloser
	out *bufio.Reader
}

var cleaner cleanupWorker

func (w *cleanupWorker) run(python, script string, args []string) error {
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
		if err := cmd.Start(); err != nil {
			return err
		}
		w.cmd, w.in, w.out = cmd, in, bufio.NewReader(out)
	}
	line, _ := json.Marshal(args)
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

func (w *cleanupWorker) stop() {
	if w.cmd != nil && w.cmd.Process != nil {
		_ = w.cmd.Process.Kill()
		_ = w.cmd.Wait()
	}
	w.cmd, w.in, w.out = nil, nil, nil
}
