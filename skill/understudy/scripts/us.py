#!/usr/bin/env python3
"""us.py - drive Understudy (local text-to-motion workbench) from the command line.

Frames are 1-based everywhere in this script (as in the page and on frame sheets); the HTTP API is 0-based and the
script converts. A clip can be named by its id or by a unique start of its id. Python standard library only.

    us.py status                                   server up? jobs, models
    us.py generate "A person waves." --frames 120 --takes 4
    us.py show <clip>                              what the checks found, keys, markers, warnings
    us.py sheet <clip> --out sheet.png             stick-figure frame sheet (front + side) to look at
    us.py edit <clip> cleanup                      fix in place (undoable): cleanup, settle, loop, regen --from --to, ...
    us.py key <clip> --frame 40 --turn LeftArm=0,0,-60     key a pose change on the timeline
    us.py export <clip> --format skinned --out walk.glb

Run `us.py <command> -h` for the options of each command.
"""
import argparse, json, math, os, random, struct, sys, time, urllib.error, urllib.parse, urllib.request

BASE = os.environ.get('UNDERSTUDY_URL', 'http://127.0.0.1:8094').rstrip('/')
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding='utf-8')
    except Exception: pass

# ---------------------------------------------------------------- HTTP

def api(method, path, body=None, raw=False, timeout=900):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={'Content-Type': 'application/json'} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            b = r.read()
            return b if raw else (json.loads(b) if b.strip() else None)
    except urllib.error.HTTPError as e:
        sys.exit(f'error {e.code} from {method} {path}: {e.read().decode(errors="replace").strip()}')
    except urllib.error.URLError as e:
        sys.exit(f'Understudy is not answering at {BASE} ({e.reason}). See SKILL.md, "Start the server".')

def clips():
    d = api('GET', '/api/animations')
    return d if isinstance(d, list) else d.get('animations', d)

def find(ref, items=None):
    items = items if items is not None else clips()
    exact = [a for a in items if a['id'] == ref]
    if exact:
        return exact[0]
    pre = [a for a in items if a['id'].startswith(ref)]
    if len(pre) == 1:
        return pre[0]
    sys.exit(f'no clip "{ref}"' if not pre else f'"{ref}" matches {len(pre)} clips; give more of the id')

def out(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))

# ---------------------------------------------------------------- what the checks say

PART = {'lfoot': 'left foot', 'rfoot': 'right foot', 'lhand': 'left hand', 'rhand': 'right hand', 'ltoe': 'left toes', 'rtoe': 'right toes'}
def flag_text(f, m):
    g = lambda k, d=0: m.get(k) if m.get(k) is not None else d
    fr = lambda k: g(k) + 1
    return {
        'slide': f"{(m.get('slide_side') or '').lower()} foot slides {round(g('slide_m') * 100)} cm along the floor (frames {fr('slide_from')}-{fr('slide_to')}{', ' + str(g('slide_count')) + ' slides in all' if g('slide_count', 0) > 1 else ''}): a glide, not a step",
        'pivot': f"turns {round(g('pivot_deg'))} deg without stepping (frames {fr('pivot_from')}-{fr('pivot_to')}): the body spins on planted feet",
        'skate': f"foot slide {round(g('foot_skate') * 100)} %",
        'floor': f"{PART.get(m.get('floor_part'), m.get('floor_part') or 'body')} through the floor {round(-g('floor_m') * 100)} cm (frame {fr('floor_frame')})",
        'float': f"floats {round(g('float_gap_m') * 100)} cm over the floor",
        'foot_hover': f"{(m.get('foot_hover') or '').lower()} foot hovers {round(g('foot_hover_m') * 100)} cm while standing (frames {fr('foot_hover_from')}-{fr('foot_hover_to')})",
        'balance': f"off balance: weight {round(g('balance_out_m') * 100)} cm past the feet (frames {fr('balance_from')}-{fr('balance_to')})",
        'jitter': f"jitter in {m.get('jitter_joint') or 'a joint'} (peak {g('jitter_peak'):.0f})",
        'hover': f"ends in the air ({round(g('hover_m') * 100)} cm)",
        'hand_head': f"hand in face on {round(g('hand_head') * 100)} % of frames",
        'clip': f"self-clip {round(g('self_clip') * 100)} % ({', '.join(p.get('pair', '') for p in (m.get('clip_pairs') or [])[:3])})",
        'ballistic': f"floaty jump ({round(g('ballistic_m') * 100)} cm off gravity)",
        'action': f"misses the move: {'; '.join(m.get('action_notes') or []) or 'the prompt is not performed'}",
        'unsettled_end': f"ends mid-motion ({g('end_speed'):.2f} m/s)",
        'unsettled_start': f"starts mid-motion ({g('start_speed'):.2f} m/s)",
        'idle': f"{(g('idle_head') + g('idle_tail')) / 30:.1f} s of idle",
        'anatomy': f"{m.get('anatomy_joint') or 'a joint'} bent {round(g('anatomy_deg'))} deg past what a body can do (frame {fr('anatomy_frame')})",
    }.get(f, f)

