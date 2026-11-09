"""Understudy → Unreal: import a clip's GLB, retarget it onto the project's character, export FBX.

Run headless by the Understudy server (UnrealEditor-Cmd -run=pythonscript). Settings arrive as
environment variables:
  UNDERSTUDY_GLB         the clip's skinned GLB (Kimodo skeleton)
  UNDERSTUDY_NAME        asset name, e.g. KMD_Backflip_v12s9
  UNDERSTUDY_CONTENT     content folder, default /Game/Understudy
  UNDERSTUDY_TARGET      target skeletal mesh path; empty = keep the clip on its own skeleton
  UNDERSTUDY_EXPORT_DIR  where the FBX goes
  UNDERSTUDY_MARKERS     JSON [{"frame": 40, "name": "apex"}] → sync markers on the sequence
  UNDERSTUDY_TARGET_IKRIG  optional: the project's own IK rig for the target (e.g. IK_UEFN_Mannequin)
                         instead of one generated from Unreal's template
  UNDERSTUDY_ROOT_MOTION optional: "pelvis" = the target's root bone follows the retargeted pelvis on the ground
                         (the Kimodo skeleton has no root bone, so copying "the source root" copies the hips)
  UNDERSTUDY_PREFIX      asset name prefix of the retargeted sequence, default A_
  UNDERSTUDY_HAND_GOALS  optional: "source" = the hands' IK goals follow the clip's hands (contact clips)
  UNDERSTUDY_PIN_IK      optional: "1" = pin Epic mannequin IK bones (ik_foot_*, ik_hand_*) to the real feet and
                         hands; without it Leg IK in a GASP-style anim graph drags planted feet with the root
Prints "UNDERSTUDY <key> <value>" lines the server reads back.
"""
import json
import os
import unreal

glb = os.environ['UNDERSTUDY_GLB']
name = os.environ.get('UNDERSTUDY_NAME', 'Understudy_Clip')
content = os.environ.get('UNDERSTUDY_CONTENT', '/Game/Understudy').rstrip('/')
target_path = os.environ.get('UNDERSTUDY_TARGET', '')
export_dir = os.environ.get('UNDERSTUDY_EXPORT_DIR', '')
markers = json.loads(os.environ.get('UNDERSTUDY_MARKERS') or '[]')
hands = json.loads(os.environ.get('UNDERSTUDY_HANDS') or '{}')
HAND_VALUE = {'auto': -1.0, 'relaxed': 0.0, 'fist': 1.0, 'open': 2.0, 'point': 3.0, 'flat': 4.0}
fps = float(os.environ.get('UNDERSTUDY_FPS', '30'))
target_ikrig = os.environ.get('UNDERSTUDY_TARGET_IKRIG', '')
root_motion = os.environ.get('UNDERSTUDY_ROOT_MOTION', '')
prefix = os.environ.get('UNDERSTUDY_PREFIX', 'A_')
eal = unreal.EditorAssetLibrary
tools = unreal.AssetToolsHelpers.get_asset_tools()


def say(key, value=''):
    print('UNDERSTUDY %s %s' % (key, value))


def load(path):
    asset = unreal.load_asset(path)
    if not asset:
        raise RuntimeError('missing asset ' + path)
    return asset


# 1. Import the GLB (Interchange): skeletal mesh + skeleton + animation on the Kimodo skeleton.
source_dir = '%s/Source/%s' % (content, name)
task = unreal.AssetImportTask()
task.filename = glb
task.destination_path = source_dir
task.automated = True
task.replace_existing = True
task.save = True
tools.import_asset_tasks([task])
imported = list(task.imported_object_paths)
source_mesh = source_anim = None
for p in imported:
    a = unreal.load_asset(p)
    if isinstance(a, unreal.SkeletalMesh):
        source_mesh = a
    elif isinstance(a, unreal.AnimSequence):
        source_anim = a
if not source_mesh or not source_anim:
    say('error', 'import produced no skeletal mesh + animation: %s' % imported)
    raise SystemExit(1)
say('asset', source_anim.get_path_name())
final_anim = source_anim

