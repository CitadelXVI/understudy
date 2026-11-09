package main

// The key layer: keyframes set on the timeline on top of the generated motion (the usual way to edit mocap: an
// animation layer). Each key belongs to one track (a part of the body) at one frame. Between two keys of a track the
// change from the generated motion blends from one key's change to the next (smooth, linear or held); before the first
// key and after the last it eases in and out over Blend frames. A held arm, leg or back keeps the key's pose until the
// next key. Arms, legs, back and head keys hold the pose itself
// (moved in time, the pose moves with it); the Body track (hips position and turn) holds a change from the motion, so
// moving it along a walk does not teleport the body.
//
// The motion from before the layer (its base) is kept beside the clip (layer_base_*.f32) so the keys can be edited
// again at any time; any other edit bakes the layer into the clip and drops the keys.

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
)

const (
	layerBaseRoots     = "layer_base_root_positions.f32"
	layerBaseRotations = "layer_base_local_rotations_xyzw.f32"
)

type layerKey struct {
	Frame     int         `json:"frame"`
	Part      string      `json:"part"`             // body, spine, larm, rarm, lleg, rleg
	Interp    string      `json:"interp,omitempty"` // to the next key: smooth (default), linear, hold
	Rotations [][]float32 `json:"rotations"`        // the pose's local rotations, one per joint (the track's joints are used)
	Root      []float32   `json:"root,omitempty"`   // body, as set: where the hips are (turned into Offset on save)
	Offset    []float32   `json:"offset,omitempty"` // body: hips position change from the motion at the key's frame
	Turn      []float32   `json:"turn,omitempty"`   // body: hips turn change from the motion at the key's frame
}

type keyLayer struct {
	Keys  []layerKey `json:"keys"`
	Blend int        `json:"blend"` // frames the layer eases in before its first key and out after its last
}

var layerPartNames = []string{"body", "spine", "larm", "rarm", "lleg", "rleg"}

// layerParts: the joints of each track. Arms from the collarbones down, legs from the hips down, Body the root joint,
// the back and head everything else (a skeleton without these names keys every joint as the back).
func layerParts(skeleton skeletonDefinition) map[string][]int {
	idx := func(n string) int {
		for i, s := range skeleton.names {
			if s == n {
				return i
			}
		}
		return -1
	}
	under := func(root int) map[int]bool {
		set := map[int]bool{}
		if root < 0 {
			return set
		}
		set[root] = true
		for changed := true; changed; {
			changed = false
			for j, p := range skeleton.parents {
				if p >= 0 && set[p] && !set[j] {
					set[j], changed = true, true
				}
			}
		}
		return set
	}
	first := func(names ...string) int { // the first of these names the skeleton has (SOMA, SMPL-X, G1)
		for _, n := range names {
			if i := idx(n); i >= 0 {
				return i
			}
		}
		return -1
	}
	sets := map[string]map[int]bool{
		"larm": under(first("LeftShoulder", "left_collar", "left_shoulder_pitch_skel")), "rarm": under(first("RightShoulder", "right_collar", "right_shoulder_pitch_skel")),
		"lleg": under(first("LeftLeg", "left_hip", "left_hip_pitch_skel")), "rleg": under(first("RightLeg", "right_hip", "right_hip_pitch_skel")),
	}
	parts := map[string][]int{}
	for j, p := range skeleton.parents {
		name := "spine"
		if p < 0 {
			name = "body"
		}
		for _, k := range []string{"larm", "rarm", "lleg", "rleg"} {
			if sets[k][j] {
				name = k
			}
		}
		parts[name] = append(parts[name], j)
	}
	return parts
}

func validLayerPart(p string) bool {
	for _, n := range layerPartNames {
		if n == p {
			return true
		}
	}
	return false
}

// prepareLayer checks the keys, sorts them, keeps one key per track and frame (the last given), and turns a Body key's
// hips position and turn into changes from the base motion at its frame.
func prepareLayer(l *keyLayer, baseRoots, baseRot []float32, joints, frames int) error {
	if l.Blend < 0 || l.Blend > 120 {
		return errors.New("blend must be 0..120 frames")
	}
	if len(l.Keys) > 2000 {
		return errors.New("at most 2000 keys")
	}
	seen := map[[2]interface{}]int{}
	out := make([]layerKey, 0, len(l.Keys))
	for _, k := range l.Keys {
		if k.Frame < 0 || k.Frame >= frames {
			return errors.New("a key is outside the clip")
		}
		if !validLayerPart(k.Part) {
			return errors.New("a key's part must be body, spine, larm, rarm, lleg or rleg")
		}
		switch k.Interp {
		case "", "smooth", "linear", "hold":
		default:
			return errors.New("a key's interp must be smooth, linear or hold")
		}
		if len(k.Rotations) != joints {
			return errors.New("each key needs one rotation per joint")
		}
		for _, r := range k.Rotations {
			if len(r) != 4 {
				return errors.New("each rotation is an XYZW quaternion")
			}
		}
		if k.Part == "body" {
			if len(k.Root) == 3 { // as set on the stage: where the hips are, and their turn
				at := k.Frame * 3
				k.Offset = []float32{k.Root[0] - baseRoots[at], k.Root[1] - baseRoots[at+1], k.Root[2] - baseRoots[at+2]}
				b := baseQ(baseRot, joints, k.Frame, 0)
				t := qmul(qnorm([4]float32{k.Rotations[0][0], k.Rotations[0][1], k.Rotations[0][2], k.Rotations[0][3]}), [4]float32{-b[0], -b[1], -b[2], b[3]})
				k.Turn = t[:]
				k.Root = nil
			}
			if len(k.Offset) != 3 || len(k.Turn) != 4 {
				return errors.New("a body key needs root (or offset and turn)")
			}
		}
		key := [2]interface{}{k.Part, k.Frame}
		if i, ok := seen[key]; ok {
			out[i] = k
			continue
		}
		seen[key] = len(out)
		out = append(out, k)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Frame < out[j].Frame })
	l.Keys = out
	return nil
}

