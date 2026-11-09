package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// Saved prompts for the Inbox (no project chosen: the default view). Saved prompts lived only on projects, so with
// "All projects" the Saved prompt list was disabled and + only said "Pick a project" (control audit, 2026-10-29).
// GET /api/prompts lists them; PUT replaces the list. Kept in inbox_prompts.json beside the clips.
type inboxPrompts struct {
	mu    sync.Mutex
	path  string
	items []savedPrompt
}

func loadInboxPrompts(output string) *inboxPrompts {
	s := &inboxPrompts{items: []savedPrompt{}}
	if output != "" {
		s.path = filepath.Join(output, "inbox_prompts.json")
		if b, err := os.ReadFile(s.path); err == nil {
			_ = json.Unmarshal(b, &s.items)
		}
	}
	return s
}

func (s *inboxPrompts) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch r.Method {
	case http.MethodGet:
	case http.MethodPut:
		var list []savedPrompt
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&list); err != nil {
			http.Error(w, "a JSON list of saved prompts", http.StatusBadRequest)
			return
		}
		if len(list) > 500 {
			http.Error(w, "at most 500 saved prompts", http.StatusBadRequest)
			return
		}
		s.items = list
		if s.path != "" {
			b, _ := json.MarshalIndent(s.items, "", "  ")
			if err := os.WriteFile(s.path, b, 0644); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}
	default:
		http.Error(w, "GET or PUT", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.items)
}