# 2. Retarget onto the target character when one is set.
if target_path:
    target_mesh = load(target_path)
    rig_dir = content + '/Rigs'

    def ik_rig(path, mesh):
        if eal.does_asset_exist(path):
            return unreal.load_asset(path)
        folder, rig_name = path.rsplit('/', 1)
        rig = tools.create_asset(rig_name, folder, unreal.IKRigDefinition, unreal.IKRigDefinitionFactory())
        c = unreal.IKRigController.get_controller(rig)
        c.set_skeletal_mesh(mesh)
        # Known skeletons (Manny, Quinn, UEFN, Mixamo…) get chains from Unreal's templates.
        if not c.apply_auto_generated_retarget_definition():
            say('log', 'no retarget template matched %s; chains must be set by hand in IK rig %s' % (mesh.get_name(), path))
        eal.save_loaded_asset(rig)
        return rig

    def load_or_create(path, cls, factory):
        if eal.does_asset_exist(path):
            return unreal.load_asset(path), False
        folder, asset_name = path.rsplit('/', 1)
        asset = tools.create_asset(asset_name, folder, cls, factory)
        if not asset:
            say('error', 'could not create ' + path)
            raise SystemExit(1)
        return asset, True

    def kimodo_rig(path, mesh):
        # Reconfigured every run: the source mesh is re-imported each time.
        rig, _ = load_or_create(path, unreal.IKRigDefinition, unreal.IKRigDefinitionFactory())
        c = unreal.IKRigController.get_controller(rig)
        c.set_skeletal_mesh(mesh)
        c.set_retarget_root('Hips')
        have = {str(g.get_editor_property('goal_name')) for g in c.get_all_goals()}
        for goal, bone in (('LeftHandIK', 'LeftHand'), ('RightHandIK', 'RightHand'), ('LeftFootIK', 'LeftFoot'), ('RightFootIK', 'RightFoot')):
            if goal not in have:
                c.add_new_goal(goal, bone)
        chains = {str(ch.get_editor_property('chain_name')) for ch in c.get_retarget_chains()}
        for chain, start, end, goal in (('Spine', 'Spine1', 'Chest', ''), ('Neck', 'Neck1', 'Neck2', ''), ('Head', 'Head', 'Head', ''),
                                        ('LeftClavicle', 'LeftShoulder', 'LeftShoulder', ''), ('RightClavicle', 'RightShoulder', 'RightShoulder', ''),
                                        ('LeftArm', 'LeftArm', 'LeftHand', 'LeftHandIK'), ('RightArm', 'RightArm', 'RightHand', 'RightHandIK'),
                                        ('LeftLeg', 'LeftLeg', 'LeftFoot', 'LeftFootIK'), ('RightLeg', 'RightLeg', 'RightFoot', 'RightFootIK'),
                                        ('LeftFoot', 'LeftToeBase', 'LeftToeBase', ''), ('RightFoot', 'RightToeBase', 'RightToeBase', '')):
            if chain not in chains:
                c.add_retarget_chain(chain, start, end, goal)
        eal.save_loaded_asset(rig)
        return rig

    src_rig = kimodo_rig(rig_dir + '/IK_Understudy_Kimodo', source_mesh)
    tgt_rig = load(target_ikrig) if target_ikrig else ik_rig(rig_dir + '/IK_Understudy_' + target_mesh.get_name(), target_mesh)
    rtg, _ = load_or_create(rig_dir + '/RTG_Kimodo_to_' + target_mesh.get_name(), unreal.IKRetargeter, unreal.IKRetargetFactory())
    c = unreal.IKRetargeterController.get_controller(rtg)
    c.set_ik_rig(unreal.RetargetSourceOrTarget.SOURCE, src_rig)
    c.set_ik_rig(unreal.RetargetSourceOrTarget.TARGET, tgt_rig)
    c.set_preview_mesh(unreal.RetargetSourceOrTarget.SOURCE, source_mesh)
    c.set_preview_mesh(unreal.RetargetSourceOrTarget.TARGET, target_mesh)
    c.remove_all_ops()
    c.add_default_ops()
    c.assign_ik_rig_to_all_ops(unreal.RetargetSourceOrTarget.SOURCE, src_rig)
    c.assign_ik_rig_to_all_ops(unreal.RetargetSourceOrTarget.TARGET, tgt_rig)
    hand_goals = os.environ.get('UNDERSTUDY_HAND_GOALS', '') == 'source'
    if hand_goals:
        # UE 5.8's default stack has no IK Chains op, so Run IK Rig solves with the goals where FK left them.
        run_ik = next((c.get_op_name(i) for i in range(c.get_num_retarget_ops())
                       if isinstance(c.get_op_controller(i), unreal.IKRetargetRunIKRigController)), None)
        ik_index = c.add_retarget_op('/Script/IKRig.IKRetargetIKChainsOp')
        if run_ik and ik_index >= 0:
            c.set_parent_op_by_name(c.get_op_name(ik_index), run_ik)
            c.assign_ik_rig_to_all_ops(unreal.RetargetSourceOrTarget.SOURCE, src_rig)
            c.assign_ik_rig_to_all_ops(unreal.RetargetSourceOrTarget.TARGET, tgt_rig)
        else:
            say('log', 'could not add the IK Chains op; hands stay FK')
    c.auto_map_chains(unreal.AutoMapChainType.FUZZY, True)
    # The Kimodo toe chain is called LeftFoot/RightFoot; Epic's rigs call theirs LeftToe/RightToe.
    tgt_chains = {str(ch.get_editor_property('chain_name')) for ch in unreal.IKRigController.get_controller(tgt_rig).get_retarget_chains()}
    # Fuzzy matching also wires chains the Kimodo skeleton does not have (fingers, extra roots) to whatever is
    # nearest by name (LeftIndex <- LeftLeg): keep only same-named chains and the toes; the rest stay unmapped.
    src_chains = {str(ch.get_editor_property('chain_name')) for ch in unreal.IKRigController.get_controller(src_rig).get_retarget_chains()}
    toes = {side + 'Toe': side + 'Foot' for side in ('Left', 'Right') if side + 'Toe' in tgt_chains}
    for t in tgt_chains:
        if t in toes:
            c.set_source_chain(toes[t], t)
        elif t not in src_chains:
            c.set_source_chain('None', t)
        else:
            c.set_source_chain(t, t)
    for t in sorted(tgt_chains):
        say('log', 'chain %s <- %s' % (t, c.get_source_chain(t)))
    if root_motion == 'pelvis':
        for i in range(c.get_num_retarget_ops()):
            op = c.get_op_controller(i)
            if isinstance(op, unreal.IKRetargetRootMotionController):
                s = op.get_settings()
                s.set_editor_property('root_motion_source', unreal.RootMotionSource.GENERATE_FROM_TARGET_PELVIS)
                s.set_editor_property('root_height_source', unreal.RootMotionHeightSource.SNAP_TO_GROUND)
                # the root goes straight under the pelvis: keeping the ref-pose offset in the pelvis's frame swings
                # the root ~50 cm backwards when the pelvis pitches into a bend (measured on a floor pick-up)
                s.set_editor_property('maintain_offset_from_pelvis', False)
                # UNDERSTUDY_ROOT_YAW=1: a clip that TURNS the body -- the root takes the pelvis's yaw too, so the
                # capsule turns with it through root motion instead of the body snapping back when the clip ends.
                s.set_editor_property('rotate_with_pelvis', False)   # (rotating with the pelvis copies its full rotation, frame offset and twist included -- wrong for turns)
                op.set_settings(s)
                # the target IK rig's retarget root is usually the pelvis; root motion belongs on the skeleton's root
                op.set_target_root_bone(os.environ.get('UNDERSTUDY_TARGET_ROOT', 'root'))
                say('log', 'root motion: root %s follows target pelvis %s, snapped to ground'
                    % (op.get_target_root_bone(), op.get_target_pelvis_bone()))
    # Epic's mannequins carry IK bones (ik_foot_l/r, ik_hand_*) that their anim graphs aim Leg IK and
    # hand IK at. No chain maps them, so they stay at the reference pose under the root and ride with
    # it -- and Leg IK then drags planted feet along with the root motion (a planted pick-up
    # slid 13 cm). Pin each one to the bone it stands for, after everything else has run.
    pins = {'ik_foot_l': 'foot_l', 'ik_foot_r': 'foot_r', 'ik_hand_l': 'hand_l', 'ik_hand_r': 'hand_r', 'ik_hand_gun': 'hand_r'}
    pin_index = c.add_retarget_op('/Script/IKRig.IKRetargetPinBoneOp') if os.environ.get('UNDERSTUDY_PIN_IK', '') == '1' else -1
    if pin_index >= 0:
        pin = c.get_op_controller(pin_index)
        pin.clear_all_bone_pairs()
        for to_bone, from_bone in pins.items():
            pin.set_bone_pair(from_bone, to_bone)
        s = pin.get_settings()
        s.set_editor_property('skeleton_to_copy_from', unreal.RetargetSourceOrTarget.TARGET)
        s.set_editor_property('translation_mode', unreal.PinBoneTranslationMode.COPY_GLOBAL_POSITION)
        s.set_editor_property('rotation_mode', unreal.PinBoneRotationMode.COPY_GLOBAL_ROTATION)
        pin.set_settings(s)
        say('log', 'IK bones pinned: %s' % dict(pin.get_all_bone_pairs()))
    for i in range(c.get_num_retarget_ops()):
        say('log', 'op %d %s (%s)' % (i, c.get_op_name(i), type(c.get_op_controller(i)).__name__))
    if hand_goals:
        # Contact clips (pick-ups, pushes): the hands go where the source hands went. Plain FK on a body with other
        # proportions left a floor reach's wrist 14 cm higher on a UEFN mannequin than in the clip.
        for i in range(c.get_num_retarget_ops()):
            op = c.get_op_controller(i)
            if isinstance(op, unreal.IKRetargetIKChainsController):
                s = op.get_settings()
                chains_ik = list(s.get_editor_property('chains_to_retarget'))
                for ch in chains_ik:
                    if str(ch.get_editor_property('target_chain_name')) in ('LeftArm', 'RightArm'):
                        ch.set_editor_property('blend_to_source', 1.0)
                        ch.set_editor_property('blend_to_source_translation', 1.0)
                        say('log', 'hand goal %s follows the source hand' % ch.get_editor_property('target_chain_name'))
                s.set_editor_property('chains_to_retarget', chains_ik)
                op.set_settings(s)
    c.auto_align_all_bones(unreal.RetargetSourceOrTarget.TARGET)
    eal.save_loaded_asset(rtg)
    dest_dir = '%s/%s' % (content, target_mesh.get_name())
    dest = '%s/%s%s' % (dest_dir, prefix, name)
    if eal.does_asset_exist(dest):
        eal.delete_asset(dest)
    unreal.IKRetargetBatchOperation.duplicate_and_retarget(
        [eal.find_asset_data(source_anim.get_path_name().split('.')[0])], source_mesh, target_mesh, rtg,
        search=source_anim.get_name(), replace=prefix + name, target_path=dest_dir, use_source_path=False, include_referenced_assets=False)
    if not eal.does_asset_exist(dest):
        say('error', 'retarget produced nothing at ' + dest)
        raise SystemExit(1)
    final_anim = unreal.load_asset(dest)
    if root_motion == 'pelvis':
        final_anim.set_editor_property('enable_root_motion', True)
    say('asset', final_anim.get_path_name())