FIX = {'slide': 'edit cleanup if under 8 cm, else edit regen --from/--to over the sliding frames (+6 either side); a long glide needs real steps', 'pivot': 'edit regen --from/--to over the turn (+6 either side): a real turn steps round',
       'floor': 'edit cleanup', 'skate': 'edit cleanup', 'float': 'edit cleanup', 'foot_hover': 'edit cleanup', 'clip': 'edit cleanup',
       'hand_head': 'edit cleanup', 'jitter': 'edit cleanup (or edit smooth)', 'balance': 'edit cleanup', 'anatomy': 'edit cleanup',
       'unsettled_end': 'edit settle', 'unsettled_start': 'edit regen --from 1 --to 12', 'idle': 'edit trim-idle (makes a copy)',
       'hover': 'edit settle', 'ballistic': 'edit arc', 'action': 'generate again with clearer words, or build it from poses (sequence)'}

def summary(a):
    m = a.get('metrics') or {}
    flags = m.get('flags') or []
    s = {'id': a['id'], 'name': a.get('name') or a.get('prompt', ''), 'status': a.get('status'), 'frames': a.get('frames'),
         'seconds': round((a.get('frames') or 0) / 30, 2), 'model': a.get('model'), 'project': a.get('project') or 'Inbox',
         'checks': 'clean' if a.get('status') == 'ready' and not flags else [{'flag': f, 'says': flag_text(f, m), 'fix': FIX.get(f, '')} for f in flags]}
    for k in ('verdict', 'warnings', 'error', 'progress', 'clean_up_error'):
        if a.get(k):
            s[k] = a[k]
    if a.get('layer'):
        s['keys'] = sorted(f"{k['part']}@{k['frame'] + 1}{':' + k['interp'] if k.get('interp') else ''}" for k in a['layer']['keys'])
        s['key_blend'] = a['layer'].get('blend')
    if a.get('markers'):
        s['markers'] = [f"{x['frame'] + 1} {x['name']}" for x in a['markers']]
    if a.get('props'):
        s['props'] = a['props']
    if a.get('edits'):
        s['undo_steps'] = a['edits']
    return s

# ---------------------------------------------------------------- skeleton (SOMA 30, the default models)

SOMA = ["Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head", "Jaw", "LeftEye", "RightEye", "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
        "LeftHandThumbEnd", "LeftHandMiddleEnd", "RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHandThumbEnd", "RightHandMiddleEnd",
        "LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase", "RightLeg", "RightShin", "RightFoot", "RightToeBase"]
SOMA_PARENTS = [-1, 0, 1, 2, 3, 4, 5, 6, 6, 6, 3, 10, 11, 12, 13, 13, 3, 16, 17, 18, 19, 19, 0, 22, 23, 24, 0, 26, 27, 28]
PARTS = ['body', 'spine', 'larm', 'rarm', 'lleg', 'rleg']

def part_of(j):
    under = lambda root: (lambda n: n == root or (SOMA_PARENTS[n] >= 0 and under(root)(SOMA_PARENTS[n])))
    name = SOMA[j]
    if j == 0: return 'body'
    for root, p in (('LeftShoulder', 'larm'), ('RightShoulder', 'rarm'), ('LeftLeg', 'lleg'), ('RightLeg', 'rleg')):
        if under(SOMA.index(root))(j): return p
    return 'spine'

def qmul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]

def qaxis(axis, deg):
    h = math.radians(deg) / 2
    return [axis[0] * math.sin(h), axis[1] * math.sin(h), axis[2] * math.sin(h), math.cos(h)]

