// Understudy, an animation tool: a local text-to-motion service
// on kimodo.cpp. Generation is serialized so one native
// process owns Vulkan at a time, while the in-memory gallery stays readable.
// The native worker streams each motion back over its stdout; the gallery
// keeps animations (their raw streams and the GLB built from them) in
// memory.  By default nothing is written to disk and only the most recent
// animations are kept (scripts/start-server.bat); with -output the gallery
// also persists to that directory and reloads on the next start
// (scripts/start-demo.bat).
package main

import (
	"bufio"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Understudy: an animation tool on top of the kimodo.cpp service.
// The page and its scripts live in static/, embedded at build time; -static
// serves them from disk instead so page edits need no rebuild.
//
//go:embed static
var embeddedStatic embed.FS

// A prompt segment is 2..12 s: the demo's default is 150 frames (5 s); the
// model's positions are sinusoidal, so the ceiling is policy, and the native
// core enforces the same one.  Advertised on /api/models as max_frames so a
// client (ContraptionFabricator's Clip Editor) sizes its control from it.
const minSegmentFrames, maxSegmentFrames = 60, 360

// Upstream's post-processing root margin: how far (metres) a corrected root
// may stay from a root target.
const defaultRootMargin = 0.04

// How many finished animations the in-memory gallery keeps (about a quarter
// of a megabyte each at 360 frames); older ones go.  Queued and running
// items are never evicted.  Only without -output: a persisted gallery keeps
// everything, the directory being its history.
const galleryKeep = 64

type animation struct {
	ID               string             `json:"id"`
	Prompt           string             `json:"prompt"`
	Frames           int                `json:"frames"`
	DiffusionSteps   int                `json:"diffusion_steps"`
	Seed             uint64             `json:"seed"`
	CreatedAt        string             `json:"created_at"`
	Status           string             `json:"status"`
	Error            string             `json:"error,omitempty"`
	Kind             string             `json:"kind"`
	Model            string             `json:"model"`
	TextQuantization string             `json:"text_quantization"`
	Segments         []promptSegment    `json:"segments,omitempty"`
	TransitionFrames int                `json:"transition_frames,omitempty"`
	TextCFG          float64            `json:"text_cfg,omitempty"`
	Constraints      []motionConstraint `json:"constraints,omitempty"`
	ConstraintCFG    float64            `json:"constraint_cfg,omitempty"`
	FirstHeading     float64            `json:"first_heading,omitempty"`
	PostProcessing   bool               `json:"post_processing"`
	RootMargin       float64            `json:"root_margin,omitempty"`
	Progress         string             `json:"progress,omitempty"`
	// Library organisation (Understudy): a given name, the project it is
	// filed under ("" = Inbox), favourite and archived flags.
	Name string `json:"name,omitempty"`
	// Takes: several seeds of one prompt generated together share a batch.
	Batch   string       `json:"batch,omitempty"`
	Take    int          `json:"take,omitempty"`
	Takes   int          `json:"takes,omitempty"`
	Metrics *clipMetrics `json:"metrics,omitempty"`
	// Derived clips (mirror, retime) remember where they came from.
	Source     string       `json:"source,omitempty"`
	Derivation string       `json:"derivation,omitempty"`
	Markers    []clipMarker `json:"markers,omitempty"` // named frames: hit, plant, release…
	Tags       []string     `json:"tags,omitempty"`    // coverage slots: idle, walk, jab…
	// Iteration lineage from the page's keep ranges: {parent, keeps: [{from, frames, part}], free?: [in, out]}.
	Lineage json.RawMessage `json:"lineage,omitempty"`
	Edits   int             `json:"edits,omitempty"` // in-place edits applied on the stage (undo depth)
	Redos   int             `json:"redos,omitempty"` // edits undone and still redoable
	// Guardrails: what the last in-place edit did that a person may not want (movement removed, a joint bent past
	// its range), and whether the clip's original streams are kept on disk for "Revert to original".
	Warnings    []string `json:"warnings,omitempty"`
	EditNote    string   `json:"edit_note,omitempty"`  // what the last in-place edit chose (best-of regenerate), for the status line
	RegenAlts   int      `json:"regen_alts,omitempty"` // other versions of the last regenerated stretch, one click away ("Try another version")
	HasOriginal bool     `json:"has_original,omitempty"`
	// Scenes: which actor this clip was generated for, and the prompt as the user wrote it ("Actor 1 dodges Actor 2").
	Actor        int    `json:"actor,omitempty"`
	ActorPrompt  string `json:"actor_prompt,omitempty"`
	CleanWrists  bool   `json:"clean_wrists,omitempty"`  // wrist clamp + smoothing applied right after generation
	CleanHands   bool   `json:"clean_hands,omitempty"`   // hands pushed out of the head right after generation
	HandFixes    int    `json:"hand_fixes,omitempty"`    // frames the clean-hands pass touched
	GroundHands  bool   `json:"ground_hands,omitempty"`  // hands that reach for the floor are planted on it
	GroundFixes  int    `json:"ground_fixes,omitempty"`  // frames the ground pass touched
	GroundFeet   bool   `json:"ground_feet,omitempty"`   // planted feet lowered to the floor (a clip that rolls and stands up no longer ends hovering)
	FloorFixes   int    `json:"floor_fixes,omitempty"`   // planted frames the floor pass lowered
	SmoothJitter bool   `json:"smooth_jitter,omitempty"` // joints that shake back and forth are smoothed where they shake
	CleanUp      bool   `json:"clean_up,omitempty"`      // physics + anti-clipping (tools/cleanup): no limb through the body, no shake
	// Finish settled (settle.go): a hidden "stops and stands still" segment, then the idle past a short hold trimmed.
	FinishSettled bool `json:"finish_settled,omitempty"`
	TrimFrom      int  `json:"trim_from,omitempty"`      // generated frames cut from the start
	TrimmedFrames int  `json:"trimmed_frames,omitempty"` // generated frames cut in all (start + end)
	ActionRetries int  `json:"action_retries,omitempty"` // takes that miss the prompt's move are generated again, up to this many times
	Candidates    int  `json:"candidates,omitempty"`     // versions made of every take, the best kept (choose.go)
	ActionTries   int  `json:"action_tries,omitempty"`   // …the retry that was kept (0: the first take)
	leadFrames    int  // generated standing frames before the user's segments (a split compound prompt)

	reachFrom int     // a trim after generation: frames cut from the start (reach.go maps pins through it)
	reachDX   float32 // and how far the trim moved the clip's start along X
	reachDZ   float32 // and along Z
	// pre-roll (preroll.go): frames of the leading movement generated first and cut off, so the clip is in character
	// from frame 1; it then starts moving on purpose (StartsMoving: the page does not call that a problem)
	Preroll      int  `json:"preroll,omitempty"`
	StartsMoving bool `json:"starts_moving,omitempty"`
	prerollText  string
	reword       bool   // this attempt uses the clearer retry wording (action.go)
	settleText   string // the hidden settle segment's words when not settlePrompt (a combat move's guard lowered)
	noCalmLead   bool   // the request turned the calm lead off (settle.go)
	RetryWording string `json:"retry_wording,omitempty"` // the wording the kept retry used, when it was not the user's
	Verdict      string `json:"verdict,omitempty"`       // set when every take missed the move: what the model could not do (the clip is shown anyway, as the best of them)
	CleanUpError string `json:"clean_up_error,omitempty"`
	JitterFixes  int    `json:"jitter_fixes,omitempty"` // joint-frames the jitter pass smoothed
	// Hand shapes over time, set on the page: each key holds from its frame until the next
	// (eased over a few frames). Shapes: auto, relaxed, fist, open, point, flat.
	HandTrack []handKey   `json:"hand_track,omitempty"`
	Props     []stageProp `json:"props,omitempty"` // boxes on the stage this clip was made with (seat, ledge, vault)
	undo      []*previousStreams
	redo      []*previousStreams
	// Keys set on the timeline (layer.go), and the motion under them (kept beside the clip).
	Layer      *keyLayer `json:"layer,omitempty"`
	layerRoots []float32
	layerRot   []float32
	Project    string `json:"project,omitempty"`
	Folder     string `json:"folder,omitempty"`
	Favorite   bool   `json:"favorite,omitempty"`
	Archived   bool   `json:"archived,omitempty"`
	// Trash: Delete puts a clip here (files kept) until the Trash is emptied or it is deleted for good.
	Trashed   bool   `json:"trashed,omitempty"`
	TrashedAt string `json:"trashed_at,omitempty"`
	// The motion itself, held in memory: the raw streams the viewer plays
	// and the GLB built from them.  Written to disk only with -output.
	roots     []float32
	rotations []float32
	glb       []byte
	// The constraints as the worker's field (encodeConstraints).
	constraintField string
}
type promptSegment struct {
	Prompt string `json:"prompt"`
	Frames int    `json:"frames"`
}
type motionModel struct {
	ID          string       `json:"id"`
	Label       string       `json:"label"`
	Skeleton    string       `json:"skeleton"`
	SkeletonKey string       `json:"skeleton_key"`
	Upstream    string       `json:"upstream"`
	License     string       `json:"license"`
	LicenseURL  string       `json:"license_url"`
	Commercial  bool         `json:"commercial"`
	Available   bool         `json:"available"`
	Reason      string       `json:"reason,omitempty"`
	MaxFrames   int          `json:"max_frames"`
	JointNames  []string     `json:"joint_names"`
	Parents     []int        `json:"parents"`
	Offsets     [][3]float32 `json:"offsets"`
	Motion      string       `json:"-"`
}
type textBundle struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Available   bool   `json:"available"`
	Reason      string `json:"reason,omitempty"`
	Bytes       int64  `json:"bytes,omitempty"`
	Path        string `json:"-"`
}
type gallery struct {
	mu          sync.RWMutex
	items       map[string]*animation
	output      string // "" = in memory only; else the gallery persists here
	generator   string
	queue       chan string
	models      map[string]motionModel
	textBundles map[string]textBundle
	projects    *projectStore
	poses       *poseStore
	regenAlts   map[string]*regenAltSet // per clip: the runners-up of its last best-of regenerate
}

