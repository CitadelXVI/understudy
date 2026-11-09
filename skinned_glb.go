// A skinned GLB for Unreal: the skeleton with a tiny cube per joint, each
// fully weighted to its joint, so Interchange imports a skeletal mesh with a
// skeleton and the animation. (The node-only GLB upstream exports stays the
// download for Three.js consumers.)
package main

import (
	"encoding/binary"
	"encoding/json"
	"math"
)

func buildSkinnedGLB(roots, rotations []float32, skeleton skeletonDefinition) ([]byte, error) {
	joints := len(skeleton.parents)
	frames := len(roots) / 3
	// Rest pose: global joint positions from the parent-local offsets. The
	// root rests at standing hips height (the clip's own first frame), not at
	// the origin: Unreal's retargeter scales pelvis motion by the ratio of
	// rest pelvis heights, and a zero height makes that ratio explode.
	restRoot := skeleton.offsets[0]
	if restRoot[1] == 0 && frames > 0 {
		restRoot = [3]float32{0, roots[1], 0}
	}
	global := make([][3]float32, joints)
	for j, p := range skeleton.parents {
		o := skeleton.offsets[j]
		if p < 0 {
			global[j] = restRoot
		} else {
			global[j] = [3]float32{global[p][0] + o[0], global[p][1] + o[1], global[p][2] + o[2]}
		}
	}
	// Mesh: a 3 cm cube on every joint.
	const size = 0.015
	var positions []float32
	var jointIDs []uint16
	var weights []float32
	var indices []uint16
	cubeFaces := [][3]int{{0, 1, 3}, {0, 3, 2}, {4, 6, 7}, {4, 7, 5}, {0, 4, 5}, {0, 5, 1}, {2, 3, 7}, {2, 7, 6}, {0, 2, 6}, {0, 6, 4}, {1, 5, 7}, {1, 7, 3}}
	minP, maxP := [3]float32{math.MaxFloat32, math.MaxFloat32, math.MaxFloat32}, [3]float32{-math.MaxFloat32, -math.MaxFloat32, -math.MaxFloat32}
	for j := 0; j < joints; j++ {
		base := uint16(len(positions) / 3)
		for _, dx := range []float32{-size, size} {
			for _, dy := range []float32{-size, size} {
				for _, dz := range []float32{-size, size} {
					v := [3]float32{global[j][0] + dx, global[j][1] + dy, global[j][2] + dz}
					positions = append(positions, v[0], v[1], v[2])
					for k := 0; k < 3; k++ {
						minP[k] = float32(math.Min(float64(minP[k]), float64(v[k])))
						maxP[k] = float32(math.Max(float64(maxP[k]), float64(v[k])))
					}
					jointIDs = append(jointIDs, uint16(j), 0, 0, 0)
					weights = append(weights, 1, 0, 0, 0)
				}
			}
		}
		for _, f := range cubeFaces {
			indices = append(indices, base+uint16(f[0]), base+uint16(f[1]), base+uint16(f[2]))
		}
	}
	// Inverse bind matrices: translate by the negated rest position (column-major).
	var ibm []float32
	for j := 0; j < joints; j++ {
		ibm = append(ibm, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -global[j][0], -global[j][1], -global[j][2], 1)
	}
	times := make([]float32, frames)
	for f := range times {
		times[f] = float32(f) / float32(fps)
	}
	// Binary chunk and views.
	var bin []byte
	var views []gltfBufferView
	addView := func(data []byte) int {
		for len(bin)%4 != 0 {
			bin = append(bin, 0)
		}
		views = append(views, gltfBufferView{Buffer: 0, ByteOffset: len(bin), ByteLength: len(data)})
		bin = append(bin, data...)
		return len(views) - 1
	}
	u16 := func(values []uint16) []byte {
		out := make([]byte, 0, len(values)*2)
		for _, v := range values {
			var b [2]byte
			binary.LittleEndian.PutUint16(b[:], v)
			out = append(out, b[:]...)
		}
		return out
	}
	vIdx := addView(u16(indices))
	vPos := addView(appendF32(nil, positions))
	vJnt := addView(u16(jointIDs))
	vWt := addView(appendF32(nil, weights))
	vIbm := addView(appendF32(nil, ibm))
	vTime := addView(appendF32(nil, times))
	vRoot := addView(appendF32(nil, roots))
	rotViews := make([]int, joints)
	for j := 0; j < joints; j++ {
		track := make([]float32, 0, frames*4)
		for f := 0; f < frames; f++ {
			at := (f*joints + j) * 4
			track = append(track, rotations[at], rotations[at+1], rotations[at+2], rotations[at+3])
		}
		rotViews[j] = addView(appendF32(nil, track))
	}
	type accessor struct {
		BufferView    int       `json:"bufferView"`
		ComponentType int       `json:"componentType"`
		Count         int       `json:"count"`
		Type          string    `json:"type"`
		Min           []float32 `json:"min,omitempty"`
		Max           []float32 `json:"max,omitempty"`
	}
	accessors := []accessor{
		{vIdx, 5123, len(indices), "SCALAR", nil, nil},
		{vPos, 5126, len(positions) / 3, "VEC3", minP[:], maxP[:]},
		{vJnt, 5123, len(jointIDs) / 4, "VEC4", nil, nil},
		{vWt, 5126, len(weights) / 4, "VEC4", nil, nil},
		{vIbm, 5126, joints, "MAT4", nil, nil},
		{vTime, 5126, frames, "SCALAR", []float32{times[0]}, []float32{times[frames-1]}},
		{vRoot, 5126, frames, "VEC3", nil, nil},
	}
	for j := 0; j < joints; j++ {
		accessors = append(accessors, accessor{rotViews[j], 5126, frames, "VEC4", nil, nil})
	}
	nodes := make([]map[string]any, 0, joints+1)
	for j := 0; j < joints; j++ {
		translation := skeleton.offsets[j]
		if j == 0 {
			translation = restRoot
		}
		node := map[string]any{"name": skeleton.names[j], "translation": translation}
		var children []int
		for c, p := range skeleton.parents {
			if p == j {
				children = append(children, c)
			}
		}
		if children != nil {
			node["children"] = children
		}
		nodes = append(nodes, node)
	}
	nodes = append(nodes, map[string]any{"name": "UnderstudySkinnedMesh", "mesh": 0, "skin": 0})
	samplers := []map[string]any{{"input": 5, "output": 6, "interpolation": "LINEAR"}}
	channels := []map[string]any{{"sampler": 0, "target": map[string]any{"node": 0, "path": "translation"}}}
	for j := 0; j < joints; j++ {
		samplers = append(samplers, map[string]any{"input": 5, "output": 7 + j, "interpolation": "LINEAR"})
		channels = append(channels, map[string]any{"sampler": len(samplers) - 1, "target": map[string]any{"node": j, "path": "rotation"}})
	}
	jointList := make([]int, joints)
	for j := range jointList {
		jointList[j] = j
	}
	doc := map[string]any{
		"asset":       map[string]any{"version": "2.0", "generator": "Understudy skinned GLB"},
		"scene":       0,
		"scenes":      []map[string]any{{"nodes": []int{0, joints}}},
		"nodes":       nodes,
		"meshes":      []map[string]any{{"name": "UnderstudyMesh", "primitives": []map[string]any{{"attributes": map[string]int{"POSITION": 1, "JOINTS_0": 2, "WEIGHTS_0": 3}, "indices": 0}}}},
		"skins":       []map[string]any{{"name": "UnderstudySkin", "inverseBindMatrices": 4, "joints": jointList, "skeleton": 0}},
		"buffers":     []map[string]any{{"byteLength": len(bin)}},
		"bufferViews": views,
		"accessors":   accessors,
		"animations":  []map[string]any{{"name": "UnderstudyMotion", "samplers": samplers, "channels": channels}},
	}
	jsonBytes, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	for len(jsonBytes)%4 != 0 {
		jsonBytes = append(jsonBytes, ' ')
	}
	for len(bin)%4 != 0 {
		bin = append(bin, 0)
	}
	out := make([]byte, 0, 28+len(jsonBytes)+len(bin))
	header := make([]byte, 12)
	copy(header, "glTF")
	binary.LittleEndian.PutUint32(header[4:], 2)
	binary.LittleEndian.PutUint32(header[8:], uint32(28+len(jsonBytes)+len(bin)))
	out = append(out, header...)
	chunk := make([]byte, 8)
	binary.LittleEndian.PutUint32(chunk, uint32(len(jsonBytes)))
	copy(chunk[4:], "JSON")
	out = append(out, chunk...)
	out = append(out, jsonBytes...)
	binary.LittleEndian.PutUint32(chunk, uint32(len(bin)))
	copy(chunk[4:], "BIN\x00")
	out = append(out, chunk...)
	out = append(out, bin...)
	return out, nil
}
