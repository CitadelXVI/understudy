package main

import (
	"regexp"
	"strings"
)

// Pre-roll (owner, 2026-10-29: "both of these start off wrong and then become the animation we want ... the body is
// being driven by the start pose until later on"). Kimodo starts most clips as a neutral person and lets the words'
// character (scared, injured, tired, sneaking, drunk) arrive one to two seconds in; a pinned standing pose made it
// worse. For a prompt that leads with a continuous movement, the clip is generated with the same movement played for
// prerollFrames first, and those frames are cut off: the kept clip is in character from its first frame.
//
// Blind start judges, first 3 seconds, 6 styled prompts x 2 takes, same seeds (START /10): standing start + walk keys
// 2.3, standing start only 2.2, no pin 5.9 (3.2 in a second run), 60-frame pre-roll 6.8 / 6.3 / 5.4 (three blind runs
// of the same clips). A 120-frame pre-roll scored 5.1, one longer segment with its first 60 or 90 frames cut 3.6 / 4.3:
// the separate pre-roll segment is what works. Takes whose character still arrives late are retried (action.go).
const prerollFrames = 60

// a movement that carries on (it can be played longer without changing what it is)
var prerollWords = regexp.MustCompile(`\b(walks?|walking|runs?|running|jogs?|jogging|sprints?|sprinting|sneaks?|sneaking|creeps?|creeping|tiptoes?|tiptoeing|stumbles?|stumbling|staggers? (forward|along|around)|limps?|limping|marches|marching|strolls?|strolling|shuffles?|shuffling|wanders?|wandering|paces|pacing|crawls?|crawling|struts?|strutting|trudges?|trudging|lurches|lurching|skips?|skipping)\b`)

// prerollPrompt: the continuous movement the clip leads with (the words up to an "and then"/"then"/", and"), or false
// when the clip does not start with one (a one-off action, a pose change, a turn).
func prerollPrompt(prompt string) (string, bool) {
	p := strings.TrimSpace(prompt)
	low := strings.ToLower(p)
	m := prerollWords.FindStringIndex(low)
	if m == nil {
		return "", false
	}
	// the movement must lead: nothing before it but the subject ("A tired person walks", "The man sneaks")
	before := strings.Fields(low[:m[0]])
	if len(before) > 4 {
		return "", false
	}
	for _, w := range before {
		if w == "then" || w == "and" || strings.HasSuffix(w, ",") {
			return "", false
		}
	}
	first := p
	for _, sep := range []string{", and then ", " and then ", ", then ", " then ", " and stops", " and turns", " and sits", " and kneels", " and jumps", " and picks", " and falls", " and lies", ", and ", " until "} {
		if i := strings.Index(strings.ToLower(first), sep); i > m[0] {
			first = first[:i]
		}
	}
	first = strings.TrimRight(strings.TrimSpace(first), ".,;")
	if first == "" {
		return "", false
	}
	return first + ".", true
}

// needsPreroll: only a movement with a character in it is pre-rolled ("walks while scared", "limps", "sneaks"). A plain
// walk, run or jog starts from rest and gets going on its own, which is right for a one-off clip: the blind judges
// marked the pre-rolled plain run and side step down for starting mid-stride (review 2026-10-29).
func needsPreroll(prompt string) bool {
	if styledMove(prompt) {
		return true
	}
	for _, w := range strings.FieldsFunc(strings.ToLower(prompt), func(r rune) bool { return !(r >= 'a' && r <= 'z') }) {
		if prerollWords.MatchString(w) && !plainLocomotion.MatchString(w) {
			return true // sneaks, limps, stumbles, crawls, marches...: the movement is the character
		}
	}
	return false
}

var plainLocomotion = regexp.MustCompile(`^(walks?|walking|runs?|running|jogs?|jogging|sprints?|sprinting|sidesteps?|steps?|strafes?)$`)
