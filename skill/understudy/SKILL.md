---
name: understudy
description: Make, check, fix and export 3D character animation with Understudy, the local text-to-motion workbench (NVIDIA Kimodo + MotionBricks, server at http://127.0.0.1:8094). Use whenever a task needs a character animation clip - generating motion from a text prompt, building a clip from poses (stand, sit on a box, lean, push, kneel), checking a clip for foot sliding, floor clipping, jitter or a missed move, fixing it (Clean up, settle, loop, regenerate a range), keying pose changes on its timeline, or exporting GLB / skinned GLB / BVH or sending it to Unreal - for any game.
---

# Understudy

Understudy turns words or poses into a character animation clip, checks it, fixes it and exports it. People use the
page at http://127.0.0.1:8094; you drive the same server through its HTTP API with `scripts/us.py` (standard-library
Python; `py scripts/us.py -h`). Frames in `us.py` are **1-based** like the page and the frame sheets; the raw API is
0-based.

Work like an animator: make the motion, **look at it**, fix what is wrong, look again, then deliver. A clean set of
checks is not a good clip; only looking tells you that.

## 0. Before anything

1. `py scripts/us.py status`. It lists models, clips, and anything generating or running.
2. If it says the server is not answering, start it from the Understudy checkout:
   ```
   scripts\start.bat
   ```
   (add `-gemx <GEM-X folder>` to turn on video tracking).
   Wait until `status` answers (the library loads in a few seconds).
3. Restart the server only when nothing is generating or running, and stop only `understudy.exe` (by its process
   id). Never kill Python processes broadly: other tools' bridges run in Python.

## 1. The loop

1. **Make** a clip.
   - From words: `us.py generate "A person vaults over a low wall." --frames 120 --takes 4`. Write "A person …", one
     action per part, plain physical words. A second action in the same clip: `--then "A person sits down.:90"`.
     60–360 frames per part (30 = 1 s). About a minute per take; `--takes 4` for anything hard and keep the cleanest.
     No standing pose is pinned by default (it kept the first seconds generic); a walk or other continuous move is
     pre-rolled so it is in character from frame 1 (`--start-standing` pins the old neutral start). For a turn say how: "turns around by taking two steps"; a bare "turns around" spins on planted feet.
   - From a video: `us.py mocap <video.mp4>` tracks the person (GEM-X) and makes a clip from the tracked motion as
     it is, with the tracked-motion Clean up (`keep_snap`): the video's own timing and speed. Regenerating from the
     track through Kimodo (the page: Refs › Track with GEM-X › Generate) is smoother but softens strikes by a third.
   - From poses (sitting, leaning, pushing, kneeling, things that touch a box): `us.py poses` lists the saved ones;
     `us.py sequence "Starter · standing" "seated on a box|onto=sit|hold=1.5" "Starter · standing" --box 0.5,0.45,0.5`.
     `onto=sit` puts the hips on the box top, `onto=hands` the hands; `hold` is seconds; `turn` is degrees.
2. **Look.** `us.py show <clip>` (what the checks found, each with the fix to try), then
   `us.py sheet <clip> --out sheet.png` and open the PNG (Read it). Check every drawn frame: feet planted where they
   should be, no limb through the body or floor, the move actually performed, the start and end at rest. Use
   `--from/--to/--every 1` to look closely at a stretch; `--views front,side,top`. Left limbs are blue, right orange, a
   joint under the floor or inside a box red. **Judge feet by lift**: on a walk the toes must leave the floor between
   contacts (side view); a body that travels or turns while the toes stay down is gliding, however good the poses.
3. **Fix** (each edit is in place and undoable with `us.py edit <clip> undo`):

   | The check says | Try |
   |---|---|
   | through the floor, floats, foot hovers, self-clip, hand in face, jitter, off balance, joint past its range | `edit <clip> cleanup` |
   | a foot slides N cm along the floor (a glide, not a step) | ≤ 8 cm: `edit <clip> cleanup`; more: `edit <clip> regen --from A --to B` over it (+6 either side), or generate again asking for steps |
   | turns N° without stepping (spins on planted feet) | a turn in place is planned automatically when the prompt starts with it ("A person turns around…"); otherwise `regen` over the turn, then `regen-next` for another version |
   | ends mid-motion / ends in the air | `edit <clip> settle` |
   | starts mid-motion | `edit <clip> regen --from 1 --to 12` |
   | a bad stretch in the middle | `edit <clip> regen --from A --to B` (best of several tries); not right → `edit <clip> regen-next` |
   | should loop | `edit <clip> loop` |
   | idle at the ends | `edit <clip> trim-idle` (makes a copy) |
   | floaty jump | `edit <clip> arc` |
   | misses the move | generate again with clearer words or more takes, or build it from poses |

   After every fix, `show` and look at a sheet again. If a fix made it worse, `edit <clip> undo`.
4. **Pose changes** go on the timeline as keys: `us.py key <clip> --frame 40 --turn RightArm=0,0,-40` (degrees in
   the joint's own axes; `us.py joints` lists joints and parts). Between keys the motion blends; `--interp hold`
   freezes the pose to the next key. `keys`, `movekey`, `unkey`, `blend` manage them. Keys are raw: unlike the page's
   Handles they do not bend the knees for you or keep feet out of the floor, so `show` after keying and fix (a hips
   key lowered 10 cm put the toes 10 cm into the floor). Any other edit (cleanup, settle…) bakes the keys into the
   motion; `undo` brings them back.
5. **Deliver.** Name and file it: `us.py patch <clip> --name "Vault · low wall" --project <id>`. Export:
   `us.py export <clip> --format skinned --out vault.glb` (for Unreal/Blender; `glb`, `bvh`, `pack` too), or
   `us.py unreal <clip>` when the clip's project has Pipeline settings (set in the page). Markers:
   `us.py marker <clip> --frame 32 --name plant`.

## 2. Rules

- The tool is branded **Understudy** only: no studio branding in it or in what it exports.
- Never make planted feet worse with an edit; compare before and after on a sheet.
- Clips you make to test something are yours: `us.py trash` them when done. Never trash or edit other clips unless
  asked (the Trash keeps files; `us.py restore` brings clips back).
- The SMPL-X model is research-licensed (no shipping, no sharing). Ship SOMA clips (the default) or G1 (robot).
- When you change Understudy's code: page scripts need a reload in the browser (Ctrl+F5); Clean up / MotionBricks
  Python workers and Go changes need a server rebuild and restart (see section 0).

## 3. More

- `references/api.md`: every endpoint and field, for what `us.py` does not cover (constraints, import, scenes).
- `LESSONS.md`: what earlier sessions learned. **Read it**, and add to it when you learn something that would have
  saved you time. This skill is refined over time.