# 3. Markers become sync markers on the final sequence (named, visible in the editor and usable by sync groups).
if markers:
    track = 'Understudy'
    try:
        unreal.AnimationLibrary.add_animation_notify_track(final_anim, track)
    except Exception:
        pass
    for m in markers:
        unreal.AnimationLibrary.add_animation_sync_marker(final_anim, m['name'], float(m['frame']) / fps, track)
    say('log', '%d sync markers added' % len(markers))
# 4. Hand shapes become float curves HandShape_L / HandShape_R (-1 auto, 0 relaxed, 1 fist, 2 open, 3 point, 4 flat),
#    one key per frame where the shape changes; the game's finger rig reads them.
if hands.get('left'):
    try:
        for side, key in (('left', 'HandShape_L'), ('right', 'HandShape_R')):
            seq = hands.get(side) or []
            try:
                unreal.AnimationLibrary.add_curve(final_anim, key, unreal.RawCurveTrackTypes.RCT_FLOAT)
            except Exception:
                pass
            last = None
            for f, shape in enumerate(seq):
                v = HAND_VALUE.get(shape, -1.0)
                if v != last:
                    unreal.AnimationLibrary.add_float_curve_key(final_anim, key, float(f) / fps, v)
                    last = v
        say('log', 'hand shape curves added')
    except Exception as e:
        say('log', 'hand curves skipped: %s' % e)
eal.save_loaded_asset(final_anim)

# 4. FBX (skeleton + animation; headless export cannot carry the mesh).
if export_dir:
    out = os.path.join(export_dir, final_anim.get_name() + '.fbx')
    options = unreal.FbxExportOption()
    options.set_editor_property('ascii', False)
    options.set_editor_property('export_preview_mesh', False)
    options.set_editor_property('export_morph_targets', False)
    options.set_editor_property('map_skeletal_motion_to_root', False)
    et = unreal.AssetExportTask()
    et.object = final_anim
    et.filename = out
    et.automated = True
    et.replace_identical = True
    et.prompt = False
    et.options = options
    if unreal.Exporter.run_asset_export_task(et) and os.path.exists(out):
        say('fbx', out)
    else:
        say('log', 'FBX export failed')
say('done', final_anim.get_path_name())