// defaultModelID is the model a request without one gets: SOMA RP v1.2 when its weights are present, else SOMA RP
// v1.1 (the published GGUF download), else v1.2 so the error names the preferred model.
func (g *gallery) defaultModelID() string {
	for _, id := range []string{"soma-rp-v1.2", "soma-rp-v1.1"} {
		if m, ok := g.models[id]; ok && m.Available {
			return id
		}
	}
	return "soma-rp-v1.2"
}

// warmUp starts the generator for the default model and runs one short throwaway generation, so loading the
// model and compiling its GPU kernels (about 50 s) happens when the server starts, not on the first click.
func (g *gallery) warmUp() *generatorSession {
	var model motionModel
	found := false
	for _, m := range g.models {
		if m.Available && (!found || m.ID == "soma-rp-v1.2") {
			model, found = m, true
		}
	}
	text, ok := g.textBundles["q8_0"]
	if !found || !ok || !text.Available {
		return nil
	}
	start := time.Now()
	session, err := startGeneratorSession(g.generator, model, text)
	if err != nil {
		log.Printf("warm-up: %v", err)
		return nil
	}
	item := &animation{DiffusionSteps: 10, Seed: 1, TextCFG: 2, TransitionFrames: 5, PostProcessing: true}
	if _, _, err := session.generate(item, []promptSegment{{Prompt: "A person stands still.", Frames: 60}}); err != nil {
		log.Printf("warm-up: %v", err)
		session.close()
		return nil
	}
	log.Printf("warm-up: %s ready in %.1f s", model.ID, time.Since(start).Seconds())
	return session
}

type generatorSession struct {
	key    string
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}

func startGeneratorSession(generator string, model motionModel, text textBundle) (*generatorSession, error) {
	cmd := exec.Command(generator, "--server", model.Motion, text.Path)
	cmd.Env = append(os.Environ(), "KIMODO_BACKEND=vulkan", "KIMODO_TEXT_LAYER_CHUNK=32", "KIMODO_TEXT_RESIDENT_LIMIT_MIB=10000")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, err
	}
	return &generatorSession{key: model.Motion + "\x00" + text.Path, cmd: cmd, stdin: stdin, stdout: bufio.NewReader(stdout)}, nil
}

func (session *generatorSession) close() {
	if session == nil {
		return
	}
	_ = session.stdin.Close()
	_ = session.cmd.Wait()
}

// One request per line to the native worker: transition, steps, seed,
// text_cfg, constraint_cfg, first_heading, post_process (0/1), root_margin,
// the constraints field (encodeConstraints), then (frames, prompt) pairs with
// the prompt
// base64-encoded so a paragraph with tabs or newlines stays one field.  The
// reply is one line,
// "OK\tframes\tjoints", followed by the motion as raw little-endian float32
// (frames*3 root positions, then frames*joints*4 local XYZW rotations), or
// "ERR\tmessage".  Nothing touches the disk on either side.
func (session *generatorSession) generate(item *animation, segments []promptSegment) ([]float32, []float32, error) {
	constraintCFG, constraintField := item.ConstraintCFG, item.constraintField
	if constraintCFG == 0 {
		constraintCFG = 2
	}
	if constraintField == "" {
		constraintField = "-"
	}
	postProcess, rootMargin := "0", item.RootMargin
	if item.PostProcessing {
		postProcess = "1"
	}
	if rootMargin == 0 {
		rootMargin = defaultRootMargin
	}
	fields := []string{fmt.Sprint(item.TransitionFrames), fmt.Sprint(item.DiffusionSteps), fmt.Sprint(item.Seed), strconv.FormatFloat(item.TextCFG, 'f', -1, 64),
		strconv.FormatFloat(constraintCFG, 'f', -1, 64), strconv.FormatFloat(item.FirstHeading, 'f', -1, 64),
		postProcess, strconv.FormatFloat(rootMargin, 'f', -1, 64), constraintField}
	for _, segment := range segments {
		fields = append(fields, fmt.Sprint(segment.Frames), base64.StdEncoding.EncodeToString([]byte(segment.Prompt)))
	}
	if _, err := fmt.Fprintln(session.stdin, strings.Join(fields, "\t")); err != nil {
		return nil, nil, err
	}
	response, err := session.stdout.ReadString('\n')
	if err != nil {
		return nil, nil, fmt.Errorf("native worker stopped: %w", err)
	}
	response = strings.TrimSpace(response)
	if strings.HasPrefix(response, "ERR\t") {
		return nil, nil, fmt.Errorf("native worker: %s", strings.TrimPrefix(response, "ERR\t"))
	}
	parts := strings.Split(response, "\t")
	if len(parts) != 3 || parts[0] != "OK" {
		return nil, nil, fmt.Errorf("invalid native worker response %q", response)
	}
	frames, framesErr := strconv.Atoi(parts[1])
	joints, jointsErr := strconv.Atoi(parts[2])
	if framesErr != nil || jointsErr != nil || frames < 1 || joints < 1 {
		return nil, nil, fmt.Errorf("invalid native worker response %q", response)
	}
	roots, err := session.readF32(frames * 3)
	if err != nil {
		return nil, nil, fmt.Errorf("native worker motion: %w", err)
	}
	rotations, err := session.readF32(frames * joints * 4)
	if err != nil {
		return nil, nil, fmt.Errorf("native worker motion: %w", err)
	}
	return roots, rotations, nil
}

// The next count float32 values off the worker's stdout.
func (session *generatorSession) readF32(count int) ([]float32, error) {
	b := make([]byte, count*4)
	if _, err := io.ReadFull(session.stdout, b); err != nil {
		return nil, err
	}
	values := make([]float32, count)
	for i := range values {
		values[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return values, nil
}

func token() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func safePathPart(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}
	for _, r := range value {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

func readF32File(path string) ([]float32, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(b)%4 != 0 {
		return nil, fmt.Errorf("invalid F32 file: %s", path)
	}
	values := make([]float32, len(b)/4)
	for i := range values {
		values[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return values, nil
}

func writeF32File(path string, values []float32) error {
	return os.WriteFile(path, appendF32(make([]byte, 0, len(values)*4), values), 0600)
}

// With -output, an animation persists as <id>.json beside an <id>/ folder
// holding root_positions.f32, local_rotations_xyzw.f32 and animation.glb
// once it is ready -- the layout every earlier gallery used, so an existing
// demo-output reloads.  Without -output this is a no-op.  Called with the
// lock held.
// A copy of every record and stream under <output>/.backup/<date>, made once per day
// (on load, then on the first save of a new day). Backups are never pruned here.
var lastBackupDay string

func (g *gallery) backup() {
	if g.output == "" {
		return
	}
	day := time.Now().Format("2006-01-02")
	if day == lastBackupDay {
		return
	}
	lastBackupDay = day
	g.purgeDeleted()
	dst := filepath.Join(g.output, ".backup", day)
	if _, err := os.Stat(dst); err == nil {
		return
	}
	entries, err := os.ReadDir(g.output)
	if err != nil {
		return
	}
	if err := os.MkdirAll(dst, 0755); err != nil {
		return
	}
	copyFile := func(from, to string) {
		b, err := os.ReadFile(from)
		if err == nil {
			_ = os.WriteFile(to, b, 0644)
		}
	}
	n := 0
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		from := filepath.Join(g.output, name)
		if e.IsDir() {
			sub, _ := os.ReadDir(from)
			_ = os.MkdirAll(filepath.Join(dst, name), 0755)
			for _, f := range sub {
				if !f.IsDir() {
					copyFile(filepath.Join(from, f.Name()), filepath.Join(dst, name, f.Name()))
				}
			}
			n++
		} else if strings.HasSuffix(name, ".json") {
			copyFile(from, filepath.Join(dst, name))
		}
	}
	log.Printf("gallery: backup of %d clip folder(s) in %s", n, dst)
}

func (g *gallery) save(a *animation) error {
	if g.output == "" {
		return nil
	}
	g.backup()
	b, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(g.output, a.ID+".json"), b, 0644); err != nil {
		return err
	}
	if a.Status != "ready" || a.glb == nil {
		return nil
	}
	dir := filepath.Join(g.output, a.ID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	if err := writeF32File(filepath.Join(dir, "root_positions.f32"), a.roots); err != nil {
		return err
	}
	if err := writeF32File(filepath.Join(dir, "local_rotations_xyzw.f32"), a.rotations); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "animation.glb"), a.glb, 0600)
}

func (g *gallery) saveLogged(a *animation) {
	if err := g.save(a); err != nil {
		log.Printf("save %s: %v", a.ID, err)
	}
}

// Reload a persisted gallery: every <id>.json, the ready ones with their
// streams read back and their GLB rebuilt in memory (and written when the
// file is missing).  A ready record whose streams are gone is skipped; one
// the server stopped in the middle of is failed.
func (g *gallery) load() {
	entries, _ := filepath.Glob(filepath.Join(g.output, "*.json"))
	for _, path := range entries {
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var a animation
		if json.Unmarshal(b, &a) != nil || a.ID == "" {
			continue
		}
		if a.TextQuantization == "" {
			a.TextQuantization = "bf16"
		}
		if a.Status == "queued" || a.Status == "running" {
			a.Status = "failed"
			a.Error = "the server stopped before this animation was generated"
		}
		if a.Status == "ready" {
			dir := filepath.Join(g.output, a.ID)
			roots, err := readF32File(filepath.Join(dir, "root_positions.f32"))
			if err != nil {
				log.Printf("skip %s: %v", a.ID, err)
				continue
			}
			rotations, err := readF32File(filepath.Join(dir, "local_rotations_xyzw.f32"))
			if err != nil {
				log.Printf("skip %s: %v", a.ID, err)
				continue
			}
			model, ok := g.models[a.Model]
			if !ok {
				model = g.models["smplx-rp-v1"]
			}
			glb, err := buildMotionGLB(roots, rotations, model.SkeletonKey)
			if err != nil {
				log.Printf("skip %s: %v", a.ID, err)
				continue
			}
			a.roots, a.rotations, a.glb = roots, rotations, glb
			if a.Metrics == nil || a.Metrics.Version != metricsVersion {
				a.Metrics = withActionClip(computeMetrics(roots, rotations, skeletonDefinitions[model.SkeletonKey], a.Props...), &a, roots, rotations, skeletonDefinitions[model.SkeletonKey])
				if b, err := json.MarshalIndent(&a, "", "  "); err == nil {
					_ = os.WriteFile(path, b, 0644)
				}
			}
			glbPath := filepath.Join(dir, "animation.glb")
			if _, statErr := os.Stat(glbPath); statErr != nil {
				if err := os.WriteFile(glbPath, glb, 0600); err != nil {
					log.Printf("export %s: %v", a.ID, err)
				}
			}
		}
		g.items[a.ID] = &a
	}
	log.Printf("gallery: %d animation(s) reloaded from %s", len(g.items), g.output)
	g.backup()
}

// Without -output the gallery lives in memory.  Called with the lock held:
// the most recent galleryKeep finished animations stay, older ones go.
func (g *gallery) trim() {
	finished := make([]*animation, 0, len(g.items))
	for _, item := range g.items {
		if item.Status == "ready" || item.Status == "failed" {
			finished = append(finished, item)
		}
	}
	if len(finished) <= galleryKeep {
		return
	}
	sort.Slice(finished, func(i, j int) bool { return finished[i].CreatedAt > finished[j].CreatedAt })
	for _, item := range finished[galleryKeep:] {
		delete(g.items, item.ID)
	}
}

func (g *gallery) list() []*animation {
	g.mu.RLock()
	defer g.mu.RUnlock()
	result := make([]*animation, 0, len(g.items))
	for _, item := range g.items {
		copy := *item
		result = append(result, &copy)
	}
	// Newest first; ties (clips made in the same second, e.g. takes) by id, so
	// the order never flips between polls.
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt != result[j].CreatedAt {
			return result[i].CreatedAt > result[j].CreatedAt
		}
		return result[i].ID < result[j].ID
	})
	return result
}

