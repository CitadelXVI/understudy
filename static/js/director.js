// The director: a scene prompt ("Actor 1 throws a spinning kick at Actor 2.
// Actor 2 catches the kick and counters with a punch.") becomes one clip per
// actor, placed and timed against each other, with contacts pinned and
// regenerated so hands land where they should. Everything it does is a thing
// the user could do by hand in the Actors tab; it just does it in order.
import * as viewer from './viewer.js';
import * as library from './library.js';
import * as compose from './compose.js';
import * as scene from './scene.js';
import * as keep from './keep.js';
import * as handles from './handles.js';

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const journal = [];
const log = m => { journal.push(`${new Date().toISOString().slice(11, 19)} ${m}`); console.info('director:', m); };
const CONTACT = /\b(catch|catches|grab|grabs|block|blocks|parr(y|ies)|hold|holds|push|pushes|shove|shoves|lock|locks|clinch|tackle|tackles|throw|throws)\b/i;

// Sentences grouped by the actor they are about (the first "Actor N" in the sentence), in order of appearance.
export function parse(text) {
  const lines = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean)) {
    const m = /\bactor\s*(\d+)\b/i.exec(sentence); if (!m) continue;
    const n = Number(m[1]);
    let line = lines.find(l => l.actor === n);
    if (!line) { line = { actor: n, text: '', mentions: new Set() }; lines.push(line); }
    line.text = (line.text + ' ' + sentence).trim();
    for (const mm of sentence.matchAll(/\bactor\s*(\d+)\b/gi)) if (Number(mm[1]) !== n) line.mentions.add(Number(mm[1]));
  }
  return lines;
}
export function isScene(text) { return parse(text).length >= 2; }

// Joint positions of every frame of a clip, from its streams.
function fkAll(root, rotations, parents, offsets) {
  const joints = parents.length, frames = root.length / 3, out = [];
  for (let f = 0; f < frames; f++) {
    const pos = [], g = [];
    for (let j = 0; j < joints; j++) {
      const q = Array.from(rotations.subarray((f * joints + j) * 4, (f * joints + j + 1) * 4)), p = parents[j];
      if (p < 0) { g[j] = q; pos[j] = [root[f * 3], root[f * 3 + 1], root[f * 3 + 2]]; }
      else { g[j] = viewer.multiply(g[p], q); const o = offsets[j], r = viewer.rotate(g[p], o); pos[j] = [pos[p][0] + r[0], pos[p][1] + r[1], pos[p][2] + r[2]]; }
    }
    out.push(pos);
  }
  return out;
}
const headingOf = q => { const [x, y, z, w] = q; return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y)); };

// The beat of a clip: the frame (in its middle 70 %) where a hand or foot moves fastest, and which one.
function beatOf(pos, names) {
  const effs = ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'].map(n => names.indexOf(n)).filter(i => i >= 0);
  const n = pos.length, a = Math.floor(n * .15), b = Math.ceil(n * .85);
  let best = { frame: Math.floor(n / 2), joint: effs[0], speed: 0 };
  for (let f = Math.max(1, a); f < Math.min(n - 1, b); f++) for (const j of effs) {
    const p = pos[f - 1][j], q = pos[f + 1][j], v = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) * 15;
    if (v > best.speed) best = { frame: f, joint: j, speed: v };
  }
  // the strike lands a few frames after peak speed: take the frame where that effector is furthest from the hips
  const hips = names.indexOf('Hips'); let land = best.frame, far = 0;
  for (let f = best.frame; f < Math.min(n, best.frame + 8); f++) { const d = Math.hypot(pos[f][best.joint][0] - pos[f][hips][0], pos[f][best.joint][2] - pos[f][hips][2]); if (d > far) { far = d; land = f; } }
  return { ...best, land, reach: far };
}

