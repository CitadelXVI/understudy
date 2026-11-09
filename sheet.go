package main

// GET /api/animations/<id>/sheet.png — the clip drawn as a grid of stick figures, for agents (and people) to check a
// clip without a browser. Each frame is drawn from each view, side by side; frames run left to right, top to bottom.
//
//	from, to   first and last frame, 0-based (default: the whole clip)
//	every      draw every Nth frame (default: about 24 frames in all)
//	frames     an explicit list instead: frames=0,12,40
//	views      front, side, back, left, top, three (default front,side); the views follow the body's facing at the
//	           first drawn frame, so "front" is the front of the character however the clip is turned
//	tile       tile size in px (default 240, 120..600)
//
// Left limbs are blue, right limbs orange, the spine white; a joint below the floor (or inside a box) is red. Each tile
// is labelled with its 1-based frame number (as the page shows frames) and the floor and boxes are drawn.

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

func (g *gallery) handleSheet(w http.ResponseWriter, r *http.Request, id string) {
	g.mu.RLock()
	a := g.items[id]
	var clip animation
	if a != nil {
		clip = *a
	}
	g.mu.RUnlock()
	if a == nil || clip.Status != "ready" || clip.roots == nil {
		http.Error(w, "no such ready clip", http.StatusNotFound)
		return
	}
	model, ok := g.models[clip.Model]
	if !ok {
		http.Error(w, "the clip's model is unknown", 400)
		return
	}
	skeleton := skeletonDefinitions[model.SkeletonKey]
	pos := forwardKinematics(clip.roots, clip.rotations, skeleton)
	n := len(pos)
	q := r.URL.Query()
	atoi := func(k string, def int) int {
		if v, err := strconv.Atoi(q.Get(k)); err == nil {
			return v
		}
		return def
	}
	var picks []int
	if list := q.Get("frames"); list != "" {
		for _, s := range strings.Split(list, ",") {
			if f, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && f >= 0 && f < n {
				picks = append(picks, f)
			}
		}
	} else {
		from, to := atoi("from", 0), atoi("to", n-1)
		from, to = max(0, min(from, n-1)), max(0, min(to, n-1))
		if to < from {
			from, to = to, from
		}
		every := atoi("every", max(1, int(math.Ceil(float64(to-from+1)/24))))
		every = max(1, every)
		for f := from; f <= to; f += every {
			picks = append(picks, f)
		}
		if picks[len(picks)-1] != to {
			picks = append(picks, to)
		}
	}
	if len(picks) == 0 {
		http.Error(w, "no frames to draw", 400)
		return
	}
	if len(picks) > 120 {
		http.Error(w, "at most 120 frames on one sheet (use every, from/to or frames)", 400)
		return
	}
	views := strings.Split(firstNonEmpty(q.Get("views"), "front,side"), ",")
	for i, v := range views {
		views[i] = strings.TrimSpace(strings.ToLower(v))
		switch views[i] {
		case "front", "side", "back", "left", "right", "top", "three":
		default:
			http.Error(w, "views: front, side, back, left, top, three", 400)
			return
		}
	}
	tile := max(120, min(600, atoi("tile", 240)))
	img := drawSheet(pos, skeleton, clip.Props, picks, views, tile, floorY(clip))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(buf.Bytes())
}

func floorY(a animation) float64 { return 0.02 } // the stage floor (contact.go)

// the heading the body faces at frame f: yaw of the hips' forward (+Z) on the floor
func bodyYaw(pos [][][3]float32, skeleton skeletonDefinition, f int) float64 {
	idx := func(names ...string) int {
		for _, n := range names {
			for i, s := range skeleton.names {
				if s == n {
					return i
				}
			}
		}
		return -1
	}
	l, r := idx("LeftLeg", "left_hip", "left_hip_pitch_skel"), idx("RightLeg", "right_hip", "right_hip_pitch_skel")
	if l < 0 || r < 0 {
		return 0
	}
	// left = +X when facing +Z: forward = up × (left - right)
	dx, dz := float64(pos[f][l][0]-pos[f][r][0]), float64(pos[f][l][2]-pos[f][r][2])
	fx, fz := dz, -dx
	return math.Atan2(fx, fz)
}

