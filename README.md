# Understudy

[![Support Understudy on Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Understudy-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/citadelxvi)

A local animation workbench for game characters. Describe a motion in words, get a clip from
NVIDIA's Kimodo text-to-motion model running on your own GPU, check it for the faults that make
generated motion unusable, fix them in place, and send the result to your engine.

Understudy is a Go server and a browser page on top of [kimodo.cpp](https://github.com/Digital-Contraption-Labs/kimodo.cpp),
the GGML/C++ port of Kimodo. Nothing leaves your machine: no account, no cloud, no per-clip cost.

## What it does

- **Generate.** Write "A person …", pick how many takes, generate. Every take is scored and the
  cleanest one is selected. Badges flag foot sliding, feet through the floor, jitter, self-clipping
  (every limb pair) and floaty jumps.
- **Judge.** Skeleton, body, or both, with an x-ray through the body; trails, onion skin, clip
  capsules, hands. Frame sheets and WebM video for review away from the page.
- **Fix in place.** The Checks row lists what flagged and the fix that applies. Handles on hands,
  feet, hips, elbows, knees and gaze, with axis locks and exact values; apply to the clip with easing
  and undo/redo, or **regenerate around it**. Keep ranges you like and regenerate the rest. Plant
  feet, tween, mirror, retime, loop, settle into a standing pose.
- **Clean up.** A physics-checked pass (MuJoCo) that plants feet, lifts the body out of the floor and
  pushes limbs out of each other, plus wrist and hand clean-up on every new clip.
- **Two actors.** Write the scene ("Actor 1 throws a spinning kick at Actor 2. Actor 2 catches the
  kick and counters.") and the director makes one clip per actor, places them at strike reach,
  aligns the beats, pins the contacts and regenerates around them.
- **Ship.** GLB, skinned GLB, BVH, FBX (through Blender), or **Send to Unreal**: import, retarget onto
  your skeletal mesh (UE5 Manny/Quinn, UEFN mannequin or your own), sync markers, FBX out.

## Requirements

- Windows 10/11 and a GPU with Vulkan (developed on an AMD RX 7900 XT; the model also runs on CPU, slowly).
- Visual Studio 2022 or later with **Desktop development with C++** (includes CMake and Ninja).
- [Vulkan SDK](https://vulkan.lunarg.com/sdk/home), [Go](https://go.dev/dl/) 1.26+, Git, Python 3.
- About 10 GB of disk for the weights.

Linux and macOS builds of kimodo.cpp exist; Understudy's launch scripts are Windows-only for now.

## Quick start

```bat
git clone --recursive https://github.com/CitadelXVI/understudy
cd understudy
py -m pip install huggingface_hub
scripts\build.bat          :: kmd-generate (C++/Vulkan) and the Understudy server
scripts\get-weights.bat    :: Kimodo SOMA RP v1.1 + the Llama-3 text encoder (Q8_0)
scripts\start.bat          :: http://127.0.0.1:8094
```

The first start loads the models and compiles GPU kernels, which takes about a minute. Clips,
projects, poses and daily backups are kept in `demo-output\`. `scripts\stop.bat` stops the server.

**Better model (optional).** Understudy prefers Kimodo **SOMA RP v1.2**, which NVIDIA publishes only
as a PyTorch checkpoint. `py scripts\convert_soma_v12.py` downloads it and converts it to GGUF
(about 1.1 GB); restart the server and it is picked automatically.

## Optional tools

| Tool | What it adds | Set up |
|---|---|---|
| Clean up | Physics-checked foot planting, floor and self-collision fixes | `scripts\setup-tools.bat cleanup` |
| MotionBricks | Regenerate a range, settle into a stand, make a loop (NVIDIA MotionBricks on ONNX Runtime, CPU) | Put [NVIDIA MotionBricks](https://github.com/NVlabs/motionbricks) with its ONNX assets in `motionbricks\` (or set `MOTIONBRICKS`), then `scripts\setup-tools.bat motionbricks` |
| Blender | FBX export | Install Blender; it is found under Program Files (or set `UNDERSTUDY_BLENDER`) |
| Unreal Engine | Send to Unreal | Set the project and target mesh in a project's Pipeline settings (expects UE 5.8 in its default install folder; the API's pipeline `editor` field points elsewhere) |
| GEM-X | Video to motion (experimental) | `-gemx <folder>` with an NVIDIA GEM-X checkout |

Features whose tool is missing say so when used; everything else keeps working.

## Using it from an AI agent

`skill/` is a [Claude Code](https://claude.com/claude-code) skill that drives Understudy through its
HTTP API: generate, look at frame sheets, fix, key, export. Copy `skill/understudy` into
`~/.claude/skills/`. `skill/understudy/scripts/us.py` is a standard-library Python client you can use
on its own (`py us.py -h`).

## API

Everything the page does goes through a local HTTP API; see
[`skill/understudy/references/api.md`](skill/understudy/references/api.md). The main calls:

- `POST /api/generate`: prompt or segments, frames, takes, seed, constraints, project.
- `GET /api/animations`, `PATCH`/`DELETE /api/animations/<id>`.
- `POST /api/animations/<id>/derive`: mirror, retime, pose edits, wrists, tween, undo/redo.
- `GET /api/animations/<id>/animation.glb | skinned.glb | animation.bvh`.

## Layout

```
*.go              the server: HTTP API, gallery, checks (metrics.go), edits (derive.go), director, exports
static/           the page: plain ES modules, no build step (three.js and MediaPipe vendored)
tools/cleanup/    Clean up worker (Python: numpy, scipy, MuJoCo)
tools/motionbricks/  MotionBricks worker
tools/turnplan/ tools/stairplan/  generators for the planned-move key poses (move_keys.json)
pipeline/         the Unreal-side import and retarget script
skill/            the Claude Code skill
kimodo.cpp/       submodule: the text-to-motion engine
scripts/          build, weights, start/stop, tool setup
```

Development: `build\understudy.exe -static static -generator kimodo.cpp/build/release/kmd-generate -output demo-output`
serves the page from disk so edits show on reload. `go test .` runs the server tests.

## Support

Understudy is free and stays free. If it saves you time, you can buy it a coffee at
[ko-fi.com/citadelxvi](https://ko-fi.com/citadelxvi). Bug reports, clips that came out wrong and pull requests help just as much.

## Licenses

Understudy is Apache-2.0 (see `LICENSE` and `NOTICE`). The model weights are not included and come
under their own terms: the Kimodo SOMA and G1 models under the **NVIDIA Open Model License**
(commercial use allowed), the SMPL-X model under an NVIDIA research-only license (Understudy will
not share clips made with it), and the text encoder under the **Meta Llama 3 Community License**.
Read them before you ship anything made with them.
