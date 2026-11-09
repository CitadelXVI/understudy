package main

import (
	"math"
	"testing"
)

func TestKeyLayer(t *testing.T) {
	sk := skeletonDefinitions["soma30"]
	for _, key := range []string{"smplx22", "g1skel34"} { // every skeleton splits into arms, legs, back and body
		p := layerParts(skeletonDefinitions[key])
		if len(p["larm"]) == 0 || len(p["rleg"]) == 0 || len(p["body"]) != 1 {
			t.Fatalf("%s parts: %v", key, p)
		}
	}
	joints, frames := len(sk.parents), 60
	roots := make([]float32, frames*3)
	rot := make([]float32, frames*joints*4)
	for f := 0; f < frames; f++ {
		roots[f*3+2] = float32(f) * 0.05 // walking forward along z
		roots[f*3+1] = 0.9
		for j := 0; j < joints; j++ {
			rot[(f*joints+j)*4+3] = 1
		}
	}
	parts := layerParts(sk)
	larm := parts["larm"]
	if len(larm) == 0 || len(parts["body"]) != 1 || len(parts["lleg"]) == 0 {
		t.Fatalf("parts: %v", parts)
	}
	shoulder := larm[0]
	for _, j := range larm {
		if sk.names[j] == "LeftArm" {
			shoulder = j
		}
	}
	pose := func(angle float64) [][]float32 {
		r := make([][]float32, joints)
		for j := range r {
			r[j] = []float32{0, 0, 0, 1}
		}
		s, c := float32(math.Sin(angle/2)), float32(math.Cos(angle/2))
		r[shoulder] = []float32{0, 0, s, c}
		return r
	}
	angleAt := func(rot []float32, f int) float64 {
		q := baseQ(rot, joints, f, shoulder)
		return 2 * math.Atan2(float64(q[2]), float64(q[3]))
	}
	l := &keyLayer{Blend: 10, Keys: []layerKey{
		{Frame: 20, Part: "larm", Rotations: pose(math.Pi / 2)},
		{Frame: 40, Part: "larm", Rotations: pose(0), Interp: ""},
		{Frame: 30, Part: "body", Rotations: pose(0), Root: []float32{0.3, 0.9, 1.5}},
	}}
	if err := prepareLayer(l, roots, rot, joints, frames); err != nil {
		t.Fatal(err)
	}
	r2, q2 := applyLayer(roots, rot, sk, l)
	near := func(a, b float64) bool { return math.Abs(a-b) < 1e-3 }
	if !near(angleAt(q2, 20), math.Pi/2) || !near(angleAt(q2, 40), 0) {
		t.Fatalf("keys not exact: %v %v", angleAt(q2, 20), angleAt(q2, 40))
	}
	if !near(angleAt(q2, 30), math.Pi/4) { // smooth, halfway
		t.Fatalf("halfway: %v", angleAt(q2, 30))
	}
	if a := angleAt(q2, 15); !(a > 0 && a < math.Pi/2) || !near(angleAt(q2, 5), 0) { // eases in over 10 frames
		t.Fatalf("ease in: f15 %v f5 %v", a, angleAt(q2, 5))
	}
	if !near(float64(r2[30*3]), 0.3) || !near(float64(r2[30*3+2]), 1.5) { // body key: the hips where set
		t.Fatalf("body key: %v %v", r2[30*3], r2[30*3+2])
	}
	if !near(float64(r2[35*3+2]-roots[35*3+2]), 0) == false && !near(float64(r2[50*3]), 0) { // out of blend after 40
		t.Fatalf("body ease out")
	}
	// hold: the arm stays at the first key's pose until the next key
	l.Keys[0].Interp = "hold"
	for i := range l.Keys {
		if l.Keys[i].Frame == 20 {
			l.Keys[i].Interp = "hold"
		}
	}
	// the base moves the arm under the hold: the held pose stays put anyway
	rotMoving := append([]float32(nil), rot...)
	for f := 0; f < frames; f++ {
		a := float64(f) * 0.02
		at := (f*joints + shoulder) * 4
		rotMoving[at+2], rotMoving[at+3] = float32(math.Sin(a/2)), float32(math.Cos(a/2))
	}
	l2 := &keyLayer{Blend: 10, Keys: []layerKey{{Frame: 20, Part: "larm", Rotations: pose(math.Pi / 2), Interp: "hold"}, {Frame: 40, Part: "larm", Rotations: pose(0)}}}
	if err := prepareLayer(l2, roots, rotMoving, joints, frames); err != nil {
		t.Fatal(err)
	}
	_, q5 := applyLayer(roots, rotMoving, sk, l2)
	if !near(angleAt(q5, 35), math.Pi/2) {
		t.Fatalf("hold over a moving arm: %v", angleAt(q5, 35))
	}
	_, q3 := applyLayer(roots, rot, sk, l)
	if !near(angleAt(q3, 39), math.Pi/2) {
		t.Fatalf("hold: %v", angleAt(q3, 39))
	}
	// moving a body key keeps its change (no teleport along the walk)
	for i := range l.Keys {
		if l.Keys[i].Part == "body" {
			l.Keys[i].Frame = 50
		}
	}
	r4, _ := applyLayer(roots, rot, sk, l)
	if !near(float64(r4[50*3+2]-roots[50*3+2]), 1.5-float64(roots[30*3+2])) {
		t.Fatalf("moved body key: %v", r4[50*3+2]-roots[50*3+2])
	}
}