// Each motion is exported as a node-only GLB: it deliberately has no mesh or
// skin, so consumers can attach their own Three.js geometry to the named
// joints. Kimodo stores root translations and local XYZW rotations.
var smplx22Parents = [...]int{-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19}
var smplx22Names = [...]string{"pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee", "spine2", "left_ankle", "right_ankle", "spine3", "left_foot", "right_foot", "neck", "left_collar", "right_collar", "head", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist"}
var smplx22Offsets = [...][3]float32{{}, {.052299, -.093936, -.027607}, {-.057193, -.106548, -.022218}, {-.001496, .11293, -.024981}, {.058867, -.416442, -.006557}, {-.048074, -.39756, -.014061}, {.0069, .145636, -.006859}, {-.041738, -.437584, -.029512}, {.014489, -.446853, -.01803}, {-.010334, .056082, .021116}, {.049294, -.065279, .126259}, {-.040575, -.065287, .127076}, {-.011026, .171365, -.028827}, {.047725, .087643, -.008375}, {-.046636, .086612, -.014864}, {.024654, .175391, .024463}, {.126285, .05768, -.013885}, {-.109342, .053674, -.009118}, {.272907, -.069853, -.039094}, {-.292029, -.03544, -.024565}, {.276174, .021254, -.002478}, {-.271878, -.004835, -.016445}}

type skeletonDefinition struct {
	key     string
	names   []string
	parents []int
	offsets [][3]float32
}

var skeletonDefinitions = map[string]skeletonDefinition{
	"smplx22": {key: "smplx22", names: smplx22Names[:], parents: smplx22Parents[:], offsets: smplx22Offsets[:]},
}

type gltfBufferView struct {
	Buffer     int `json:"buffer"`
	ByteOffset int `json:"byteOffset,omitempty"`
	ByteLength int `json:"byteLength"`
}
type gltfAccessor struct {
	BufferView    int    `json:"bufferView"`
	ComponentType int    `json:"componentType"`
	Count         int    `json:"count"`
	Type          string `json:"type"`
}

func appendF32(dst []byte, values []float32) []byte {
	for _, value := range values {
		var b [4]byte
		binary.LittleEndian.PutUint32(b[:], math.Float32bits(value))
		dst = append(dst, b[:]...)
	}
	return dst
}

func buildSkeletonGLB(roots, rotations []float32, skeleton skeletonDefinition) ([]byte, error) {
	frames := len(roots) / 3
	joints := len(skeleton.parents)
	if frames < 1 || joints < 1 || len(skeleton.names) != joints || len(skeleton.offsets) != joints || len(roots) != frames*3 || len(rotations) != frames*joints*4 {
		return nil, fmt.Errorf("invalid %s motion for GLB export", skeleton.key)
	}
	times := make([]float32, frames)
	for i := range times {
		times[i] = float32(i) / 30
	}
	bin := make([]byte, 0, (frames+frames*3+frames*22*4)*4)
	views := make([]gltfBufferView, 0, 24)
	addView := func(values []float32) int {
		offset := len(bin)
		bin = appendF32(bin, values)
		views = append(views, gltfBufferView{Buffer: 0, ByteOffset: offset, ByteLength: len(bin) - offset})
		return len(views) - 1
	}
	timeView, rootView := addView(times), addView(roots)
	rotationViews := make([]int, joints)
	for joint := range rotationViews {
		track := make([]float32, frames*4)
		for frame := 0; frame < frames; frame++ {
			copy(track[frame*4:], rotations[(frame*joints+joint)*4:(frame*joints+joint+1)*4])
		}
		rotationViews[joint] = addView(track)
	}
	accessors := []gltfAccessor{{BufferView: timeView, ComponentType: 5126, Count: frames, Type: "SCALAR"}, {BufferView: rootView, ComponentType: 5126, Count: frames, Type: "VEC3"}}
	for _, view := range rotationViews {
		accessors = append(accessors, gltfAccessor{BufferView: view, ComponentType: 5126, Count: frames, Type: "VEC4"})
	}
	nodes := make([]map[string]any, joints)
	for joint := range nodes {
		node := map[string]any{"name": skeleton.names[joint]}
		if joint != 0 {
			node["translation"] = skeleton.offsets[joint]
		}
		children := make([]int, 0, 3)
		for child, parent := range skeleton.parents {
			if parent == joint {
				children = append(children, child)
			}
		}
		if len(children) != 0 {
			node["children"] = children
		}
		nodes[joint] = node
	}
	samplers := make([]map[string]any, 0, 23)
	channels := make([]map[string]any, 0, 23)
	addChannel := func(node, output int, path string) {
		samplers = append(samplers, map[string]any{"input": 0, "output": output, "interpolation": "LINEAR"})
		channels = append(channels, map[string]any{"sampler": len(samplers) - 1, "target": map[string]any{"node": node, "path": path}})
	}
	addChannel(0, 1, "translation")
	for joint := 0; joint < joints; joint++ {
		addChannel(joint, joint+2, "rotation")
	}
	document := map[string]any{
		"asset":       map[string]string{"version": "2.0", "generator": "kimodo.cpp skeleton exporter"},
		"scene":       0,
		"scenes":      []map[string]any{{"nodes": []int{0}}},
		"nodes":       nodes,
		"buffers":     []map[string]int{{"byteLength": len(bin)}},
		"bufferViews": views,
		"accessors":   accessors,
		"animations":  []map[string]any{{"name": "KimodoMotion", "samplers": samplers, "channels": channels}},
		"extras":      map[string]any{"skeleton": skeleton.key, "fps": 30, "rotation_order": "xyzw"},
	}
	jsonChunk, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	for len(jsonChunk)%4 != 0 {
		jsonChunk = append(jsonChunk, ' ')
	}
	for len(bin)%4 != 0 {
		bin = append(bin, 0)
	}
	total := 12 + 8 + len(jsonChunk) + 8 + len(bin)
	out := make([]byte, 0, total)
	putU32 := func(value uint32) {
		var b [4]byte
		binary.LittleEndian.PutUint32(b[:], value)
		out = append(out, b[:]...)
	}
	putU32(0x46546c67)
	putU32(2)
	putU32(uint32(total))
	putU32(uint32(len(jsonChunk)))
	putU32(0x4e4f534a)
	out = append(out, jsonChunk...)
	putU32(uint32(len(bin)))
	putU32(0x004e4942)
	out = append(out, bin...)
	return out, nil
}

func buildMotionGLB(roots, rotations []float32, skeletonKey string) ([]byte, error) {
	skeleton, ok := skeletonDefinitions[skeletonKey]
	if !ok {
		return nil, fmt.Errorf("unsupported skeleton %q", skeletonKey)
	}
	return buildSkeletonGLB(roots, rotations, skeleton)
}

// produce runs one generation of item (model, then the clean-up passes, then the finish-settled trim) and its
// metrics. It sets the item's pass counters, trim and frames as it goes; the worker may call it again for a retry.
// clean=false leaves Clean up out (the retry loop judges raw takes, then cleans only the one it keeps).
func (g *gallery) produce(item *animation, session **generatorSession, clean bool) (roots, rotations []float32, glb []byte, metrics *clipMetrics, err error) {
	model, ok := g.models[item.Model]
	if !ok || !model.Available {
		err = fmt.Errorf("model %q is not available", item.Model)
	} else {
		textID := item.TextQuantization
		if textID == "" {
			textID = "q8_0"
		}
		text, textOK := g.textBundles[textID]
		if !textOK || !text.Available {
			err = fmt.Errorf("text quantization %q is not available", textID)
		}
		item.reachFrom, item.reachDX, item.reachDZ = 0, 0, 0
		if err == nil {
			segments := item.Segments
			if len(segments) == 0 {
				segments = []promptSegment{{Prompt: item.Prompt, Frames: item.Frames}}
			}
			g.mu.Lock()
			if !strings.HasPrefix(item.Progress, "The take missed") {
				item.Progress = fmt.Sprintf("Generating %d conditioned segments", len(segments))
			}
			g.mu.Unlock()
			key := model.Motion + "\x00" + text.Path
			if *session == nil || (*session).key != key {
				(*session).close()
				*session, err = startGeneratorSession(g.generator, model, text)
			}
			if err == nil {
				gen, lead := generationSegments(item, segments, false)
				item.leadFrames = lead
				t := time.Now()
				roots, rotations, err = (*session).generate(item, gen)
				log.Printf("%s: generate %.1f s (%d segments)", item.ID, time.Since(t).Seconds(), len(gen))
				if err == nil && item.FinishSettled {
					// the take ends mid-motion: ask again with the settle segment (same seed), so it comes to rest
					sk := skeletonDefinitions[model.SkeletonKey]
					pos := forwardKinematics(roots, rotations, sk)
					_, end := endSpeeds(pos, sk)
					// a punch or kick that ends frozen in a raised guard is still but not settled: a game cannot blend from it (the
					// judges took 1-2 points off every combat take for it). Asked again, with words that lower the hands.
					guardEnd := end <= unsettledEnd && combatEnd(promptTotalText(segments)) && handsUpAtEnd(pos, sk)
					if end > unsettledEnd || guardEnd {
						if guardEnd {
							item.settleText = guardSettlePrompt
						}
						gen, _ = generationSegments(item, segments, true) // the prompt as given: the same split and lead
						item.settleText = ""
						// and a place to stop (settle.go stopPose): the standing pose a stopping distance ahead
						keepField := item.constraintField
						total := 0
						for _, s := range gen {
							total += s.Frames
						}
						if stop, ok := g.stopPose(model.SkeletonKey, roots, rotations, sk, end, total); ok && !guardEnd {
							if parsed, perr := parseConstraints(append(append([]motionConstraint(nil), item.Constraints...), stop), model.SkeletonKey, len(model.JointNames), total); perr == nil {
								item.constraintField = encodeConstraints(len(model.JointNames), parsed)
							} else {
								log.Printf("%s: stop pose: %v", item.ID, perr)
							}
						}
						t = time.Now()
						roots, rotations, err = (*session).generate(item, gen)
						item.constraintField = keepField
						log.Printf("%s: ended mid-motion (%.2f m/s, guard %v): generate with settle %.1f s", item.ID, end, guardEnd, time.Since(t).Seconds())
					}
				}
				if err != nil {
					(*session).close()
					*session = nil
				}
			}
		}
		if err == nil && item.Preroll > 0 && item.leadFrames == item.Preroll {
			// the pre-roll is cut off: the clip starts where the movement is already in character
			sk := skeletonDefinitions[model.SkeletonKey]
			if total := len(roots) / 3; total > item.Preroll+minSegmentFrames/2 {
				roots, rotations = trimStreams(roots, rotations, len(sk.parents), item.Preroll, total-1)
				item.leadFrames = 0
			}
		}
		if err == nil && item.CleanWrists {
			rotations = wristCleanStreams(rotations, skeletonDefinitions[model.SkeletonKey])
		}
		if err == nil && item.SmoothJitter {
			var fixes int
			roots, rotations, fixes = smoothJitterStreams(roots, rotations, skeletonDefinitions[model.SkeletonKey])
			item.JitterFixes = fixes
		}
		if err == nil && item.CleanHands {
			var fixes int
			roots, rotations, fixes = cleanHandsStreams(roots, rotations, skeletonDefinitions[model.SkeletonKey])
			item.HandFixes = fixes
		}
		if err == nil && item.GroundHands {
			var fixes int
			roots, rotations, fixes = groundHandsStreams(roots, rotations, skeletonDefinitions[model.SkeletonKey])
			item.GroundFixes = fixes
		}
		if err == nil && item.GroundFeet {
			var fixes int
			roots, fixes = groundRootStreams(roots, rotations, skeletonDefinitions[model.SkeletonKey])
			item.FloorFixes = fixes
		}
		if err == nil && item.FinishSettled {
			// trim the idle past a short hold; the start only when nothing pins the first frames (a keep or a pose)
			sk := skeletonDefinitions[model.SkeletonKey]
			generated := len(roots) / 3
			// the start is trimmed only when nothing pins the first frames beyond the standing start (a keep or a pose)
			onlyStart := true
			for _, c := range item.Constraints {
				for _, f := range c.FrameIndices {
					if f >= 4 {
						onlyStart = false
					}
				}
			}
			from, to, ok := settleWindow(roots, rotations, sk, onlyStart, item.leadFrames+promptTotal(item.Segments, item.Frames), combatEnd(promptText(item)))
			if holdWords.MatchString(promptText(item)) {
				// an idle or a hold IS standing still: never trimmed as padding (an idle asked for 4 s came out 1.1 s); only the
				// hidden lead and anything past the asked length are cut
				from, to = item.leadFrames, min(generated-1, item.leadFrames+promptTotal(item.Segments, item.Frames)-1)
				ok = to-from+1 >= minTrimmed && (from > 0 || to < generated-1)
			}
			// never trim off a pinned frame: a clip pinned to a shelf at frame 116 was cut to 85 frames, the touch with it
			if last := lastPinnedFrame(item.Constraints); ok && last >= 0 && to < last+reachHold+reachEase {
				to = min(generated-1, last+reachHold+reachEase)
				ok = from > 0 || to < generated-1
			}
			if ok {
				item.reachFrom, item.reachDX, item.reachDZ = from, roots[from*3], roots[from*3+2]
				roots, rotations = trimStreams(roots, rotations, len(sk.parents), from, to)
				if hasReach(item.Constraints) {
					// a clip with a Point keeps the stage's frame: the point is where the user put it, not relative to the start
					roots = shiftXZ(roots, item.reachDX, item.reachDZ)
					item.reachDX, item.reachDZ = 0, 0
				}
				g.mu.Lock()
				item.TrimFrom, item.TrimmedFrames = from, generated-(to-from+1)
				item.Frames = to - from + 1
				item.Segments = trimSegments(item.Segments, from-item.leadFrames, item.Frames)
				g.mu.Unlock()
			} else {
				g.mu.Lock()
				item.Frames = generated
				item.Segments = trimSegments(item.Segments, -item.leadFrames, generated)
				g.mu.Unlock()
			}
		}
		if err == nil && item.CleanUp && clean {
			t := time.Now()
			// the last clean-up pass: a failure here keeps the clip as the passes above left it
			if r2, q2, _, cerr := cleanupStreams(roots, rotations, skeletonDefinitions[model.SkeletonKey], 0.95, item.Props...); cerr == nil {
				roots, rotations = r2, q2
				log.Printf("%s: clean-up %.1f s", item.ID, time.Since(t).Seconds())
			} else {
				item.CleanUpError = cerr.Error()
				log.Printf("clean-up skipped for %s: %v", item.ID, cerr)
			}
		}
		if err == nil {
			// hands pinned to a point land on it (Point mode): after every clean-up, so nothing moves them off again
			roots, rotations, _ = reachStreams(roots, rotations, skeletonDefinitions[model.SkeletonKey], item.Constraints, item.reachFrom, item.reachDX, item.reachDZ)
		}
		if err == nil {
			glb, err = buildMotionGLB(roots, rotations, model.SkeletonKey)
		}
	}
	if err == nil {
		metrics = withActionClip(computeMetrics(roots, rotations, skeletonDefinitions[model.SkeletonKey], item.Props...), item, roots, rotations, skeletonDefinitions[model.SkeletonKey])
	}
	return
}

func (g *gallery) worker() {
	var session *generatorSession
	defer func() { session.close() }()
	session = g.warmUp()
	for id := range g.queue {
		g.mu.Lock()
		item := g.items[id]
		item.Status = "running"
		g.saveLogged(item)
		g.mu.Unlock()
		// Takes that miss the move their prompt names (action.go) are generated again with another seed, up to
		// item.ActionRetries times; the best attempt is kept (fewest flags, the move done first).
		base := struct {
			seed        uint64
			frames      int
			segments    []promptSegment
			constraints []motionConstraint
			field       string
		}{item.Seed, item.Frames, append([]promptSegment(nil), item.Segments...), item.Constraints, item.constraintField}
		type attempt struct {
			roots, rotations []float32
			glb              []byte
			metrics          *clipMetrics
			err              error
			snap             animation
		}
		// a missed move outweighs everything; among takes that do the move, the most alive and least broken (choose.go)
		score := func(a attempt) float64 {
			if a.err != nil || a.metrics == nil {
				return 1 << 20
			}
			n := 0.0
			for _, f := range a.metrics.Flags {
				if f == "action" || f == "unsettled_end" {
					n += 100
				}
				if f == "pivot" { // a turn done by spinning on planted feet is a missed move too
					n += 50
				}
			}
			if a.snap.StartsMoving && containsFlag(a.metrics.Flags, "unsettled_start") {
				n -= 0.3 // a pre-rolled clip starts moving on purpose
			}
			return n + feelCost(a.roots, a.rotations, skeletonDefinitions[g.models[item.Model].SkeletonKey], promptText(&a.snap), a.metrics)
		}
		missed := func(a *attempt) bool {
			return a == nil || a.err != nil || a.metrics == nil || containsFlag(a.metrics.Flags, "action") || containsFlag(a.metrics.Flags, "pivot")
		}
		candidates := max(1, item.Candidates)
		firstMissed := false
		lastTry := max(item.ActionRetries, candidates-1)
		var best *attempt
		for try := 0; try <= lastTry; try++ {
			if try > 0 {
				g.mu.Lock()
				item.Seed = (base.seed + uint64(try)*1000003) & 0xFFFFFFFF
				item.Frames, item.Segments = base.frames, append([]promptSegment(nil), base.segments...)
				item.Constraints, item.constraintField = base.constraints, base.field // each version starts from the request's own pins
				item.TrimFrom, item.TrimmedFrames, item.CleanUpError = 0, 0, ""
				// a missed move: odd retries use the clearer wording, even ones the user's words with a new seed
				item.reword = missed(best) && try%2 == 1
				if missed(best) {
					item.Progress = fmt.Sprintf("The take missed the move; trying again (%d of %d)", try, lastTry)
				} else {
					item.Progress = fmt.Sprintf("Making other versions to keep the best (%d of %d)", try+1, candidates)
				}
				g.saveLogged(item)
				g.mu.Unlock()
			}
			// a take that began already down (a kneel or crouch with no way down) is tried again from a standing pose: no
			// pin by default (it kept starts generic), the pin only where the move needs a standing start
			if try > 0 && best != nil && best.metrics != nil && item.Preroll == 0 {
				startsDown := false
				for _, n := range best.metrics.ActionNotes {
					if strings.Contains(n, "starts already") {
						startsDown = true
					}
				}
				if model, ok := g.models[item.Model]; ok && startsDown {
					if c, ok := g.standingStart(model.SkeletonKey, promptText(item), item.Constraints); ok {
						cons := append([]motionConstraint{c}, item.Constraints...)
						if parsed, perr := parseConstraints(cons, model.SkeletonKey, len(model.JointNames), promptTotal(item.Segments, item.Frames)); perr == nil {
							g.mu.Lock()
							item.Constraints, item.constraintField = cons, encodeConstraints(len(model.JointNames), parsed)
							g.mu.Unlock()
							log.Printf("%s: began already down; retry %d from a standing pose", item.ID, try)
						}
					}
				}
			}
			r, q, gl, m, e := g.produce(item, &session, false)
			a := attempt{r, q, gl, m, e, *item}
			if try == 0 {
				firstMissed = missed(&a)
			}
			if best == nil || score(a) < score(*best) {
				best = &a
			}
			if e != nil {
				break
			}
			// enough versions made and the best does the move: stop. A missed move is tried again with clearer words, up
			// to item.ActionRetries; so is a turn done by spinning on planted feet (gait.go pivot)
			if try+1 >= candidates && !missed(best) {
				break
			}
			if try >= item.ActionRetries && try+1 >= candidates {
				break
			}
		}
		g.mu.Lock()
		// the kept attempt's settings (seed, trim, pass counters) go back on the clip
		item.Seed, item.Frames, item.Segments, item.TrimFrom, item.TrimmedFrames = best.snap.Seed, best.snap.Frames, best.snap.Segments, best.snap.TrimFrom, best.snap.TrimmedFrames
		item.Constraints, item.constraintField = best.snap.Constraints, best.snap.constraintField // the kept version's pins (a standing start only if it used one)
		item.CleanUpError, item.JitterFixes, item.HandFixes, item.GroundFixes, item.FloorFixes = best.snap.CleanUpError, best.snap.JitterFixes, best.snap.HandFixes, best.snap.GroundFixes, best.snap.FloorFixes
		item.RetryWording = ""
		if best.snap.reword {
			for _, seg := range best.snap.Segments {
				if w := retryWording(seg.Prompt); w != "" {
					item.RetryWording = w
				}
			}
		}
		item.reword = false
		item.ActionTries = 0
		if item.ActionRetries > 0 && best.snap.Seed != base.seed && firstMissed { // "try N; the first missed the move"
			item.ActionTries = int((best.snap.Seed-base.seed)&0xFFFFFFFF) / 1000003
		}
		// every take missed: the clip is shown as the best of them, with an honest verdict instead of a clean look
		item.Verdict = ""
		if best.metrics != nil && containsFlag(best.metrics.Flags, "action") {
			tries := 1
			if item.ActionRetries > 0 {
				tries = item.ActionRetries + 1
			}
			item.Verdict = fmt.Sprintf("Kimodo did not do this move in %d take%s: %s", tries, map[bool]string{true: "s", false: ""}[tries > 1], strings.Join(best.metrics.ActionNotes, "; "))
		}
		g.mu.Unlock()
		roots, rotations, glb, metrics, err := best.roots, best.rotations, best.glb, best.metrics, best.err
		// Clean up once, on the take that was kept
		if err == nil && item.CleanUp {
			sk := skeletonDefinitions[g.models[item.Model].SkeletonKey]
			t := time.Now()
			// in-place moves keep their planted toes still (cleanup.go inPlaceMove)
			if r2, q2, _, cerr := cleanupStreamsWith(roots, rotations, sk, 0.95, cleanupOptions{holdFeet: inPlaceMove(promptText(item)), loose: looseArms(promptText(item))}, item.Props...); cerr == nil {
				m2 := withActionClip(computeMetrics(r2, q2, sk, item.Props...), item, r2, q2, sk)
				// do no harm: Clean up's result is kept only when it is no worse than the take it started from
				if before, after := flagSeverity(metrics), flagSeverity(m2); after <= before {
					roots, rotations, metrics = r2, q2, m2
					if gl, gerr := buildMotionGLB(roots, rotations, sk.key); gerr == nil {
						glb = gl
					}
					log.Printf("%s: clean-up %.1f s (problems %d -> %d)", item.ID, time.Since(t).Seconds(), before, after)
				} else {
					g.mu.Lock()
					item.CleanUpError = fmt.Sprintf("skipped: Clean up made this take worse (%s -> %s)", strings.Join(metrics.Flags, ", "), strings.Join(m2.Flags, ", "))
					g.mu.Unlock()
					log.Printf("%s: clean-up %.1f s REJECTED (problems %d -> %d: %v -> %v)", item.ID, time.Since(t).Seconds(), before, after, metrics.Flags, m2.Flags)
				}
			} else {
				g.mu.Lock()
				item.CleanUpError = cerr.Error()
				g.mu.Unlock()
				log.Printf("clean-up skipped for %s: %v", item.ID, cerr)
			}
		}
		// that Clean up can move a hand off its point again: Point pins land once more, on the kept take
		if err == nil && item.CleanUp {
			sk := skeletonDefinitions[g.models[item.Model].SkeletonKey]
			if r2, q2, n := reachStreams(roots, rotations, sk, best.snap.Constraints, best.snap.reachFrom, best.snap.reachDX, best.snap.reachDZ); n > 0 {
				roots, rotations = r2, q2
				metrics = withActionClip(computeMetrics(roots, rotations, sk, item.Props...), item, roots, rotations, sk)
				if gl, gerr := buildMotionGLB(roots, rotations, sk.key); gerr == nil {
					glb = gl
				}
			}
		}
		// a foot still gliding (gait.go slide): the glide over that stretch lifted into a step, kept only when the clip
		// scores better (Kimodo slid the feet in low-energy stretches: the stop of a walk, a stagger, 8-28 cm)
		if err == nil && metrics != nil && containsFlag(metrics.Flags, "slide") {
			sk := skeletonDefinitions[g.models[item.Model].SkeletonKey]
			win := [2]int{max(0, metrics.SlideFrom-4), metrics.SlideTo + 4}
			if r2, q2, _, lerr := cleanupStreamsWith(roots, rotations, sk, 0.95, cleanupOptions{liftOnly: win}); lerr == nil {
				m2 := withActionClip(computeMetrics(r2, q2, sk, item.Props...), item, r2, q2, sk)
				score := func(m *clipMetrics) float64 { return float64(flagSeverity(m)) + m.SlideM*100 }
				if score(m2) < score(metrics) && flagSeverity(m2) <= flagSeverity(metrics) {
					log.Printf("%s: slide %d cm lifted into a step (%v -> %v)", item.ID, int(metrics.SlideM*100), metrics.Flags, m2.Flags)
					roots, rotations, metrics = r2, q2, m2
					if gl, gerr := buildMotionGLB(roots, rotations, sk.key); gerr == nil {
						glb = gl
					}
				} else {
					log.Printf("%s: slide lift not kept (%v -> %v)", item.ID, metrics.Flags, m2.Flags)
				}
			} else {
				log.Printf("%s: slide lift failed: %v", item.ID, lerr)
			}
		}
		g.mu.Lock()
		if err != nil {
			item.Status = "failed"
			item.Error = err.Error()
		} else {
			item.roots, item.rotations, item.glb = roots, rotations, glb
			item.Metrics = metrics
			item.Status = "ready"
			item.Progress = ""
		}
		g.saveLogged(item)
		if g.output == "" {
			g.trim()
		}
		g.mu.Unlock()
	}
}

func main() {
	preferPacked := func(packed, legacy string) string {
		if info, err := os.Stat(packed); err == nil && info.Mode().IsRegular() {
			return packed
		}
		return legacy
	}
	addr := flag.String("addr", "127.0.0.1:8090", "listen address")
	motion := flag.String("motion-model", "models/kimodo-smplx-rp-v1-f32.gguf", "motion GGUF")
	somaRP := flag.String("soma-rp-model", "models/kimodo-soma-rp-v1.1-f32.gguf", "SOMA RP v1.1 motion GGUF")
	somaRP12 := flag.String("soma-rp-v12-model", "models/kimodo-soma-rp-v1.2-f32.gguf", "SOMA RP v1.2 motion GGUF")
	somaSEED := flag.String("soma-seed-model", "models/kimodo-soma-seed-v1.1-f32.gguf", "SOMA SEED v1.1 motion GGUF")
	g1RP := flag.String("g1-rp-model", "models/kimodo-g1-rp-v1-f32.gguf", "G1 RP v1 motion GGUF")
	g1SEED := flag.String("g1-seed-model", "models/kimodo-g1-seed-v1-f32.gguf", "G1 SEED v1 motion GGUF")
	text := flag.String("text-bundle", preferPacked("Llama-3-Kimodo-BF16.gguf", "generated/llm2vec-text-bundle"), "BF16 LLM2Vec GGUF or legacy component directory")
	textQ8 := flag.String("text-q8-bundle", preferPacked("Llama-3-Kimodo-Q8_0.gguf", "generated/llm2vec-text-q8_0"), "Q8_0 LLM2Vec GGUF or legacy component directory")
	textQ6 := flag.String("text-q6-bundle", preferPacked("Llama-3-Kimodo-Q6_K.gguf", "generated/llm2vec-text-q6_k"), "Q6_K LLM2Vec GGUF or legacy component directory")
	textQ5 := flag.String("text-q5-bundle", preferPacked("Llama-3-Kimodo-Q5_K.gguf", "generated/llm2vec-text-q5_k"), "Q5_K LLM2Vec GGUF or legacy component directory")
	textQ4 := flag.String("text-q4-bundle", preferPacked("Llama-3-Kimodo-Q4_K.gguf", "generated/llm2vec-text-q4_k"), "Q4_K LLM2Vec GGUF or legacy component directory")
	textQ4Mixed := flag.String("text-q4-mixed-bundle", preferPacked("Llama-3-Kimodo-Q4_K_M.gguf", "generated/llm2vec-text-q4_k_m"), "mixed Q4_K LLM2Vec GGUF or legacy component directory")
	generator := flag.String("generator", "kimodo.cpp/build/release/kmd-generate", "native text-to-motion command")
	output := flag.String("output", "", "gallery directory: when set, animations persist there (records, raw streams and GLBs) and reload at startup; empty keeps them in memory only")
	comparisons := flag.String("comparisons", "quantization-comparisons", "viewer-ready quantization comparison directories")
	staticDir := flag.String("static", "", "serve the page from this directory instead of the embedded copy (development)")
	cleanupFlag := flag.String("cleanup", cleanupDir, "physics + anti-clipping tool folder (cleanup.py and its .venv)")
	mbFlag := flag.String("motionbricks", mbDir, "MotionBricks worker folder (mb_serve.py)")
	mbPythonFlag := flag.String("motionbricks-python", mbPython, "python with onnxruntime + scipy + usd-core for MotionBricks")
	gemxDir := flag.String("gemx", "", "NVIDIA GEM-X checkout for video tracking (weights, SOMA assets, .venv-rocm or .venv); empty turns it off")
	flag.Parse()
	gemx.dir = *gemxDir
	cleanupDir = *cleanupFlag
	mbDir, mbPython = *mbFlag, *mbPythonFlag
	if *output != "" {
		if err := os.MkdirAll(*output, 0755); err != nil {
			log.Fatal(err)
		}
	}
	makeModel := func(id, label, skeletonLabel, skeletonKey, upstream, license, licenseURL, path string, commercial bool) motionModel {
		definition := skeletonDefinitions[skeletonKey]
		model := motionModel{ID: id, Label: label, Skeleton: skeletonLabel, SkeletonKey: skeletonKey, Upstream: upstream, License: license, LicenseURL: licenseURL, Commercial: commercial, MaxFrames: maxSegmentFrames, JointNames: definition.names, Parents: definition.parents, Offsets: definition.offsets, Motion: path}
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			model.Available = true
		} else {
			model.Reason = "GGUF not found at " + path
		}
		return model
	}
	const internalLicense = "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-internal-scientific-research-and-development-model-license/"
	const openLicense = "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/"
	models := map[string]motionModel{
		"smplx-rp-v1":    makeModel("smplx-rp-v1", "SMPL-X RP v1", "SMPL-X 22 joints", "smplx22", "nvidia/Kimodo-SMPLX-RP-v1", "NVIDIA Internal Scientific R&D (non-commercial)", internalLicense, *motion, false),
		"soma-rp-v1.1":   makeModel("soma-rp-v1.1", "SOMA RP v1.1", "SOMA compact 30-joint control skeleton", "soma30", "nvidia/Kimodo-SOMA-RP-v1.1", "NVIDIA Open Model License", openLicense, *somaRP, true),
		"soma-rp-v1.2":   makeModel("soma-rp-v1.2", "SOMA RP v1.2", "SOMA compact 30-joint control skeleton", "soma30", "nvidia/Kimodo-SOMA-RP-v1.2", "NVIDIA Open Model License", openLicense, *somaRP12, true),
		"soma-seed-v1.1": makeModel("soma-seed-v1.1", "SOMA SEED v1.1", "SOMA compact 30-joint control skeleton", "soma30", "nvidia/Kimodo-SOMA-SEED-v1.1", "NVIDIA Open Model License", openLicense, *somaSEED, true),
		"g1-rp-v1":       makeModel("g1-rp-v1", "G1 RP v1", "Unitree G1 34 joints", "g1skel34", "nvidia/Kimodo-G1-RP-v1", "NVIDIA Open Model License", openLicense, *g1RP, true),
		"g1-seed-v1":     makeModel("g1-seed-v1", "G1 SEED v1", "Unitree G1 34 joints", "g1skel34", "nvidia/Kimodo-G1-SEED-v1", "NVIDIA Open Model License", openLicense, *g1SEED, true),
	}
	makeTextBundle := func(id, label, description, path string) textBundle {
		bundle := textBundle{ID: id, Label: label, Description: description, Path: path}
		info, err := os.Stat(path)
		if err != nil {
			bundle.Reason = "bundle not found at " + path
			return bundle
		}
		components := []string{path}
		if info.IsDir() {
			components, err = filepath.Glob(filepath.Join(path, "*.gguf"))
			if err != nil || len(components) == 0 {
				bundle.Reason = "bundle contains no GGUF components"
				return bundle
			}
		} else if info.Mode().IsRegular() && filepath.Ext(path) == ".gguf" {
			tokenizer := filepath.Join(filepath.Dir(path), "tokenizer.gguf")
			if tokenizerInfo, statErr := os.Stat(tokenizer); statErr != nil || !tokenizerInfo.Mode().IsRegular() {
				bundle.Reason = "tokenizer.gguf not found beside " + path
				return bundle
			}
			components = append(components, tokenizer)
		} else {
			bundle.Reason = "text model is not a GGUF or component directory"
			return bundle
		}
		for _, component := range components {
			if componentInfo, statErr := os.Stat(component); statErr == nil {
				bundle.Bytes += componentInfo.Size()
			}
		}
		bundle.Available = true
		return bundle
	}
	textBundles := map[string]textBundle{
		"bf16":   makeTextBundle("bf16", "BF16 reference", "Highest-fidelity reference encoder.", *text),
		"q8_0":   makeTextBundle("q8_0", "Q8_0", "Recommended quantized encoder; closest measured agreement with BF16.", *textQ8),
		"q6_k":   makeTextBundle("q6_k", "Q6_K", "Smaller experimental encoder with increased motion divergence.", *textQ6),
		"q5_k":   makeTextBundle("q5_k", "Q5_K", "Experimental; some prompt/noise pairs enter a different trajectory basin.", *textQ5),
		"q4_k":   makeTextBundle("q4_k", "Q4_K", "Experimental uniform four-bit encoder with substantial measured divergence.", *textQ4),
		"q4_k_m": makeTextBundle("q4_k_m", "Q4_K mixed", "Experimental mixed-bit profile that improves on uniform Q4_K.", *textQ4Mixed),
	}
	g := &gallery{items: map[string]*animation{}, output: *output, queue: make(chan string, 32), generator: *generator, models: models, textBundles: textBundles}
	g.projects = loadProjects(*output)
	g.poses = loadPoses(*output)
	if g.output != "" {
		g.load()
	}
	go g.worker()
	var static fs.FS
	if *staticDir != "" {
		static = os.DirFS(*staticDir)
		log.Printf("serving the page from %s", *staticDir)
	} else {
		sub, err := fs.Sub(embeddedStatic, "static")
		if err != nil {
			log.Fatal(err)
		}
		static = sub
	}
	servePage := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			page, err := fs.ReadFile(static, name)
			if err != nil {
				http.Error(w, name+" is missing", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(page)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		servePage("index.html")(w, r)
	})
	mux.HandleFunc("/compare", servePage("compare.html"))
	staticFiles := http.StripPrefix("/static/", http.FileServer(http.FS(static)))
	mux.HandleFunc("/static/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		staticFiles.ServeHTTP(w, r)
	})
	mux.HandleFunc("/api/comparisons", func(w http.ResponseWriter, r *http.Request) {
		entries, _ := os.ReadDir(*comparisons)
		result := make([]json.RawMessage, 0, len(entries))
		for _, entry := range entries {
			if !entry.IsDir() || !safePathPart(entry.Name()) {
				continue
			}
			data, err := os.ReadFile(filepath.Join(*comparisons, entry.Name(), "comparison.json"))
			if err == nil && json.Valid(data) {
				result = append(result, data)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})
	mux.HandleFunc("/api/comparisons/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/comparisons/"), "/")
		if len(parts) < 2 || len(parts) > 3 || !safePathPart(parts[0]) {
			http.NotFound(w, r)
			return
		}
		var path string
		if len(parts) == 2 && parts[1] == "comparison.json" {
			path = filepath.Join(*comparisons, parts[0], "comparison.json")
			w.Header().Set("Content-Type", "application/json")
		} else if len(parts) == 3 && safePathPart(parts[1]) &&
			(parts[2] == "root_positions.f32" || parts[2] == "local_rotations_xyzw.f32") {
			path = filepath.Join(*comparisons, parts[0], parts[1], parts[2])
			w.Header().Set("Content-Type", "application/octet-stream")
		} else {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, path)
	})
	mux.HandleFunc("/api/animations", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(g.list())
	})
	mux.HandleFunc("/api/models", func(w http.ResponseWriter, r *http.Request) {
		result := make([]motionModel, 0, len(g.models))
		for _, model := range g.models {
			result = append(result, model)
		}
		sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})
	mux.HandleFunc("/api/text-quantizations", func(w http.ResponseWriter, r *http.Request) {
		order := []string{"bf16", "q8_0", "q6_k", "q5_k", "q4_k", "q4_k_m"}
		result := make([]textBundle, 0, len(order))
		for _, id := range order {
			result = append(result, g.textBundles[id])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})
	mux.HandleFunc("/api/generate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		var request struct {
			Prompt           string             `json:"prompt"`
			Segments         []promptSegment    `json:"segments"`
			TransitionFrames int                `json:"transition_frames"`
			Frames           int                `json:"frames"`
			Steps            int                `json:"steps"`
			Seed             uint64             `json:"seed"`
			Model            string             `json:"model"`
			TextQuantization string             `json:"text_quantization"`
			TextCFG          float64            `json:"text_cfg"`
			Constraints      []motionConstraint `json:"constraints"`
			ConstraintCFG    float64            `json:"constraint_cfg"`
			FirstHeading     float64            `json:"first_heading"`
			PostProcessing   *bool              `json:"post_processing"`
			RootMargin       *float64           `json:"root_margin"`
			Project          string             `json:"project"`
			Folder           string             `json:"folder"`
			Batch            string             `json:"batch"`
			Take             int                `json:"take"`
			Takes            int                `json:"takes"`
			Name             string             `json:"name"`
			Tags             []string           `json:"tags"`
			Lineage          json.RawMessage    `json:"lineage"`
			Actor            int                `json:"actor"`
			ActorPrompt      string             `json:"actor_prompt"`
			CleanWrists      bool               `json:"clean_wrists"`
			CleanHands       bool               `json:"clean_hands"`
			GroundHands      bool               `json:"ground_hands"`
			GroundFeet       bool               `json:"ground_feet"`
			SmoothJitter     bool               `json:"smooth_jitter"`
			CleanUp          bool               `json:"clean_up"`
			FinishSettled    bool               `json:"finish_settled"`
			ActionRetries    int                `json:"action_retries"`
			Candidates       *int               `json:"candidates"`     // versions of every take, best kept; default 3 with move retries on, else 1
			CalmLead         *bool              `json:"calm_lead"`      // a plain move starts from a short "stands still" lead in words (default on)
			StartStanding    *bool              `json:"start_standing"` // pin a neutral standing pose on the first frames (opt-in since 2026-10-29: blind start judges 4.0 vs 8.3 without; a kneel or crouch that begins down is retried by the move check)
		}
		// Room for dense keyframe constraints; a prompt alone is a few KiB.
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&request); err != nil {
			http.Error(w, "invalid JSON: "+err.Error(), 400)
			return
		}
		request.Prompt = strings.TrimSpace(request.Prompt)
		if len(request.Segments) == 0 {
			request.Segments = []promptSegment{{Prompt: request.Prompt, Frames: request.Frames}}
		}
		if len(request.Segments) > 16 {
			http.Error(w, "at most 16 prompt segments", 400)
			return
		}
		if request.Frames == 0 {
			request.Frames = 150
		}
		if request.Steps == 0 {
			request.Steps = 100
		}
		for index := range request.Segments {
			request.Segments[index].Prompt = strings.TrimSpace(request.Segments[index].Prompt)
			if request.Segments[index].Frames == 0 {
				request.Segments[index].Frames = 150
			}
			if request.Segments[index].Prompt == "" || len(request.Segments[index].Prompt) > 4096 || request.Segments[index].Frames < minSegmentFrames || request.Segments[index].Frames > maxSegmentFrames {
				http.Error(w, fmt.Sprintf("each prompt segment must be %d..%d frames and 1..4096 bytes", minSegmentFrames, maxSegmentFrames), 400)
				return
			}
		}
		if request.TransitionFrames == 0 {
			request.TransitionFrames = 5
		}
		if request.TransitionFrames < 1 || request.TransitionFrames > 60 || request.Steps < 1 || request.Steps > 1000 {
			http.Error(w, "transition frames must be 1..60 and steps 1..1000", 400)
			return
		}
		// Upstream's separated guidance weights, text and constraint, default 2.0.
		if request.TextCFG == 0 {
			request.TextCFG = 2
		}
		if request.ConstraintCFG == 0 {
			request.ConstraintCFG = 2
		}
		for _, weight := range []float64{request.TextCFG, request.ConstraintCFG} {
			if math.IsNaN(weight) || math.IsInf(weight, 0) || weight < 0 || weight > 20 {
				http.Error(w, "text_cfg and constraint_cfg must be in 0..20", 400)
				return
			}
		}
		if math.IsNaN(request.FirstHeading) || math.IsInf(request.FirstHeading, 0) || math.Abs(request.FirstHeading) > 1000 {
			http.Error(w, "first_heading must be a finite angle in radians", 400)
			return
		}
		if request.Model == "" {
			request.Model = g.defaultModelID()
		}
		if request.TextQuantization == "" {
			request.TextQuantization = "q8_0"
		}
		model, ok := g.models[request.Model]
		if !ok || !model.Available {
			http.Error(w, "selected motion model is not available: "+model.Reason, http.StatusConflict)
			return
		}
		// Start standing: the clip begins from a neutral standing pose unless the words say the person starts low or a
		// constraint already covers the first frames. Without it "crouches down and stands up" began crouched and
		// "kneels down" began kneeling (the down move never happened); pinned, the kneel-down appeared (2026-10-27).
		// a turn in place followed by more ("turns around and waves"): the turn as its own part, then the rest
		if (request.StartStanding == nil || *request.StartStanding) && len(request.Segments) == 1 && len(request.Constraints) == 0 {
			if turn, rest, ok := turnSplit(request.Segments[0].Prompt); ok {
				total := request.Segments[0].Frames
				request.Segments = []promptSegment{{Prompt: turn, Frames: minSegmentFrames}, {Prompt: rest, Frames: max(minSegmentFrames, total-minSegmentFrames)}}
				log.Printf("turn in place: split %q into %q + %q", turn+" "+rest, turn, rest)
			}
		}
		// a clip that leads with a continuous movement is pre-rolled (preroll.go) instead of pinned to a standing pose:
		// the pinned pose and the walk-start keys kept the first seconds neutral ("starts off wrong")
		prerollText := ""
		if len(request.Constraints) == 0 && request.Actor == 0 {
			if t, ok := prerollPrompt(request.Segments[0].Prompt); ok && needsPreroll(t) {
				prerollText = t
				log.Printf("pre-roll: %d frames of %q", prerollFrames, t)
			}
		}
		// a walk starts from standing with two planned first steps (turnplan.go walkStartConstraints)
		if prerollText == "" && (request.StartStanding != nil && *request.StartStanding) && len(request.Constraints) == 0 {
			if wc := g.walkStartConstraints(model.SkeletonKey, request.Segments[0].Prompt, request.Segments[0].Frames); wc != nil {
				request.Constraints = wc
				log.Printf("walk start: planned first steps for %q", request.Segments[0].Prompt)
			}
		}
		if prerollText == "" && (request.StartStanding != nil && *request.StartStanding) {
			if c, ok := g.standingStart(model.SkeletonKey, request.Segments[0].Prompt, request.Constraints); ok {
				request.Constraints = append([]motionConstraint{c}, request.Constraints...)
				// a turn in place gets a footstep plan on top (turnplan.go): the feet are held between steps
				if tc := g.turnInPlaceConstraints(model.SkeletonKey, request.Segments[0].Prompt, request.Segments[0].Frames, request.Constraints); tc != nil {
					request.Constraints = append(request.Constraints, tc...)
					log.Printf("turn in place: footstep plan for %q (%d foot constraints)", request.Segments[0].Prompt, len(tc))
				}
			}
		}
		if prerollText == "" {
			request.Constraints = g.reachStart(model.SkeletonKey, request.Segments[0].Prompt, request.Segments[0].Frames, request.Constraints)
		}
		text, ok := g.textBundles[request.TextQuantization]
		if !ok {
			http.Error(w, "unknown text quantization", http.StatusBadRequest)
			return
		}
		if !text.Available {
			http.Error(w, "selected text quantization is not available: "+text.Reason, http.StatusConflict)
			return
		}
		totalFrames := 0
		for _, segment := range request.Segments {
			totalFrames += segment.Frames
		}
		joints := len(model.JointNames)
		constraints, err := parseConstraints(request.Constraints, model.SkeletonKey, joints, totalFrames)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		// Upstream's demo post-processes by default, except on the G1 robot.
		postProcessing := model.SkeletonKey != "g1skel34"
		if request.PostProcessing != nil {
			postProcessing = *request.PostProcessing
		}
		rootMargin := defaultRootMargin
		if request.RootMargin != nil {
			rootMargin = *request.RootMargin
		}
		if math.IsNaN(rootMargin) || rootMargin < 0 || rootMargin > 1 {
			http.Error(w, "root_margin must be 0..1 metres", 400)
			return
		}
		a := &animation{ID: token(), Prompt: request.Segments[0].Prompt, Frames: totalFrames, DiffusionSteps: request.Steps, Seed: request.Seed, CreatedAt: time.Now().UTC().Format(time.RFC3339), Status: "queued", Kind: "generated", Model: request.Model, TextQuantization: request.TextQuantization, Segments: request.Segments, TransitionFrames: request.TransitionFrames, TextCFG: request.TextCFG,
			Constraints: request.Constraints, ConstraintCFG: request.ConstraintCFG, FirstHeading: request.FirstHeading, constraintField: encodeConstraints(joints, constraints),
			PostProcessing: postProcessing, RootMargin: rootMargin, Project: g.projects.valid(request.Project)}
		if request.Batch != "" && len(request.Batch) <= 32 && safePathPart(request.Batch) && request.Take >= 1 && request.Takes >= request.Take && request.Takes <= 64 {
			a.Batch, a.Take, a.Takes = request.Batch, request.Take, request.Takes
		}
		if n := strings.TrimSpace(request.Name); n != "" && len(n) <= 120 {
			a.Name = n
		}
		a.Tags = cleanTags(request.Tags)
		if len(request.Lineage) > 0 && len(request.Lineage) <= 8192 && json.Valid(request.Lineage) {
			a.Lineage = request.Lineage
			// A regeneration of an existing clip keeps that clip's name, markers, actor and hand track
			// unless the request names it itself.
			var lin struct {
				Parent string `json:"parent"`
			}
			if json.Unmarshal(request.Lineage, &lin) == nil && lin.Parent != "" {
				g.mu.RLock()
				parent := g.items[lin.Parent]
				g.mu.RUnlock()
				if parent != nil {
					if strings.TrimSpace(request.Name) == "" {
						base := strings.TrimSuffix(strings.TrimSpace(firstNonEmpty(parent.Name, truncate(parent.Prompt, 40))), " (regen)")
						a.Name = base + " (regen)"
					}
					if len(parent.Markers) > 0 {
						a.Markers = append([]clipMarker(nil), parent.Markers...)
					}
					if len(parent.HandTrack) > 0 {
						a.HandTrack = append([]handKey(nil), parent.HandTrack...)
					}
					if request.Actor == 0 && parent.Actor > 0 {
						a.Actor, a.ActorPrompt = parent.Actor, parent.ActorPrompt
					}
				}
			}
		}
		a.CleanWrists = request.CleanWrists
		a.CleanHands = request.CleanHands
		a.GroundHands = request.GroundHands
		a.GroundFeet = request.GroundFeet
		a.SmoothJitter = request.SmoothJitter
		a.CleanUp = request.CleanUp
		a.FinishSettled = request.FinishSettled && request.Actor == 0 // a scene's actors are timed by frame: never trimmed
		if prerollText != "" {
			a.Preroll, a.prerollText, a.StartsMoving = prerollFrames, prerollText, true
		}
		a.ActionRetries = max(0, min(request.ActionRetries, 5))
		a.noCalmLead = request.CalmLead != nil && !*request.CalmLead
		a.Candidates = 1
		if request.Candidates != nil {
			a.Candidates = max(1, min(*request.Candidates, 6))
		} else if a.ActionRetries > 0 {
			a.Candidates = 3
		}
		if request.Actor > 0 && request.Actor <= 64 {
			a.Actor = request.Actor
			if len(request.ActorPrompt) <= 4096 {
				a.ActorPrompt = strings.TrimSpace(request.ActorPrompt)
			}
		}
		if a.Project != "" {
			if folder, err := cleanFolder(request.Folder); err == nil && folder != "" {
				if _, err := g.projects.addFolder(a.Project, folder); err == nil {
					a.Folder = folder
				}
			}
		}
		g.mu.Lock()
		g.items[a.ID] = a
		err = g.save(a)
		g.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		g.queue <- a.ID
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(a)
	})
	registerLibraryRoutes(mux, g)
	mux.HandleFunc("/api/animations/hands/", func(w http.ResponseWriter, r *http.Request) {
		// GET /api/animations/hands/<id> → {"frames": N, "left": [...], "right": [...]} one shape per frame
		id := strings.TrimPrefix(r.URL.Path, "/api/animations/hands/")
		g.mu.RLock()
		a := g.items[id]
		var frames int
		var track []handKey
		if a != nil {
			frames, track = a.Frames, a.HandTrack
		}
		g.mu.RUnlock()
		if a == nil {
			http.NotFound(w, r)
			return
		}
		left, right := make([]string, frames), make([]string, frames)
		curL, curR := "auto", "auto"
		k := 0
		for f := 0; f < frames; f++ {
			for k < len(track) && track[k].Frame <= f {
				curL, curR = track[k].Left, track[k].Right
				k++
			}
			left[f], right[f] = curL, curR
		}
		writeJSON(w, 200, map[string]any{"frames": frames, "left": left, "right": right, "keys": track})
	})
	mux.HandleFunc("/api/jobs", handleJobs)
	g.registerGemx(mux)
	mux.HandleFunc("/api/animations/import", g.handleImport)
	mux.HandleFunc("/api/animations/blank", g.handleBlank)
	mux.HandleFunc("/api/animations/sequence", g.handleSequence)
	mux.HandleFunc("/api/jobs/", handleJobs)
	mux.HandleFunc("/api/prompts", loadInboxPrompts(*output).handle) // the Inbox's saved prompts (inboxprompts.go)
	mux.HandleFunc("/api/poses", g.handlePoses)
	// the body's surface per bone (bone frame), for the page's hard floor while posing with the Handles
	mux.HandleFunc("/api/body-proxy/", func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimPrefix(r.URL.Path, "/api/body-proxy/") != "soma30" {
			http.Error(w, "no body surface for this skeleton", 404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "max-age=3600")
		w.Write(soma30ProxyJSON)
	})
	mux.HandleFunc("/api/poses/", g.handlePoses)
	mux.HandleFunc("/api/animations/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/animations/"), "/")
		if len(parts) == 1 && parts[0] != "" {
			g.handleAnimation(w, r, parts[0])
			return
		}
		if len(parts) == 2 && parts[1] == "derive" {
			g.handleDerive(w, r, parts[0])
			return
		}
		if len(parts) == 2 && parts[1] == "pipeline" {
			g.handlePipeline(w, r, parts[0])
			return
		}
		if len(parts) == 2 && parts[1] == "animation.fbx" {
			g.handleFBX(w, r, parts[0])
			return
		}
		if len(parts) == 2 && parts[1] == "skinned.glb" {
			g.mu.RLock()
			a := g.items[parts[0]]
			var data []byte
			var stem string
			if a != nil && a.Status == "ready" {
				if model, ok := g.models[a.Model]; ok {
					data, _ = buildSkinnedGLB(a.roots, a.rotations, skeletonDefinitions[model.SkeletonKey])
					stem = a.fileStem()
				}
			}
			g.mu.RUnlock()
			if data == nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "model/gltf-binary")
			w.Header().Set("Content-Disposition", "attachment; filename="+stem+"-skinned.glb")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(data)
			return
		}
		if len(parts) == 2 && parts[1] == "thumb.png" {
			g.handleThumb(w, r, parts[0])
			return
		}
		if len(parts) == 2 && parts[1] == "sheet.png" {
			g.handleSheet(w, r, parts[0])
			return
		}
		if len(parts) == 2 && parts[1] == "pack" {
			g.handlePack(w, r, parts[0])
			return
		}
		if len(parts) == 2 && parts[1] == "animation.bvh" {
			g.mu.RLock()
			a := g.items[parts[0]]
			var bvh []byte
			var stem string
			if a != nil && a.Status == "ready" {
				if model, ok := g.models[a.Model]; ok {
					bvh = buildBVH(a.roots, a.rotations, skeletonDefinitions[model.SkeletonKey], 100)
					stem = a.fileStem()
				}
			}
			g.mu.RUnlock()
			if bvh == nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Disposition", "attachment; filename="+stem+".bvh")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(bvh)
			return
		}
		if len(parts) != 2 || (parts[1] != "root.f32" && parts[1] != "rotations.f32" && parts[1] != "animation.glb") {
			http.NotFound(w, r)
			return
		}
		g.mu.RLock()
		a := g.items[parts[0]]
		var data []byte
		if a != nil && a.Status == "ready" {
			switch parts[1] {
			case "root.f32":
				data = appendF32(make([]byte, 0, len(a.roots)*4), a.roots)
			case "rotations.f32":
				data = appendF32(make([]byte, 0, len(a.rotations)*4), a.rotations)
			default:
				data = a.glb
			}
		}
		g.mu.RUnlock()
		if data == nil {
			http.NotFound(w, r)
			return
		}
		if parts[1] == "animation.glb" {
			w.Header().Set("Content-Type", "model/gltf-binary")
			w.Header().Set("Content-Disposition", "attachment; filename="+a.fileStem()+".glb")
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		_, _ = w.Write(data)
	})
	// CORS: the ContraptionFabricator web build (a browser page on another
	// origin) talks to this server with fetch, and the JSON POST triggers a
	// preflight.  Everything here is a local demo, so every origin is welcome.
	cors := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})
	log.Printf("Understudy listening at http://%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, cors))
}