async function generateFor(actorN, prompt, frames, project, leadIn) {
  const base = compose.request(project, library.currentFolder());
  const text = compose.rewriteActors(prompt, actorN);
  // a reacting actor gets a 60-frame ready stance first, so its reaction can be timed to the other actor's beat
  const segments = leadIn && frames >= 150 ? [{ prompt: 'A person stands ready in a fighting stance, facing an opponent, shifting weight lightly.', frames: 60 }, { prompt: text, frames: Math.max(60, frames - 60) }] : [{ prompt: text, frames }];
  const takes = Math.max(1, Math.min(4, Number($('#sceneTakes')?.value) || 1));
  const batch = takes > 1 ? Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('') : '';
  const ids = [];
  for (let k = 0; k < takes; k++) {
    const body = { ...base, prompt: text, segments, constraints: undefined, first_heading: undefined, lineage: undefined, actor: actorN, actor_prompt: prompt, name: `Actor ${actorN} · ${prompt.replace(/\bactor\s*\d+\b/gi, '').replace(/\s+/g, ' ').trim().slice(0, 40)}`, tags: ['scene'], seed: (base.seed + k) >>> 0, takes, take: k + 1, batch };
    ids.push((await (await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()).id);
  }
  for (let i = 0; i < 1200; i++) {
    await sleep(1500); await library.refresh();
    const clips = ids.map(id => library.find(id));
    if (clips.some(c => c?.status === 'failed')) throw new Error(`Actor ${actorN}: ${clips.find(c => c?.status === 'failed').error}`);
    if (clips.every(c => c?.status === 'ready')) { const best = library.bestOf(clips) || clips[0]; for (const c of clips) if (c.id !== best.id) library.patch(c.id, { archived: true }); return best; }
  }
  throw new Error('generation timed out');
}

export async function run(text) {
  const lines = parse(text); if (lines.length < 2) return false;
  const project = library.currentProject();
  const frames = Math.max(60, Math.min(360, Number(document.querySelector('[data-primary] .segment-frames').value) || 150));
  const { names, parents, offsets } = viewer.skeleton;
  const say = s => { log(s); library.setStatus(`Scene: ${s}`, 'readout progress'); };
  const done = {}; // actor -> { clip, pos, placement, offset, beat }
  const polish = $('#scenePolish')?.checked !== false;
  for (const [i, line] of lines.entries()) {
    say(`Actor ${line.actor} — generating "${line.text.slice(0, 50)}…"`);
    const clip = await generateFor(line.actor, line.text, frames, project, i > 0);
    const st = await viewer.streamsOf(clip);
    const pos = fkAll(st.root, st.rotations, parents, offsets);
    const beat = beatOf(pos, names);
    const entry = { clip, pos, beat, x: 0, z: 0, yaw: 0, offset: 0, st };
    // placement: facing the first actor it mentions (or the previous actor), at that actor's strike reach, timed to its beat
    const ref = done[[...line.mentions].find(m => done[m]) ?? lines[i - 1]?.actor];
    if (ref) {
      const rf = ref.beat.land, hips = ref.pos[rf][names.indexOf('Hips')], eff = ref.pos[rf][ref.beat.joint];
      const dx = eff[0] - hips[0], dz = eff[2] - hips[2], reach = Math.hypot(dx, dz) || .6, ux = dx / reach, uz = dz / reach;
      // the ref actor's clip space → scene space through its own placement
      const r = ref.yaw * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
      const place = p => [p[0] * c + p[2] * s + ref.x, p[1], -p[0] * s + p[2] * c + ref.z];
      // where this actor's hips should be at its own beat (scene space): just past the strike's reach
      const T = place([hips[0] + ux * (reach + .12), 0, hips[2] + uz * (reach + .12)]);
      const refHipsScene = place(hips);
      // face the reference actor: the facing the scene needs minus the facing this clip already has at its beat
      const lf = entry.beat.land, iHips = names.indexOf('Hips');
      const q2 = Array.from(st.rotations.subarray((lf * names.length + iHips) * 4, (lf * names.length + iHips) * 4 + 4));
      const have = headingOf(q2), want = Math.atan2(refHipsScene[0] - T[0], refHipsScene[2] - T[2]);
      const yaw = ((want - have) * 180 / Math.PI + 360) % 360;
      // the clip's hips at the beat are not at its origin: slide the placement so they land on T
      const h2 = pos[lf][iHips], r2 = yaw * Math.PI / 180, c2 = Math.cos(r2), s2 = Math.sin(r2);
      const hx = h2[0] * c2 + h2[2] * s2, hz = -h2[0] * s2 + h2[2] * c2;
      entry.x = +(T[0] - hx).toFixed(2); entry.z = +(T[2] - hz).toFixed(2); entry.yaw = Math.round(yaw);
      entry.offset = ref.offset + rf - entry.beat.land + 2;
      const refPos = ref.pos, place2 = p => [p[0] * c2 + p[2] * s2 + entry.x, p[1], -p[0] * s2 + p[2] * c2 + entry.z];
      const hipsApart = () => { let minD = 9; for (let f = 0; f < refPos.length; f++) { const f2 = f - entry.offset + ref.offset; if (f2 < 0 || f2 >= pos.length) continue; const a = place(refPos[f][iHips]), b = place2(pos[f2][iHips]); minD = Math.min(minD, Math.hypot(a[0] - b[0], a[2] - b[2])); } return minD; };
      if (polish && CONTACT.test(line.text)) {
        // The strike lands where it is: the reacting actor's motion after the contact is regenerated along a root
        // path pushed clear of the other body (>= 0.42 m hip to hip), so a grab or a clinch stays close without merging.
        const MIN = .42, idx = [], xz = [], heading = [];
        const J = names.length, rotAt = f => Array.from(st.rotations.subarray((f * J + iHips) * 4, (f * J + iHips) * 4 + 4));
        let pushed = 0;
        for (let f2 = 0; f2 < pos.length; f2++) {
          const f = f2 + entry.offset - ref.offset;
          let b = place2(pos[f2][iHips]);
          if (f >= 0 && f < refPos.length) {
            const a = place(refPos[f][iHips]), d = Math.hypot(b[0] - a[0], b[2] - a[2]);
            if (d < MIN) { b = d > 1e-4 ? [a[0] + (b[0] - a[0]) * MIN / d, b[1], a[2] + (b[2] - a[2]) * MIN / d] : [a[0] - Math.sin(want) * MIN, b[1], a[2] - Math.cos(want) * MIN]; pushed++; }
          }
          if (f2 % 10 === 0 || f2 === pos.length - 1) {
            const u = b[0] - entry.x, w = b[2] - entry.z; // scene -> clip space (inverse of place2)
            idx.push(f2); xz.push([u * c2 - w * s2, u * s2 + w * c2]);
            const h = compose.headingOf(rotAt(f2)); heading.push([Math.cos(h), Math.sin(h)]);
          }
        }
        entry.rootPath = { pushed, constraint: { type: 'root2d', frame_indices: idx, smooth_root_2d: xz, global_root_heading: heading, keep: { from: clip.id, name: 'scene path', frames: [0, pos.length - 1], part: 'hips', step: 10 } } };
        log(`Actor ${line.actor} — root path: ${pushed} frames pushed clear of the other body (hips min ${hipsApart().toFixed(2)} m before)`);
      } else {
        // no contact pass: keep the bodies apart by sliding back along the facing line until hips stay >= 0.5 m apart
        for (let step = 0; step < 12; step++) { if (hipsApart() >= .5) break; entry.x = +(entry.x - Math.sin(want) * .08).toFixed(2); entry.z = +(entry.z - Math.cos(want) * .08).toFixed(2); }
      }
      entry.refActor = lines.find(l => done[l.actor] === ref)?.actor;
      entry.contact = CONTACT.test(line.text) ? { ref, refFrame: rf, joint: ref.beat.joint } : null;
    }
    done[line.actor] = entry;
    await library.patch(clip.id, { markers: [{ frame: entry.beat.land, name: i === 0 ? 'strike' : 'react' }] });
    scene.setActorClip(line.actor, clip.id, { x: entry.x, z: entry.z, yaw: entry.yaw, offset: entry.offset });
    await sleep(300);
  }
  // contacts: pin the reacting actor's nearest hand to the reference effector at the beat and regenerate around it
  if (polish) for (const line of lines) {
    const e = done[line.actor]; if (!e?.contact) continue;
    try {
    say(`Actor ${line.actor} — pinning the contact and regenerating around it`);
    const contactFrame = Math.max(0, Math.min(e.clip.frames - 1, e.contact.refFrame - e.offset + e.contact.ref.offset));
    await library.select(e.clip, { frame: contactFrame });
    for (let i = 0; i < 80 && viewer.state.animation?.id !== e.clip.id; i++) await sleep(250); // select returns before the streams land
    viewer.setPlaying(false); viewer.setFrame(contactFrame); await sleep(200);
    for (let i = 0; i < 60 && !viewer.extras.some(x => x.label === `Actor ${e.refActor}`); i++) await sleep(250);
    log(`contact: stage=${viewer.state.animation?.id === e.clip.id} frame=${viewer.state.frame}/${contactFrame}`);
    const other = viewer.extras.find(x => x.label === `Actor ${e.refActor}`);
    if (!other) { say(`Actor ${line.actor} — the other actor is not on the stage, contact skipped`); continue; }
    const src = viewer.extraSource(other), target = src.pose[e.contact.joint];
    const my = viewer.pose(), lh = my[names.indexOf('LeftHand')], rh = my[names.indexOf('RightHand')];
    const near = Math.hypot(lh[0] - target[0], lh[1] - target[1], lh[2] - target[2]) < Math.hypot(rh[0] - target[0], rh[1] - target[1], rh[2] - target[2]) ? 'Left hand' : 'Right hand';
    const pinned = handles.pinTo(near, target, 'the strike');
    log(`pin ${near} → ${pinned} at frame ${viewer.state.frame}, moved=${handles.movedCount()}`);
    const before = new Set(library.animations.map(a => a.id));
    $('#takes').value = 1; $('#applyFalloff').value = '12'; compose.selectActor(line.actor);
    // approach kept, contact pinned, the rest re-planned along the clear root path (when there is one)
    const rp = e.rootPath?.constraint, from = contactFrame + 13;
    const path = rp ? [{ ...rp, frame_indices: rp.frame_indices.filter(f => f >= from), smooth_root_2d: rp.smooth_root_2d.filter((_, i) => rp.frame_indices[i] >= from), global_root_heading: rp.global_root_heading.filter((_, i) => rp.frame_indices[i] >= from) }].filter(c => c.frame_indices.length >= 2) : [];
    if (path.length) handles.regenerateAround({ keepAfter: false, extra: path }); else $('#regenAround').click();
    log(`regen clicked: status="${$('#status').textContent.slice(0, 60)}"`);
    await sleep(2500); log(`after 2.5 s: status="${$('#status').textContent.slice(0, 70)}"`);
    let made = null;
    for (let i = 0; i < 8 && !made; i++) { await sleep(1500); await library.refresh(); made = library.animations.find(a => !before.has(a.id)); }
    if (!made) { say(`Actor ${line.actor} — the contact regeneration did not start (${$('#status').textContent.slice(0, 50)}); the plain clip stays`); continue; }
    for (let i = 0; i < 800; i++) { await sleep(1500); await library.refresh(); made = library.find(made.id); if (made?.status === 'ready' || made?.status === 'failed') break; }
    if (made?.status === 'ready') { scene.setActorClip(line.actor, made.id); say(`Actor ${line.actor} — contact pinned (${near.toLowerCase()})`); }
    else say(`Actor ${line.actor} — contact regeneration ${made ? made.status : 'did not start'}; the plain clip stays`);
    } catch (err) { console.warn('director contact', err); library.setStatus(`Scene: contact step failed for Actor ${line.actor} — ${err.message}. The plain clip stays.`, 'error'); }
  }
  // hands through the other actor: push them out everywhere except around the intended contact
  // (both ways: the striking actor's follow-through can land inside the reacting actor too; its own beat is kept)
  if (polish) for (const line of lines) {
    const e = done[line.actor]; if (!e) continue;
    const against = e.refActor ?? lines.find(l => l.actor !== line.actor && done[l.actor])?.actor; if (!against) continue;
    try {
      const cur = scene.clipOfActor(line.actor); if (!cur) continue;
      await library.select(cur, { frame: 0 });
      for (let i = 0; i < 80 && viewer.state.animation?.id !== cur.id; i++) await sleep(250);
      for (let i = 0; i < 60 && !viewer.extras.some(x => x.label === `Actor ${against}`); i++) await sleep(250);
      const other = viewer.extras.find(x => x.label === `Actor ${against}`); if (!other) continue;
      const keepFrames = e.contact ? [e.contact.refFrame - e.offset + e.contact.ref.offset] : e.refActor ? [] : [e.beat.land];
      const n = await handles.fixCrossClipping(other, keepFrames);
      if (n) say(`Actor ${line.actor} — hands pushed out of Actor ${against} on ${n} frames`); else log(`Actor ${line.actor} — no hands through Actor ${against}`);
    } catch (err) { console.warn('director cross-clip', err); log(`cross-clip failed: ${err.message}`); }
  }
  handles.setActive(false);
  const first = done[lines[0].actor];
  await library.select(first.clip, { frame: first.beat.land });
  say(`Scene ready: ${lines.map(l => `Actor ${l.actor}`).join(' + ')} · Actors tab · Body on · play.`);
  library.setStatus(`Scene ready: ${lines.map(l => `Actor ${l.actor}`).join(' + ')} · Actors tab · Body on · play.`);
  return true;
}
// Run with the whole thing guarded, so a failure is a message, never a frozen Generate button.
export async function runSafe(text) {
  try { return await run(text); }
  catch (e) { console.warn('director', e); library.setStatus(`Scene: ${e.message}`, 'error'); return false; }
}
