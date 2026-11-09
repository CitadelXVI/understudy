"""move_keys.json for the server: whole-body key poses of planned moves (turns in place per angle; side steps per
direction and step count), from build_turn.py and the Starter standing pose."""
import json, os, subprocess, sys
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PY = os.environ.get('MOTIONBRICKS_PYTHON', os.path.join(os.environ.get('MOTIONBRICKS', os.path.join(REPO, 'motionbricks')), '.venv-ort', 'Scripts', 'python.exe'))
out = {'about': 'Planned-move key poses (fullbody constraints). Turns: key = angle in degrees (+ = left). Side steps: side_left_N / side_right_N. Kneels: kneel_<knee>_<clip frames>_<rise|stay>. Made by tools/turnplan/precompute_turns.py from build_turn.py and the Starter standing pose. Frames index the clip; frames 0-3 are the standing start the server adds.',
       'lift_m': 0.10, 'plans': {}}
jobs = [(str(d), [str(d)]) for d in (45, 90, 135, 180, -45, -90, -135, -180)]
jobs += [(f'side_{d}_{n}', [f'side_{d}', str(n)]) for d in ('left', 'right') for n in (1, 2, 3, 4)]
jobs += [(f'kneel_{k}_{f}_{m}', [f'kneel_{k}_{f}_{m}']) for k in ('left', 'right') for f in (90, 120, 150, 180) for m in ('rise', 'stay')]
jobs += [('walkstart_left', ['walkstart_left'])]
jobs += [('stagger', ['stagger'])]
jobs += [(f'kick_{l}_{h}', [f'kick_{l}_{h}']) for l in ('left', 'right') for h in ('high', 'mid')]
def step_names(key, n):
    """what each key pose is, in plain words, for the Guide list"""
    if key == 'stagger':
        names = ['Standing', 'Hit: chest and head thrown back', 'Right foot lifts back', 'Right foot catches', 'Left foot lifts back', 'Left foot catches', 'Balanced again', 'Balanced again']
    elif key.startswith('kick_'):
        _, l, h = key.split('_'); leg, stand = ('Left', 'Right') if l == 'left' else ('Right', 'Left')
        names = [f'Weight onto the {stand.lower()} foot', f'{leg} knee comes up', f'{leg} leg kicks out', f'{leg} knee pulls back', f'{leg} foot comes down', 'Standing', 'Standing']
    elif key.startswith('walkstart'):
        names = ['Weight shifts', 'Left foot lifts', 'Left foot steps forward', 'Right foot swings through', 'Right foot steps forward']
    elif key.startswith('side_'):
        _, d, k = key.split('_'); lead, other = ('Left', 'Right') if d == 'left' else ('Right', 'Left')
        names = ['Weight shifts']
        for i in range(int(k)):
            names += [f'{lead} foot lifts', f'{lead} foot steps out', f'{other} foot lifts', f'{other} foot closes in']
        names += ['Standing', 'Standing']
    elif key.startswith('kneel_'):
        _, k, f, m = key.split('_'); back, front = ('Right', 'Left') if k == 'right' else ('Left', 'Right')
        names = [f'Weight onto the {front.lower()} foot', f'{back} foot steps back', 'Lunge', f'{back} knee down', 'Still kneeling']
        if m == 'rise':
            names += ['Coming up', f'{back} foot steps back in', 'Standing', 'Standing', 'Standing']
    else:
        deg = int(key); lead, other = ('Left', 'Right') if deg > 0 else ('Right', 'Left')
        if abs(deg) >= 135:
            names = ['Head turns, weight shifts', f'{lead} foot lifts', f'{lead} foot steps open', f'{other} foot lifts', f'{other} foot comes round',
                     f'{lead} foot lifts', f'{lead} foot squares up', 'Standing, turned', 'Standing, turned']
        else:
            names = ['Head turns, weight shifts', f'{lead} foot lifts', f'{lead} foot steps round', f'{other} foot lifts', f'{other} foot follows',
                     'Standing, turned', 'Standing, turned']
    names = (names + ['Key'] * n)[:n]
    return names


for key, args in jobs:
    subprocess.run([PY, 'build_turn.py', args[0], 'full', 'tmp_plan.json', '0.10'] + args[1:], check=True, capture_output=True)
    c = json.load(open('tmp_plan.json'))[1]
    out['plans'][key] = {'names': step_names(key, len(c['frame_indices'])), 'frames': c['frame_indices'], 'root_positions': [[round(x, 5) for x in r] for r in c['root_positions']],
                         'rotations': [[[round(x, 6) for x in q] for q in pose] for pose in c['local_joints_rot_xyzw']]}
    print(key, c['frame_indices'][-1])
json.dump(out, open(os.path.join(REPO, 'move_keys.json'), 'w'), separators=(',', ':'))
