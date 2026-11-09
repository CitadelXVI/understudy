"""Splice a MotionBricks in-between into a clip and import the result into Understudy.
Usage: mb_splice.py <clip id> <ctx_last> <tgt_first> [tokens|auto] [name]   (frames 0-based; gap = tgt_first - ctx_last - 1)"""
import os, sys, json, urllib.request, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import mb

cid, a, b = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
tokens = sys.argv[4] if len(sys.argv) > 4 else 'gap'
name = sys.argv[5] if len(sys.argv) > 5 else f'MB test · {cid[:8]} f{a + 1}-{b + 1}'
sk = mb.load_skeleton(); roots, rots = mb.load_clip(cid)
ctx = [a - 3, a - 2, a - 1, a]; tgt = [b, b + 1, b + 2, b + 3]; tgt = [f for f in tgt if f < len(roots)]
gap = b - a - 1
if tokens == 'gap':
    t = (gap + 6) // 4; tok = max(6, min(16, t))
elif tokens == 'auto':
    tok = None
else:
    tok = int(tokens)
s = mb.Session()
gr, gq, contacts, nt = mb.inbetween(s, sk, roots, rots, ctx, tgt, tokens=tok)
# the generated motion starts AT the last context pose and ends AT the first target pose: drop those two ends when
# splicing, so the clip keeps its own frames a and b
mid_r, mid_q = gr[1:-1], gq[1:-1]
R_ = np.concatenate([roots[:a + 1], mid_r, roots[b:]]); Q_ = np.concatenate([rots[:a + 1], mid_q, rots[b:]])
meta = json.load(open(os.path.join(mb.REPO, 'demo-output', cid + '.json'), encoding='utf-8'))
body = {'name': name, 'project': 'fixes-check', 'model': meta.get('model', 'soma-rp-v1.2'), 'prompt': meta.get('prompt', ''),
        'tags': ['motionbricks'], 'root': R_.tolist(), 'rotations': Q_.tolist()}
r = urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8094/api/animations/import', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST'), timeout=120)
out = json.load(r); m = out.get('metrics') or {}
print(json.dumps({'id': out['id'], 'frames': out.get('frames'), 'gap': gap, 'generated': len(gr), 'tokens': nt, 'flags': m.get('flags'), 'jitter_peak': m.get('jitter_peak'), 'floor_m': m.get('floor_m')}))
