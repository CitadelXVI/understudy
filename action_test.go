package main

import (
	"strings"
	"testing"
)

func TestFirstWording(t *testing.T) {
	if got := firstWording("A person stands idle, shifting their weight."); !strings.Contains(got, "arms hanging naturally at their sides") {
		t.Errorf("idle: %q", got)
	}
	if got := firstWording("A person turns around to face the other way."); !strings.Contains(got, "180 degrees") || strings.Count(got, "face") != 1 {
		t.Errorf("turn: %q", got)
	}
	if got := firstWording("A person throws a right punch."); got != "A person throws a right punch." {
		t.Errorf("punch changed: %q", got)
	}
	if got := firstWording("A person kicks high with the right leg."); !strings.Contains(got, "right foot back down") {
		t.Errorf("kick: %q", got)
	}
	// a plain run stays a run (a run that slowed to a walk was judged as walking instead of running)
	if got := firstWording("A person runs forward."); got != "A person runs forward." {
		t.Errorf("run: %q", got)
	}
	// the retry wording of a turn must not repeat its own words ("... to face the other way to face the other way")
	if got := retryWording("A person turns around to face the other way."); strings.Count(got, "face") > 1 {
		t.Errorf("turn retry repeats: %q", got)
	}
}