func drawSheet(pos [][][3]float32, skeleton skeletonDefinition, props []stageProp, picks []int, views []string, tile int, floor float64, thumb ...bool) *image.RGBA {
	small := len(thumb) > 0 && thumb[0] // a Library card thumbnail: no frame numbers, no joint dots
	perRow := max(1, 6/len(views))      // frames per row (each frame takes len(views) tiles)
	if small {
		perRow = len(picks) // a thumbnail is one strip
	}
	cols := perRow * len(views)
	rows := (len(picks) + perRow - 1) / perRow
	img := image.NewRGBA(image.Rect(0, 0, cols*tile, rows*tile))
	fill(img, img.Bounds(), color.RGBA{24, 25, 28, 255})
	yaw0 := bodyYaw(pos, skeleton, picks[0])
	side := func(name string) int { // -1 right, 1 left, 0 centre
		n := strings.ToLower(name)
		if strings.HasPrefix(n, "left") {
			return 1
		}
		if strings.HasPrefix(n, "right") {
			return -1
		}
		return 0
	}
	scale := float64(tile) * 0.80 / 2.1 // px per metre: a 2.1 m column fills 80% of a tile
	for i, f := range picks {
		rowI, colF := i/perRow, i%perRow
		hips := pos[f][0]
		for v, view := range views {
			x0, y0 := (colF*len(views)+v)*tile, rowI*tile
			rect := image.Rect(x0+1, y0+1, x0+tile-1, y0+tile-1)
			fill(img, rect, color.RGBA{36, 37, 41, 255})
			// view axes: rotate the world so the body's first facing is +Z, then pick screen right / up
			yaw := yaw0
			switch view {
			case "side", "right":
				yaw += math.Pi / 2 // camera on the body's right: it faces screen right
			case "left":
				yaw -= math.Pi / 2
			case "back":
				yaw += math.Pi
			case "three":
				yaw += math.Pi / 4
			}
			cy, sy := math.Cos(yaw), math.Sin(yaw)
			top := view == "top"
			project := func(p [3]float32) (float64, float64) {
				x, y, z := float64(p[0]-hips[0]), float64(p[1]), float64(p[2]-hips[2])
				// into the body frame (facing +Z): rotate by -yaw
				bx, bz := x*cy-z*sy, x*sy+z*cy
				if top {
					return float64(x0) + float64(tile)/2 + bx*scale, float64(y0) + float64(tile)/2 - bz*scale
				}
				// camera in front looking back: screen right = body +X (its left), up = Y
				return float64(x0) + float64(tile)/2 + bx*scale, float64(y0) + float64(tile)*0.9 - (y-floor)*scale
			}
			if !top { // the floor
				_, fy := project([3]float32{hips[0], float32(floor), hips[2]})
				line(img, float64(x0+4), fy, float64(x0+tile-4), fy, 1.2, color.RGBA{110, 112, 120, 255}, rect)
			}
			for _, b := range props { // boxes: their 12 edges
				c := boxCorners(b)
				for _, e := range [][2]int{{0, 1}, {1, 2}, {2, 3}, {3, 0}, {4, 5}, {5, 6}, {6, 7}, {7, 4}, {0, 4}, {1, 5}, {2, 6}, {3, 7}} {
					ax, ay := project(c[e[0]])
					bx, by := project(c[e[1]])
					line(img, ax, ay, bx, by, 1.2, color.RGBA{255, 210, 127, 200}, rect)
				}
			}
			field := floorField{floor: floor, props: props}
			// bones, far side first in side views so the near limbs read on top
			type bone struct {
				a, b  int
				depth float64
			}
			var bones []bone
			for j, p := range skeleton.parents {
				if p < 0 {
					continue
				}
				m := [3]float32{(pos[f][j][0] + pos[f][p][0]) / 2, 0, (pos[f][j][2] + pos[f][p][2]) / 2}
				x, z := float64(m[0]-hips[0]), float64(m[2]-hips[2])
				bones = append(bones, bone{p, j, x*sy + z*cy})
			}
			sort.Slice(bones, func(i, j int) bool { return bones[i].depth > bones[j].depth })
			for _, bn := range bones {
				ax, ay := project(pos[f][bn.a])
				bx, by := project(pos[f][bn.b])
				col := color.RGBA{235, 235, 240, 255}
				switch side(skeleton.names[bn.b]) {
				case 1:
					col = color.RGBA{90, 169, 255, 255}
				case -1:
					col = color.RGBA{255, 169, 77, 255}
				}
				line(img, ax, ay, bx, by, 2.6, col, rect)
			}
			for j := range skeleton.parents {
				if small {
					break
				}
				p := pos[f][j]
				x, y := project(p)
				below := field.height(float64(p[0]), float64(p[1]), float64(p[2])) < -0.01 // under the floor or inside a box
				col := color.RGBA{250, 250, 250, 255}
				rad := 2.2
				if below {
					col, rad = color.RGBA{255, 70, 70, 255}, 4.0
				}
				disc(img, x, y, rad, col, rect)
			}
			// the head as a circle round the head joint
			if h := headIndex(skeleton); h >= 0 {
				x, y := project(pos[f][h])
				ring(img, x, y-0.08*scale, 0.1*scale, 1.6, color.RGBA{235, 235, 240, 255}, rect)
			}
			if !small {
				digits(img, x0+8, y0+8, strconv.Itoa(f+1), 2, color.RGBA{255, 215, 0, 255})
			}
			if len(views) > 1 && !small {
				viewMark(img, x0+tile-8, y0+8, view)
			}
		}
	}
	return img
}

