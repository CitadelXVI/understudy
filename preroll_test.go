package main

import "testing"

func TestPrerollPrompt(t *testing.T) {
	for in, want := range map[string]string{
		"A person walks forward while scared":                      "A person walks forward while scared.",
		"A person walks forward with an injured leg":               "A person walks forward with an injured leg.",
		"A tired person walks forward slowly, dragging their feet": "A tired person walks forward slowly, dragging their feet.",
		"A person walks forward and stops.":                        "A person walks forward.",
		"A person sneaks forward quietly":                          "A person sneaks forward quietly.",
		"A drunk person stumbles forward":                          "A drunk person stumbles forward.",
		"A person jogs forward, then sits down.":                   "A person jogs forward.",
		"A person runs forward.":                                   "A person runs forward.",
	} {
		got, ok := prerollPrompt(in)
		if !ok || got != want {
			t.Errorf("%q: %q %v (want %q)", in, got, ok, want)
		}
	}
	for _, in := range []string{
		"A person crouches down and stands up again.",
		"A person throws a right punch.",
		"A person kneels down on one knee and stands up again.",
		"A person picks something up from the floor and then walks away.",
		"A person turns around to face the other way.",
		"A person gets hit in the chest and staggers back.",
	} {
		if got, ok := prerollPrompt(in); ok {
			t.Errorf("%q should have no pre-roll, got %q", in, got)
		}
	}
}

func TestStyledMove(t *testing.T) {
	for in, want := range map[string]bool{
		"A person walks forward.":                    false,
		"A person walks forward and stops.":          false,
		"A person runs around in a circle.":          false,
		"A person walks forward while scared":        true,
		"A tired person walks forward slowly":        true,
		"A person walks forward with an injured leg": true,
		"A person sneaks forward quietly":            true,
	} {
		if got := styledMove(in); got != want {
			t.Errorf("%q: %v", in, got)
		}
	}
}