func baseQ(rot []float32, joints, frame, j int) [4]float32 {
	at := (frame*joints + j) * 4
	return [4]float32{rot[at], rot[at+1], rot[at+2], rot[at+3]}
}

// applyLayer: the base motion with the layer's keys on it.
func applyLayer(baseRoots, baseRot []float32, skeleton skeletonDefinition, l *keyLayer) ([]float32, []float32) {
	joints := len(skeleton.parents)
	frames := len(baseRoots) / 3
	roots := append([]float32(nil), baseRoots...)
	rot := append([]float32(nil), baseRot...)
	if l == nil || len(l.Keys) == 0 {
		return roots, rot
	}
	ident := [4]float32{0, 0, 0, 1}
	smooth := func(u float32) float32 { return u * u * (3 - 2*u) }
	for part, js := range layerParts(skeleton) {
		var ks []layerKey
		for _, k := range l.Keys {
			if k.Part == part {
				ks = append(ks, k)
			}
		}
		if len(ks) == 0 {
			continue
		}
		// each key's change from the base, per joint (and the hips position change for Body)
		type change struct {
			q   map[int][4]float32
			off [3]float32
		}
		ch := make([]change, len(ks))
		for i, k := range ks {
			c := change{q: map[int][4]float32{}}
			for _, j := range js {
				if part == "body" && j == js[0] {
					c.q[j] = qnorm([4]float32{k.Turn[0], k.Turn[1], k.Turn[2], k.Turn[3]})
					continue
				}
				b := baseQ(baseRot, joints, k.Frame, j)
				r := k.Rotations[j]
				c.q[j] = qmul(qnorm([4]float32{r[0], r[1], r[2], r[3]}), [4]float32{-b[0], -b[1], -b[2], b[3]})
			}
			if part == "body" {
				c.off = [3]float32{k.Offset[0], k.Offset[1], k.Offset[2]}
			}
			ch[i] = c
		}
		for t := 0; t < frames; t++ {
			// the change at frame t: between two keys, blended; before the first / after the last, eased to none
			var a, b change
			var s float32
			hold := -1 // a held arm, leg or back keeps the key's pose itself until the next key
			first, last := ks[0].Frame, ks[len(ks)-1].Frame
			switch {
			case t <= first || t >= last:
				i, dist := 0, first-t
				if t >= last {
					i, dist = len(ks)-1, t-last
				}
				if dist > l.Blend && dist > 0 {
					continue
				}
				w := float32(1)
				if dist > 0 {
					w = smooth(1 - float32(dist)/float32(l.Blend+1))
				}
				a, b, s = change{q: map[int][4]float32{}}, ch[i], w
			default:
				i := sort.Search(len(ks), func(n int) bool { return ks[n].Frame > t }) - 1
				u := float32(t-ks[i].Frame) / float32(ks[i+1].Frame-ks[i].Frame)
				switch ks[i].Interp {
				case "hold":
					u = 0
					if part != "body" {
						hold = i
					}
				case "linear":
				default:
					u = smooth(u)
				}
				a, b, s = ch[i], ch[i+1], u
			}
			for _, j := range js {
				qa, ok := a.q[j]
				if !ok {
					qa = ident
				}
				at := (t*joints + j) * 4
				var q [4]float32
				if hold >= 0 {
					r := ks[hold].Rotations[j]
					q = qnorm([4]float32{r[0], r[1], r[2], r[3]})
				} else {
					d := slerp(qa, b.q[j], s)
					q = qnorm(qmul(d, [4]float32{baseRot[at], baseRot[at+1], baseRot[at+2], baseRot[at+3]}))
				}
				rot[at], rot[at+1], rot[at+2], rot[at+3] = q[0], q[1], q[2], q[3]
			}
			if part == "body" {
				for k := 0; k < 3; k++ {
					roots[t*3+k] += a.off[k] + s*(b.off[k]-a.off[k])
				}
			}
		}
	}
	return roots, rot
}

// The base motion under a clip's layer: in memory, else from its files.
func (g *gallery) layerBase(a *animation) ([]float32, []float32, bool) {
	if a.layerRoots != nil {
		return a.layerRoots, a.layerRot, true
	}
	if g.output == "" {
		return nil, nil, false
	}
	dir := filepath.Join(g.output, a.ID)
	roots, err := readF32File(filepath.Join(dir, layerBaseRoots))
	if err != nil {
		return nil, nil, false
	}
	rot, err := readF32File(filepath.Join(dir, layerBaseRotations))
	if err != nil || len(roots) != len(a.roots) || len(rot) != len(a.rotations) {
		return nil, nil, false
	}
	a.layerRoots, a.layerRot = roots, rot
	return roots, rot, true
}

// setLayerBase keeps (or, with nil, forgets) the base motion under the clip's layer, in memory and beside the clip.
func (g *gallery) setLayerBase(a *animation, roots, rot []float32) {
	a.layerRoots, a.layerRot = roots, rot
	if g.output == "" {
		return
	}
	dir := filepath.Join(g.output, a.ID)
	if roots == nil {
		_ = os.Remove(filepath.Join(dir, layerBaseRoots))
		_ = os.Remove(filepath.Join(dir, layerBaseRotations))
		return
	}
	if os.MkdirAll(dir, 0755) != nil {
		return
	}
	if writeF32File(filepath.Join(dir, layerBaseRoots), roots) == nil {
		_ = writeF32File(filepath.Join(dir, layerBaseRotations), rot)
	}
}