func headIndex(s skeletonDefinition) int {
	for i, n := range s.names {
		if n == "Head" || n == "head" || n == "head_skel" {
			return i
		}
	}
	return -1
}

func boxCorners(b stageProp) [8][3]float32 {
	hw, hd := b.Size[0]/2, b.Size[2]/2
	cy, sy := float32(math.Cos(float64(b.Yaw))), float32(math.Sin(float64(b.Yaw)))
	var c [8][3]float32
	k := 0
	for _, y := range []float32{b.Pos[1], b.Pos[1] + b.Size[1]} {
		for _, xz := range [][2]float32{{-hw, -hd}, {hw, -hd}, {hw, hd}, {-hw, hd}} {
			x, z := xz[0]*cy-xz[1]*sy, xz[0]*sy+xz[1]*cy // box frame to world (floorField.at goes the other way)
			c[k] = [3]float32{b.Pos[0] + x, y, b.Pos[2] + z}
			k++
		}
	}
	return c
}

func fill(img *image.RGBA, r image.Rectangle, c color.RGBA) {
	r = r.Intersect(img.Bounds())
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			img.SetRGBA(x, y, c)
		}
	}
}

// blend a colour into a pixel with coverage a (0..1)
func plot(img *image.RGBA, x, y int, c color.RGBA, a float64, clip image.Rectangle) {
	if !(image.Point{x, y}).In(clip) || a <= 0 {
		return
	}
	a = math.Min(1, a) * float64(c.A) / 255
	o := img.RGBAAt(x, y)
	mix := func(p, q uint8) uint8 { return uint8(float64(p)*(1-a) + float64(q)*a + 0.5) }
	img.SetRGBA(x, y, color.RGBA{mix(o.R, c.R), mix(o.G, c.G), mix(o.B, c.B), 255})
}

// a soft-edged line of width w (distance to the segment, anti-aliased over a pixel)
func line(img *image.RGBA, ax, ay, bx, by, w float64, c color.RGBA, clip image.Rectangle) {
	minX, maxX := int(math.Floor(math.Min(ax, bx)-w-1)), int(math.Ceil(math.Max(ax, bx)+w+1))
	minY, maxY := int(math.Floor(math.Min(ay, by)-w-1)), int(math.Ceil(math.Max(ay, by)+w+1))
	dx, dy := bx-ax, by-ay
	l2 := dx*dx + dy*dy
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			px, py := float64(x)+0.5, float64(y)+0.5
			t := 0.0
			if l2 > 0 {
				t = math.Max(0, math.Min(1, ((px-ax)*dx+(py-ay)*dy)/l2))
			}
			d := math.Hypot(ax+dx*t-px, ay+dy*t-py)
			plot(img, x, y, c, w/2+0.5-d, clip)
		}
	}
}