def streams(cid, frames):
    root = api('GET', f'/api/animations/{cid}/root.f32', raw=True)
    rot = api('GET', f'/api/animations/{cid}/rotations.f32', raw=True)
    r = struct.unpack(f'<{len(root) // 4}f', root); q = struct.unpack(f'<{len(rot) // 4}f', rot)
    joints = len(q) // 4 // frames
    return [list(r[f * 3:f * 3 + 3]) for f in range(frames)], [[list(q[(f * joints + j) * 4:(f * joints + j + 1) * 4]) for j in range(joints)] for f in range(frames)]

# ---------------------------------------------------------------- commands

def cmd_status(a):
    jobs = api('GET', '/api/jobs')
    models = api('GET', '/api/models')
    items = clips()
    out({'server': BASE, 'up': True, 'jobs_running': [j for j in jobs if j.get('status') not in ('done', 'failed')],
         'models': [m['id'] for m in models], 'clips': len([c for c in items if not c.get('trashed')]),
         'generating': [c['id'] for c in items if c.get('status') not in ('ready', 'failed') and not c.get('trashed')]})

def cmd_list(a):
    items = [c for c in clips() if bool(c.get('trashed')) == a.trashed]
    if a.search: items = [c for c in items if a.search.lower() in (c.get('name', '') + ' ' + c.get('prompt', '')).lower()]
    if a.project is not None: items = [c for c in items if (c.get('project') or '') == a.project]
    items.sort(key=lambda c: c.get('created_at', ''), reverse=True)
    for c in items[:a.limit]:
        flags = (c.get('metrics') or {}).get('flags') or []
        print(f"{c['id']}  {c.get('frames', 0):4d}f  {c.get('status', ''):8s}  {('clean' if not flags else ','.join(flags))[:40]:40s}  {c.get('name') or c.get('prompt', '')[:60]}")

def cmd_show(a):
    out(summary(find(a.clip)))

def wait_for(ids, timeout):
    t0, last = time.time(), ''
    while True:
        items = {c['id']: c for c in clips()}
        st = [items.get(i, {}) for i in ids]
        line = ' | '.join(f"{c.get('id', '?')[:8]} {c.get('status')} {c.get('progress', '')}".strip() for c in st)
        if line != last: print(line, file=sys.stderr); last = line
        if all(c.get('status') in ('ready', 'failed') for c in st): return st
        if time.time() - t0 > timeout: sys.exit(f'still generating after {timeout} s: {line}')
        time.sleep(3)

def cmd_generate(a):
    segs = [{'prompt': a.prompt, 'frames': a.frames}]
    for t in a.then or []:
        p, _, f = t.rpartition(':')
        segs.append({'prompt': p if f.isdigit() else t, 'frames': int(f) if f.isdigit() else a.frames})
    for s in segs:
        if not 60 <= s['frames'] <= 360: sys.exit('each part is 60..360 frames (30 frames = 1 s)')
    seed = a.seed if a.seed is not None else random.randrange(1, 2 ** 31)
    batch = '%016x' % random.getrandbits(64) if a.takes > 1 else ''
    ids = []
    for i in range(a.takes):
        body = {'prompt': segs[0]['prompt'], 'segments': segs, 'steps': a.steps, 'seed': seed + i, 'transition_frames': 5,
                'text_cfg': a.cfg, 'post_processing': True, 'clean_wrists': True, 'clean_hands': True, 'ground_hands': True, 'ground_feet': True,
                'smooth_jitter': False, 'clean_up': not a.raw, 'finish_settled': not a.raw, 'action_retries': 0 if a.raw else 3, 'start_standing': bool(a.start_standing) and not a.raw,
                'project': a.project or '', 'folder': a.folder or '', 'name': a.name or ''}
        if a.model: body['model'] = a.model
        if a.takes > 1: body.update({'batch': batch, 'take': i + 1, 'takes': a.takes})
        ids.append(api('POST', '/api/generate', body)['id'])
    print(f"submitted {len(ids)} take(s): {' '.join(ids)}", file=sys.stderr)
    if a.no_wait:
        out({'ids': ids}); return
    done = wait_for(ids, a.timeout)
    ranked = sorted(done, key=lambda c: (c.get('status') != 'ready', len((c.get('metrics') or {}).get('flags') or [])))
    out({'best': summary(ranked[0]), 'others': [{'id': c['id'], 'checks': summary(c)['checks']} for c in ranked[1:]]})

