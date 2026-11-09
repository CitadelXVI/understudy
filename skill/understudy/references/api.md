# Understudy HTTP API

Server: `http://127.0.0.1:8094`. JSON in and out. Frames are **0-based** here (the page and `us.py` show 1-based).
Rotations are parent-local quaternions `[x, y, z, w]`, one per joint; positions in metres, Y up, the character faces
+Z with its left on +X; the floor is at y = 0.02. SOMA joint order: `us.py joints`.

## Clips

| | |
|---|---|
| `GET /api/animations` | every clip (no single-clip GET: filter this list). Fields: `id, name, prompt, frames, status (queued/running/ready/failed), progress, error, model, project, folder, tags, markers [{frame,name}], props [box], metrics {flags[], …}, warnings[], verdict, layer {keys, blend}, edits, redos, trashed` |
| `PATCH /api/animations/<id>` | `{name, project, folder, favorite, archived, trashed, markers, hand_track, tags, props}` (any subset) |
| `POST /api/animations/batch` | `{ids:[…], patch:{…}}` or `{ids, delete:true}` (to the Trash) or `{ids, delete:true, permanent:true}` (only clips already in the Trash) |
| `GET /api/animations/<id>/root.f32` | hips positions, float32 little-endian, frames × 3 |
| `GET /api/animations/<id>/rotations.f32` | local rotations, float32, frames × joints × 4 |
| `GET /api/animations/<id>/animation.glb` · `skinned.glb` · `animation.bvh` · `pack` | exports (`pack` = `.understudy` share file; refused for SMPL-X) |
| `GET /api/animations/<id>/sheet.png` | stick-figure frame sheet: `from, to, every, frames=0,12,40, views=front,side,back,left,top,three, tile` |
| `POST /api/animations/<id>/pipeline` | send to Unreal (import, retarget, FBX) as a job; needs the project's Pipeline settings |
| `GET /api/jobs` · `/api/jobs/<id>` | Unreal pipeline jobs |
| `POST /api/mocap/gemx?name=` (body: the video) · `GET /api/mocap/gemx/<job>` · `/rot.json` | GEM-X video tracking: a job, its status, its result (`{fps, frames, names, root, rot}`, SOMA native rotations); the result lives in server memory until a restart |

## Making clips

`POST /api/generate` (one take; the page posts one per take with a shared `batch`):

```
{ prompt, segments: [{prompt, frames}], frames, steps (50), seed, model ("soma-rp-v1.2"), text_cfg (2),
  transition_frames (5), constraints: [...], constraint_cfg, first_heading, project, folder, name, tags,
  batch, take, takes, post_processing: true, clean_wrists: true, clean_hands: true, ground_hands: true,
  ground_feet: true, smooth_jitter: false, clean_up: true, finish_settled: true, action_retries: 3,
  start_standing: true (pins the saved standing pose on frames 0-3 unless the words start the person low) }
```
Returns the clip (status `queued`); poll `GET /api/animations` until `ready` or `failed`.

Constraints (keyframes the motion must pass through), each `{type, frame_indices:[…], …}`:
- `fullbody`: `root_positions [[x,y,z]…]`, `local_joints_rot_xyzw [[[x,y,z,w]×J]…]` per frame
- `end-effector`: hands/feet targets (see constraints.go)
- `root2d`: `smooth_root_2d [[x,z]…]`, `global_root_heading [[cos,sin]…]` (a route on the floor)

`POST /api/animations/sequence` (MotionBricks, through saved poses in order; synchronous, returns the clip):
`{name, project, model, prompt, clean_up, props:[box], poses:[{id | root+rotations, place, turn, absolute, tokens, onto: "sit"|"hands", hold: seconds}]}`.

`POST /api/animations/import` `{name, project, model, prompt, tags, root:[[x,y,z]…], rotations:[[[x,y,z,w]×J]…]}`.

`POST /api/animations/blank` `{project, frames (60)}` → "Blank · T-pose" (kind `blank`): the rest pose on the floor, to pose and key from nothing; an untouched blank in the project is returned again.

Saved poses: `GET /api/poses`, `POST /api/poses {name, skeleton_key, root, rotations}`, `PATCH|DELETE /api/poses/<id>`.

A box prop: `{kind:"box", name, pos:[x, 0.02, z] (centre of its base), size:[w, h, d], yaw (radians)}`.

## Editing: `POST /api/animations/<id>/derive`

`{op, in_place: true, …}`. In place = the clip changes, one undo step (`undo_pose` / `redo_pose`). `mirror`,
`retime`, `trim_idle` make a new clip instead. Results carry `warnings` (what the edit did that may be unwanted).

| op | fields | does |
|---|---|---|
| `cleanup` | `strength` 0..1 (0.95), `keep_snap` | physics + anti-clipping pass: floor, sliding, self-clip, jitter. `keep_snap: true` = the tracked-motion profile (denoise 0.6 first, then the clip's own speed and snap kept; for generated clips it keeps shakes too) |
| `mb_settle` / `mb_loop` | `tokens`, `no_clean` | end at rest / make it loop (MotionBricks, then Clean up) |
| `mb_regen` | `from, to, tokens, no_clean` | regenerate a range from the frames around it |
| `smooth`, `floor`, `ground`, `wrists`, `hands` | | narrower fixes (jitter, feet to floor, hands to floor, wrist range, hands out of head) |
| `tween` | `from, to, amount` | pull a range toward a smooth path between its ends |
| `mirror_range` | `from, to` | mirror left/right over a range |
| `arc` | | put a jump on a gravity arc |
| `pose` | `frame, root, rotations, falloff` or `keys:[{frame,root,rotations}]` | bake a pose in, eased over ±falloff frames |
| `layer` | `layer: {keys:[…], blend}` | the timeline keys (all of them); see below |
| `revert` | | back to the clip as first made |
| `mirror`, `retime` (`speed` 0.25..4), `trim_idle` | | new clip |
| `undo_pose`, `redo_pose` | | |

Timeline keys (`layer`): `keys: [{frame, part, interp, rotations, root | offset+turn}]`, `part` one of `body` (hips
position and turn), `spine` (back, neck, head), `larm`, `rarm`, `lleg`, `rleg`; `rotations` is the whole pose (all
joints; the part's joints are used); a body key sent with `root` (where the hips are) is stored as `offset` + `turn`
(its change from the motion). `interp`: `""` smooth, `linear`, `hold`. `blend`: frames eased in before the first key and
out after the last. Send every key each time (the list replaces the layer); an empty list removes the layer. Any other
in-place edit bakes the keys into the motion (with a warning; undo restores them).

## Checks (`metrics.flags`)

`slide` (`slide_m, slide_side, slide_from, slide_to, slide_count`: a toe down but travelling along the floor), `pivot`
(`pivot_deg, pivot_from, pivot_to`: the hips turning while standing with no foot lifting), `floor`, `skate`, `float`,
`foot_hover`, `balance`, `jitter`, `hover`, `hand_head`, `clip`, `ballistic`, `action`, `unsettled_start`,
`unsettled_end`, `idle`, `anatomy`. The numbers behind each are in `metrics`
(`floor_m, floor_part, floor_frame, foot_skate, jitter_peak, jitter_joint, end_speed, …`); `us.py show` turns them
into sentences.
