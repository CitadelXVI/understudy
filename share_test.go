package main

import "testing"

func TestShareable(t *testing.T) {
	for model, want := range map[string]bool{"soma-rp-v1.2": true, "SOMA-seed-v1.1": true, "g1-rp-v1": true, "smplx-rp-v1": false, "kimodo-smplx22": false, "": false} {
		if got, _ := shareable(model); got != want {
			t.Errorf("shareable(%q) = %v, want %v", model, got, want)
		}
	}
}