def resolve_pose(spec, poses):
    name, *opts = spec.split('|')
    hit = [p for p in poses if p['id'] == name] or [p for p in poses if p['name'].lower() == name.lower()] or [p for p in poses if name.lower() in p['name'].lower()]
    if len(hit) != 1: sys.exit(f'pose "{name}": {"no match" if not hit else "matches " + ", ".join(p["name"] for p in hit)} (us.py poses lists them)')
    item = {'id': hit[0]['id']}
    for o in opts:
        k, _, v = o.partition('=')
        item[k.strip()] = v.strip() if k.strip() == 'onto' else float(v)
    return item

def parse_box(spec):
    size, _, at = spec.partition('@')
    w, h, d = (float(x) for x in size.split(','))
    xz = [float(x) for x in at.split(',')] if at else [0, 0.7]
    return {'kind': 'box', 'name': 'box', 'pos': [xz[0], 0.02, xz[1]], 'size': [w, h, d], 'yaw': math.radians(xz[2]) if len(xz) > 2 else 0}

def cmd_poses(a):
    for p in api('GET', '/api/poses'): print(f"{p['id']}  {p['name']}")

def cmd_sequence(a):
    poses = api('GET', '/api/poses')
    body = {'name': a.name or '', 'project': a.project or '', 'poses': [resolve_pose(s, poses) for s in a.poses], 'props': [parse_box(b) for b in a.box or []]}
    if a.model: body['model'] = a.model
    if a.raw: body['clean_up'] = False
    if len(body['poses']) < 2: sys.exit('a sequence needs at least two poses (the first is the start)')
    r = api('POST', '/api/animations/sequence', body)
    out(summary(r) if isinstance(r, dict) and 'id' in r else r)

OPS = {'cleanup': 'cleanup', 'settle': 'mb_settle', 'loop': 'mb_loop', 'regen': 'mb_regen', 'smooth': 'smooth', 'floor': 'floor', 'ground': 'ground',
       'wrists': 'wrists', 'hands': 'hands', 'tween': 'tween', 'mirror-range': 'mirror_range', 'arc': 'arc', 'revert': 'revert',
       'mirror': 'mirror', 'retime': 'retime', 'trim-idle': 'trim_idle', 'trim': 'trim', 'undo': 'undo_pose', 'redo': 'redo_pose',
       'regen-next': 'mb_regen_next'}   # regen-next: the next of the last regenerate's runner-ups (regen keeps the best of several)
COPY_OPS = {'mirror', 'retime', 'trim_idle', 'trim'}   # trim: a copy cut to --from/--to   # these make a new clip; the rest change the clip in place (undoable)

def cmd_edit(a):
    c = find(a.clip); op = OPS[a.op]
    body = {'op': op, 'in_place': op not in COPY_OPS}
    if a.from_ is not None: body['from'] = a.from_ - 1
    if a.to is not None: body['to'] = a.to - 1
    if a.amount is not None: body['amount'] = a.amount
    if a.speed is not None: body['speed'] = a.speed
    if a.strength is not None: body['strength'] = a.strength
    if a.keep_snap: body['keep_snap'] = True
    if a.tokens is not None: body['tokens'] = a.tokens
    if a.no_clean: body['no_clean'] = True
    if op in ('mb_regen', 'tween', 'mirror_range', 'trim') and ('from' not in body or 'to' not in body): sys.exit(f'{a.op} needs --from and --to')
    if op == 'tween' and 'amount' not in body: body['amount'] = 0.6
    if op == 'retime' and 'speed' not in body: sys.exit('retime needs --speed (0.25..4)')
    r = api('POST', f"/api/animations/{c['id']}/derive", body)
    sm = summary(r)
    if r.get('edit_note'): sm['note'] = r['edit_note']
    if r.get('regen_alts'): sm['other_versions'] = r['regen_alts']
    out(sm)

def layer_post(c, keys, blend=None):
    blend = blend if blend is not None else ((c.get('layer') or {}).get('blend', 12))
    return api('POST', f"/api/animations/{c['id']}/derive", {'op': 'layer', 'in_place': True, 'layer': {'keys': keys, 'blend': blend}})