func disc(img *image.RGBA, cx, cy, r float64, c color.RGBA, clip image.Rectangle) {
	for y := int(cy - r - 1); y <= int(cy+r+1); y++ {
		for x := int(cx - r - 1); x <= int(cx+r+1); x++ {
			d := math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy)
			plot(img, x, y, c, r+0.5-d, clip)
		}
	}
}

func ring(img *image.RGBA, cx, cy, r, w float64, c color.RGBA, clip image.Rectangle) {
	for y := int(cy - r - w - 1); y <= int(cy+r+w+1); y++ {
		for x := int(cx - r - w - 1); x <= int(cx+r+w+1); x++ {
			d := math.Abs(math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy) - r)
			plot(img, x, y, c, w/2+0.5-d, clip)
		}
	}
}

// A 3x5 bitmap font for frame numbers and view letters.
var glyphs = map[rune][5]string{
	'0': {"###", "#.#", "#.#", "#.#", "###"}, '1': {".#.", "##.", ".#.", ".#.", "###"}, '2': {"###", "..#", "###", "#..", "###"},
	'3': {"###", "..#", "###", "..#", "###"}, '4': {"#.#", "#.#", "###", "..#", "..#"}, '5': {"###", "#..", "###", "..#", "###"},
	'6': {"###", "#..", "###", "#.#", "###"}, '7': {"###", "..#", "..#", "..#", "..#"}, '8': {"###", "#.#", "###", "#.#", "###"},
	'9': {"###", "#.#", "###", "..#", "###"}, 'F': {"###", "#..", "##.", "#..", "#.."}, 'S': {"###", "#..", "###", "..#", "###"},
	'B': {"##.", "#.#", "##.", "#.#", "##."}, 'L': {"#..", "#..", "#..", "#..", "###"}, 'T': {"###", ".#.", ".#.", ".#.", ".#."},
	'R': {"##.", "#.#", "##.", "#.#", "#.#"},
}

func digits(img *image.RGBA, x, y int, s string, px int, c color.RGBA) {
	for i, ch := range s {
		g, ok := glyphs[ch]
		if !ok {
			continue
		}
		for gy, row := range g {
			for gx, on := range row {
				if on == '#' {
					fill(img, image.Rect(x+i*4*px+gx*px, y+gy*px, x+i*4*px+(gx+1)*px, y+(gy+1)*px), c)
				}
			}
		}
	}
}

func viewMark(img *image.RGBA, right, y int, view string) {
	letter := map[string]string{"front": "F", "side": "S", "right": "R", "left": "L", "back": "B", "top": "T", "three": "3"}[view]
	digits(img, right-3*2, y, letter, 2, color.RGBA{150, 152, 160, 255})
}

// GET /api/animations/<id>/thumb.png — the clip's Library card picture: four poses across it (start, two in the
// middle, end) from three-quarters, small and without numbers. The page asks with ?v=<frames>-<edits> so an edited
// clip gets a new picture and an unchanged one comes from the browser's cache.
func (g *gallery) handleThumb(w http.ResponseWriter, r *http.Request, id string) {
	g.mu.RLock()
	a := g.items[id]
	var clip animation
	if a != nil {
		clip = *a
	}
	g.mu.RUnlock()
	if a == nil || clip.Status != "ready" || clip.roots == nil {
		http.Error(w, "no such ready clip", http.StatusNotFound)
		return
	}
	model, ok := g.models[clip.Model]
	if !ok {
		http.Error(w, "the clip's model is unknown", 400)
		return
	}
	skeleton := skeletonDefinitions[model.SkeletonKey]
	pos := forwardKinematics(clip.roots, clip.rotations, skeleton)
	n := len(pos)
	if n == 0 {
		http.Error(w, "empty clip", 400)
		return
	}
	picks := []int{0, (n - 1) / 3, 2 * (n - 1) / 3, n - 1}
	img := drawSheet(pos, skeleton, clip.Props, picks, []string{"three"}, 72, floorY(clip), true)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "max-age=31536000, immutable")
	_, _ = w.Write(buf.Bytes())
}
