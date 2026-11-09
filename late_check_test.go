package main

import (
	"encoding/binary"
	"math"
	"os"
	"testing"
)

// The late-character check on a real take (blind judges scored its start 1/10: a scared walk whose first second is
// an ordinary walk). Skipped when the clip is not on this machine.
func TestLateStartCheck(t *testing.T) {
	dir := "../demo-output/" + os.Getenv("LATE_CLIP")
	if os.Getenv("LATE_CLIP") == "" {
		t.Skip("set LATE_CLIP")
	}
	read := func(name string) []float32 {
		b, err := os.ReadFile(dir + "/" + name)
		if err != nil {
			t.Skip(err)
		}
		out := make([]float32, len(b)/4)
		for i := range out {
			out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
		}
		return out
	}
	c := checkAction("a person walks forward while scared", read("root_positions.f32"), read("local_rotations_xyzw.f32"), skeletonDefinitions["soma30"])
	if c == nil || c.ok {
		t.Fatalf("not flagged: %+v", c)
	}
	t.Log(c.notes)
}