def cmd_keys(a):
    c = find(a.clip)
    l = c.get('layer') or {'keys': [], 'blend': 12}
    out({'blend': l.get('blend'), 'keys': [{'frame': k['frame'] + 1, 'part': k['part'], 'interp': k.get('interp') or 'smooth'} for k in sorted(l['keys'], key=lambda k: (k['frame'], k['part']))]})

def cmd_key(a):
    c = find(a.clip)
    if not (c.get('model') or '').startswith('soma'): sys.exit('us.py key works on SOMA clips (the default models); use the API for others')
    n = c['frames']; f = a.frame - 1
    if not 0 <= f < n: sys.exit(f'frame {a.frame} is outside 1..{n}')
    roots, rots = streams(c['id'], n)
    src = (a.from_frame - 1) if a.from_frame else f
    pose_root, pose = list(roots[f]), [list(r) for r in rots[src]]
    touched = set()
    if a.from_pose:
        p = resolve_pose(a.from_pose, api('GET', '/api/poses'))
        full = [x for x in api('GET', '/api/poses') if x['id'] == p['id']][0]
        pose = [list(r) for r in full['rotations']]
        if full.get('root'): pose_root[1] = full['root'][1]
        touched |= set(PARTS)
    if a.from_frame: touched |= set(PARTS)
    for t in a.turn or []:
        name, _, xyz = t.partition('=')
        if name not in SOMA: sys.exit(f'unknown joint {name} (us.py joints lists them)')
        j = SOMA.index(name); x, y, z = (float(v) for v in xyz.split(','))
        pose[j] = qmul(pose[j], qmul(qmul(qaxis([1, 0, 0], x), qaxis([0, 1, 0], y)), qaxis([0, 0, 1], z)))
        touched.add(part_of(j))
    if a.move_hips:
        d = [float(v) for v in a.move_hips.split(',')]
        pose_root = [pose_root[i] + d[i] for i in range(3)]; touched.add('body')
    parts = PARTS if a.parts == 'all' else (a.parts.split(',') if a.parts else sorted(touched))
    if not parts: sys.exit('nothing to key: give --turn, --move-hips, --from-frame, --from-pose or --parts')
    for p in parts:
        if p not in PARTS: sys.exit(f'part {p}: one of {", ".join(PARTS)}')
    old = [k for k in (c.get('layer') or {}).get('keys', []) if not (k['frame'] == f and k['part'] in parts)]
    new = [{'frame': f, 'part': p, 'rotations': pose, **({'root': pose_root} if p == 'body' else {}), **({'interp': a.interp} if a.interp and a.interp != 'smooth' else {})} for p in parts]
    out(summary(layer_post(c, old + new)))

def cmd_unkey(a):
    c = find(a.clip); f = a.frame - 1; parts = a.parts.split(',') if a.parts else PARTS
    keys = (c.get('layer') or {}).get('keys', [])
    left = [k for k in keys if not (k['frame'] == f and k['part'] in parts)]
    if len(left) == len(keys): sys.exit(f'no keys at frame {a.frame}')
    out(summary(layer_post(c, left)))

def cmd_movekey(a):
    c = find(a.clip); f, t = a.frame - 1, a.to - 1; parts = a.parts.split(',') if a.parts else PARTS
    keys = (c.get('layer') or {}).get('keys', [])
    moved = [dict(k, frame=t) for k in keys if k['frame'] == f and k['part'] in parts]
    if not moved: sys.exit(f'no keys at frame {a.frame}')
    ids = {(k['part'], t) for k in moved}
    rest = [k for k in keys if not (k['frame'] == f and k['part'] in parts) and (k['part'], k['frame']) not in ids]
    out(summary(layer_post(c, rest + moved)))

def cmd_blend(a):
    c = find(a.clip); out(summary(layer_post(c, (c.get('layer') or {}).get('keys', []), a.frames)))

def cmd_joints(a):
    for j, n in enumerate(SOMA): print(f"{n:20s} part={part_of(j):5s} parent={SOMA[SOMA_PARENTS[j]] if SOMA_PARENTS[j] >= 0 else '-'}")

def cmd_sheet(a):
    c = find(a.clip); q = {'views': a.views, 'tile': a.tile}
    if a.frames: q['frames'] = ','.join(str(int(x) - 1) for x in a.frames.split(','))
    if a.from_ is not None: q['from'] = a.from_ - 1
    if a.to is not None: q['to'] = a.to - 1
    if a.every: q['every'] = a.every
    png = api('GET', f"/api/animations/{c['id']}/sheet.png?" + urllib.parse.urlencode(q), raw=True)
    path = a.out or f"understudy_{c['id'][:8]}_sheet.png"
    open(path, 'wb').write(png); print(os.path.abspath(path))

