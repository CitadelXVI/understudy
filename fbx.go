package main

// Download FBX (2026-10-30): the clip with the mannequin as an FBX file, for importing by hand into Unreal, Unity or
// any tool that reads FBX. The server builds the same skinned GLB as "Download GLB · with the body" and converts it
// with Blender in the background (5 s for a 5 s clip): Blender's glTF importer and FBX exporter, 30 fps, no leaf
// bones, Y up. Checked by importing the result back: 30 bones, every frame, the skinned body. Without Blender on the
// machine the button says so instead of failing silently.

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"time"
)

const glbToFBXScript = `import bpy, sys
args = sys.argv[sys.argv.index('--') + 1:]
src, dst = args[0], args[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = 30
bpy.ops.import_scene.gltf(filepath=src)
scene = bpy.context.scene
arm = next((o for o in scene.objects if o.type == 'ARMATURE'), None)
if arm and arm.animation_data and arm.animation_data.action:
    fr = arm.animation_data.action.frame_range
    scene.frame_start, scene.frame_end = int(fr[0]), int(fr[1])
bpy.ops.export_scene.fbx(filepath=dst, use_selection=False, add_leaf_bones=False, bake_anim=True,
                         bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False, bake_anim_simplify_factor=0.0,
                         primary_bone_axis='Y', secondary_bone_axis='X', axis_forward='-Z', axis_up='Y', apply_unit_scale=True)
print('FBX_OK')
`

// findBlender: UNDERSTUDY_BLENDER, else the newest Blender under Program Files\Blender Foundation
func findBlender() string {
	if p := os.Getenv("UNDERSTUDY_BLENDER"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	matches, _ := filepath.Glob(filepath.Join(os.Getenv("ProgramFiles"), "Blender Foundation", "Blender *", "blender.exe"))
	sort.Strings(matches)
	if len(matches) > 0 {
		return matches[len(matches)-1]
	}
	return ""
}

func (g *gallery) handleFBX(w http.ResponseWriter, r *http.Request, id string) {
	g.mu.RLock()
	a := g.items[id]
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
	blender := findBlender()
	if blender == "" {
		http.Error(w, "FBX needs Blender on this computer (it does the conversion). Install Blender, or use Download GLB.", http.StatusNotImplemented)
		return
	}
	dir, err := os.MkdirTemp("", "understudy-fbx-")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer os.RemoveAll(dir)
	glb, fbx, script := filepath.Join(dir, "clip.glb"), filepath.Join(dir, "clip.fbx"), filepath.Join(dir, "glb_to_fbx.py")
	if err := os.WriteFile(glb, data, 0o644); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if err := os.WriteFile(script, []byte(glbToFBXScript), 0o644); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, blender, "--background", "--factory-startup", "--python", script, "--", glb, fbx).CombinedOutput()
	result, rerr := os.ReadFile(fbx)
	if err != nil || rerr != nil || len(result) == 0 {
		tail := string(out)
		if len(tail) > 400 {
			tail = tail[len(tail)-400:]
		}
		http.Error(w, fmt.Sprintf("Blender could not make the FBX: %v %s", err, tail), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename="+stem+".fbx")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(result)
}
