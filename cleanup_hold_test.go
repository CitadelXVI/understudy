package main

import "testing"

func TestInPlaceMove(t *testing.T) {
	for prompt, want := range map[string]bool{
		"A person crouches down and stands up again.": true,
		"A person picks something up from the floor.": true,
		"A person bends down to tie a shoe.":          true,
		"A person squats.":                            true,
		"A person kneels down on one knee.":           false,
		"A person walks forward and picks up a box.":  false,
		"A person sits down on the floor.":            false,
		"A person throws a right punch.":              false,
	} {
		if got := inPlaceMove(prompt); got != want {
			t.Errorf("%q: %v", prompt, got)
		}
	}
}