EXPORT = {'glb': ('animation.glb', '.glb'), 'skinned': ('skinned.glb', '-skinned.glb'), 'bvh': ('animation.bvh', '.bvh'), 'pack': ('pack', '.understudy')}
def cmd_export(a):
    c = find(a.clip); path, ext = EXPORT[a.format]
    data = api('GET', f"/api/animations/{c['id']}/{path}", raw=True)
    dest = a.out or ((c.get('name') or c['id']).replace(' ', '-').replace('/', '-') + ext)
    open(dest, 'wb').write(data); print(os.path.abspath(dest))

def cmd_patch(a):
    c = find(a.clip); body = {}
    if a.name is not None: body['name'] = a.name
    if a.project is not None: body['project'] = a.project
    if a.folder is not None: body['folder'] = a.folder
    if a.tags is not None: body['tags'] = [t for t in a.tags.split(',') if t]
    if a.favorite is not None: body['favorite'] = a.favorite == 'yes'
    out(summary(api('PATCH', f"/api/animations/{c['id']}", body)))

def cmd_marker(a):
    c = find(a.clip); ms = list(c.get('markers') or [])
    if a.remove: ms = [m for m in ms if m['frame'] != a.frame - 1]
    else: ms.append({'frame': a.frame - 1, 'name': a.name or 'mark'})
    out(summary(api('PATCH', f"/api/animations/{c['id']}", {'markers': ms})))

def cmd_trash(a):
    items = clips(); ids = [find(r, items)['id'] for r in a.clips]
    out(api('POST', '/api/animations/batch', {'ids': ids, 'delete': True}))

def cmd_restore(a):
    items = clips(); ids = [find(r, items)['id'] for r in a.clips]
    out(api('POST', '/api/animations/batch', {'ids': ids, 'patch': {'trashed': False}}))

def cmd_unreal(a):
    c = find(a.clip); job = api('POST', f"/api/animations/{c['id']}/pipeline", {})
    jid = (job or {}).get('id')
    if not jid or a.no_wait: out(job); return
    t0 = time.time()
    while time.time() - t0 < a.timeout:
        j = api('GET', f'/api/jobs/{jid}')
        if j.get('status') in ('done', 'failed'): out(j); return
        time.sleep(3)
    sys.exit(f'Unreal job {jid} still running after {a.timeout} s')