// standingStart: a full-body constraint holding the saved "standing" starter pose on frames 0-3, when nothing else
// pins those frames and the prompt does not start the person low (seated, lying, kneeling, crouched).
func (g *gallery) standingStart(skeletonKey, prompt string, existing []motionConstraint) (motionConstraint, bool) {
	for _, c := range existing {
		for _, f := range c.FrameIndices {
			if f < 4 {
				return motionConstraint{}, false
			}
		}
	}
	p := strings.ToLower(prompt)
	// a gait (walk, run, jog, sprint, strafe) starts mid-stride by nature: pinned standing, the first step dragged a
	// foot 12 cm; the gaits came out clean without the pin
	for _, w := range []string{"walk", "run", "jog", "sprint", "strafe", "march", "dash"} {
		if strings.HasPrefix(p, "a person "+w) || strings.HasPrefix(p, w) {
			return motionConstraint{}, false
		}
	}
	for _, w := range []string{"sitting", "seated", "sits on", "lying", "lies on", "lie on", "kneeling", "crouched", "crouching", "on the floor", "on the ground", "on all fours", "from a crouch", "in a crouch", "squatting"} {
		// the words name a starting state when they come before the first verb of motion; good enough: anywhere in
		// the first half of the prompt ("on one knee" is not here: "kneels down on one knee" starts standing)
		if i := strings.Index(p, w); i >= 0 && i < len(p)/2+8 {
			return motionConstraint{}, false
		}
	}
	g.poses.mu.RLock()
	defer g.poses.mu.RUnlock()
	for _, sp := range g.poses.items {
		if sp.SkeletonKey != skeletonKey || !strings.HasSuffix(strings.ToLower(sp.Name), "standing") {
			continue
		}
		rots := make([][]float64, len(sp.Rotations))
		for j, r := range sp.Rotations {
			rots[j] = []float64{float64(r[0]), float64(r[1]), float64(r[2]), float64(r[3])}
		}
		root := []float64{float64(sp.Root[0]), float64(sp.Root[1]), float64(sp.Root[2])}
		c := motionConstraint{Type: "fullbody", FrameIndices: []int{0, 1, 2, 3}, Label: "Standing start"}
		for k := 0; k < 4; k++ {
			c.RootPositions = append(c.RootPositions, root)
			c.LocalJointsRotXYZW = append(c.LocalJointsRotXYZW, rots)
		}
		return c, true
	}
	return motionConstraint{}, false
}