def cmd_mocap(a):
    """Video -> tracked motion (GEM-X) -> a clip as it is (+ Clean up). The timing and speed are the video's."""
    st = api('GET', '/api/mocap/gemx')
    if not st.get('enabled'): sys.exit('GEM-X is not enabled on the server (start it with -gemx <folder>)')
    data = open(a.video, 'rb').read()
    req = urllib.request.Request(BASE + '/api/mocap/gemx?name=' + urllib.parse.quote(os.path.basename(a.video)), data=data, method='POST', headers={'Content-Type': 'video/mp4'})
    try: job = json.load(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as e: sys.exit(f'tracking refused: {e.read().decode(errors="replace").strip()}')
    print('tracking job', job['id'], file=sys.stderr); t0 = time.time()
    while True:
        j = api('GET', f"/api/mocap/gemx/{job['id']}")
        if j.get('status') in ('done', 'failed'): break
        if time.time() - t0 > a.timeout: sys.exit('tracking still running after %d s' % a.timeout)
        time.sleep(3)
    if j.get('status') != 'done': sys.exit('tracking failed: ' + str(j.get('error') or (j.get('log') or [''])[-1]))
    rot = api('GET', f"/api/mocap/gemx/{job['id']}/rot.json")
    if a.save_track: json.dump(rot, open(a.save_track, 'w')); print('track saved to', a.save_track, file=sys.stderr)
    order = [rot['names'].index(n) for n in SOMA]
    root = [list(r) for r in rot['root']]; rots = [[list(fr[i]) for i in order] for fr in rot['rot']]
    # the page's floor lift: the lowest hips frame... keep it simple: Clean up puts the feet on the floor
    name = a.name or (os.path.splitext(os.path.basename(a.video))[0] + ' · from video')
    made = api('POST', '/api/animations/import', {'name': name, 'project': a.project or '', 'model': 'soma-rp-v1.2', 'prompt': a.prompt or '', 'tags': ['mocap', 'tracked'], 'root': root, 'rotations': rots})
    if not a.raw: made = api('POST', f"/api/animations/{made['id']}/derive", {'op': 'cleanup', 'in_place': True, 'keep_snap': True})   # tracked motion keeps its speed and snap
    print(f"tracked {rot['frames']} frames in {time.time() - t0:.0f} s", file=sys.stderr)
    out(summary(made))

def cmd_wait(a):
    items = clips(); out([summary(c) for c in wait_for([find(r, items)['id'] for r in a.clips], a.timeout)])

# ---------------------------------------------------------------- arguments

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest='cmd', required=True)
    def sub(name, fn, help):
        p = sp.add_parser(name, help=help, description=help); p.set_defaults(fn=fn); return p
    sub('status', cmd_status, 'Is the server up; running jobs; models.')
    p = sub('list', cmd_list, 'Clips, newest first: id, frames, status, check flags, name.')
    p.add_argument('--search'); p.add_argument('--project'); p.add_argument('--limit', type=int, default=30); p.add_argument('--trashed', action='store_true')
    p = sub('show', cmd_show, 'One clip: what the checks found (with the fix to try), keys, markers, warnings.'); p.add_argument('clip')
    p = sub('generate', cmd_generate, 'Generate a clip from words (waits; prints the cleanest take).')
    p.add_argument('prompt'); p.add_argument('--frames', type=int, default=150, help='60..360 (30 = 1 s)')
    p.add_argument('--then', action='append', help='a next part "words:frames" in the same clip (repeatable)')
    p.add_argument('--takes', type=int, default=1, help='seeds generated together; the cleanest is reported first')
    p.add_argument('--seed', type=int); p.add_argument('--steps', type=int, default=50); p.add_argument('--cfg', type=float, default=2.0)
    p.add_argument('--model', help='default soma-rp-v1.2 (us.py status lists them)'); p.add_argument('--name'); p.add_argument('--project'); p.add_argument('--folder')
    p.add_argument('--raw', action='store_true', help='no Clean up / settle / retries (the model as it came)')
    p.add_argument('--start-standing', action='store_true', help='pin a neutral standing pose on the first frames (off by default since 2026-10-29: it kept the first seconds generic)')
    p.add_argument('--no-start-standing', action='store_true', help='(the default now; kept so old commands still work)')
    p.add_argument('--no-wait', action='store_true'); p.add_argument('--timeout', type=int, default=1200)
    sub('poses', cmd_poses, 'Saved poses (id and name) for sequences and keys.')
    p = sub('sequence', cmd_sequence, 'A clip through saved poses in order (MotionBricks), e.g. "standing" "seated on a box|onto=sit|hold=1.5" "standing".')
    p.add_argument('poses', nargs='+', help='pose name (or a unique part of it), with |onto=sit or hands, |hold=SECONDS, |turn=DEGREES')
    p.add_argument('--box', action='append', help='a box prop "W,H,D[@X,Z[,YAWDEG]]" in metres (default 0.7 m ahead)')
    p.add_argument('--name'); p.add_argument('--project'); p.add_argument('--model'); p.add_argument('--raw', action='store_true')
    p = sub('edit', cmd_edit, 'Fix or change a clip. In place and undoable unless the op makes a copy (mirror, retime, trim-idle).')
    p.add_argument('clip'); p.add_argument('op', choices=sorted(OPS))
    p.add_argument('--from', dest='from_', type=int, help='first frame (regen, tween, mirror-range)'); p.add_argument('--to', type=int, help='last frame')
    p.add_argument('--amount', type=float, help='tween 0..1 (default 0.6)'); p.add_argument('--speed', type=float, help='retime 0.25..4')
    p.add_argument('--strength', type=float, help='cleanup 0..1, how tightly the physics body follows (default 0.95)')
    p.add_argument('--keep-snap', action='store_true', help='cleanup: keep the clip speed and snap as they are (for tracked motion; on generated clips it keeps shakes too)')
    p.add_argument('--tokens', type=int, help='regen/settle/loop: force the generated length'); p.add_argument('--no-clean', action='store_true', help='regen/settle/loop: skip the Clean up after')
    p = sub('keys', cmd_keys, 'The timeline keys on a clip.'); p.add_argument('clip')
    p = sub('key', cmd_key, 'Key a pose on the timeline at a frame (one undoable edit).')
    p.add_argument('clip'); p.add_argument('--frame', type=int, required=True)
    p.add_argument('--turn', action='append', help='JOINT=x,y,z degrees, turned in the joint\'s own axes (repeatable; us.py joints lists them)')
    p.add_argument('--move-hips', help='dx,dy,dz metres (keys the body)'); p.add_argument('--from-frame', type=int, help='take the whole pose from this frame')
    p.add_argument('--from-pose', help='take the whole pose from a saved pose'); p.add_argument('--parts', help='body,spine,larm,rarm,lleg,rleg or all (default: the parts changed)')
    p.add_argument('--interp', choices=['smooth', 'linear', 'hold'], help='how this key goes to the next one')
    p = sub('unkey', cmd_unkey, 'Remove keys at a frame.'); p.add_argument('clip'); p.add_argument('--frame', type=int, required=True); p.add_argument('--parts')
    p = sub('movekey', cmd_movekey, 'Move the keys at a frame to another frame.'); p.add_argument('clip'); p.add_argument('--frame', type=int, required=True); p.add_argument('--to', type=int, required=True); p.add_argument('--parts')
    p = sub('blend', cmd_blend, 'Frames the keys ease in before the first key and out after the last.'); p.add_argument('clip'); p.add_argument('frames', type=int)
    sub('joints', cmd_joints, 'SOMA joint names and the timeline part each belongs to.')
    p = sub('sheet', cmd_sheet, 'Save a stick-figure frame sheet PNG (look at it: that is how to check a clip).')
    p.add_argument('clip'); p.add_argument('--out'); p.add_argument('--views', default='front,side', help='front, side, back, left, top, three')
    p.add_argument('--every', type=int); p.add_argument('--from', dest='from_', type=int); p.add_argument('--to', type=int); p.add_argument('--frames', help='a list: 1,20,40'); p.add_argument('--tile', type=int, default=240)
    p = sub('export', cmd_export, 'Save the clip: glb (skeleton), skinned (for Unreal/Blender), bvh, pack (.understudy share file).')
    p.add_argument('clip'); p.add_argument('--format', choices=sorted(EXPORT), default='skinned'); p.add_argument('--out')
    p = sub('patch', cmd_patch, 'Rename or file a clip.'); p.add_argument('clip'); p.add_argument('--name'); p.add_argument('--project'); p.add_argument('--folder'); p.add_argument('--tags'); p.add_argument('--favorite', choices=['yes', 'no'])
    p = sub('marker', cmd_marker, 'Add (or --remove) a named marker at a frame.'); p.add_argument('clip'); p.add_argument('--frame', type=int, required=True); p.add_argument('--name'); p.add_argument('--remove', action='store_true')
    p = sub('trash', cmd_trash, 'Move clips to the Trash (files kept; restore brings them back).'); p.add_argument('clips', nargs='+')
    p = sub('restore', cmd_restore, 'Bring clips back from the Trash.'); p.add_argument('clips', nargs='+')
    p = sub('unreal', cmd_unreal, 'Send to Unreal (the clip\'s project needs Pipeline settings in the page).'); p.add_argument('clip'); p.add_argument('--no-wait', action='store_true'); p.add_argument('--timeout', type=int, default=900)
    p = sub('mocap', cmd_mocap, 'Video -> animation: track the person (GEM-X, ~1.5 s of compute per second of video) and make a clip from the tracked motion as it is, then Clean up. For a Kimodo-regenerated version use the page (Refs > Track with GEM-X > Generate); it smooths fast strikes.')
    p.add_argument('video'); p.add_argument('--name'); p.add_argument('--project'); p.add_argument('--prompt', help='what the person does (stored with the clip)')
    p.add_argument('--raw', action='store_true', help='no Clean up after'); p.add_argument('--save-track', help='also save the tracked motion JSON here'); p.add_argument('--timeout', type=int, default=900)
    p = sub('wait', cmd_wait, 'Wait for clips that are still generating.'); p.add_argument('clips', nargs='+'); p.add_argument('--timeout', type=int, default=1200)
    a = ap.parse_args(); a.fn(a)

if __name__ == '__main__':
    main()
