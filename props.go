// Stage props: solid boxes a clip can stand, sit or put a hand on (a seat, a ledge, a vault). The checks treat a
// box top as floor inside its footprint, so a body resting on it is on the floor, not floating; Clean up's physics
// gets the same boxes, and its contact pass leaves the frames that rest on one alone.
package main

import "math"

type stageProp struct {
	Kind string     `json:"kind"`           // "box"
	Name string     `json:"name,omitempty"` // "seat", "ledge"…
	Pos  [3]float32 `json:"pos"`            // centre of the base on the floor (x, floor y, z)
	Size [3]float32 `json:"size"`           // width (x), height (y), depth (z) in metres
	Yaw  float32    `json:"yaw,omitempty"`  // radians about Y
}

// floorField: the floor height under a point — the plain floor, or a box top inside its footprint.
type floorField struct {
	floor float64
	props []stageProp
}

func (f floorField) at(x, z float64) float64 {
	h := f.floor
	for _, p := range f.props {
		if p.Kind != "box" {
			continue
		}
		dx, dz := x-float64(p.Pos[0]), z-float64(p.Pos[2])
		c, s := math.Cos(float64(p.Yaw)), math.Sin(float64(p.Yaw))
		lx, lz := dx*c+dz*s, -dx*s+dz*c // into the box's frame
		if math.Abs(lx) <= float64(p.Size[0])/2 && math.Abs(lz) <= float64(p.Size[2])/2 {
			h = math.Max(h, float64(p.Pos[1])+float64(p.Size[1]))
		}
	}
	return h
}

// height: how far a point is above what supports it — the floor, or a box top inside its footprint. A point inside a
// box is as deep as its shortest way out (over the top or through the nearest side): measured from the top only, a
// palm 1 cm into a wall's face read as "89 cm under the floor".
func (f floorField) height(x, y, z float64) float64 {
	h := y - f.at(x, z)
	for _, p := range f.props {
		if p.Kind != "box" || !f.inFootprint(p, x, z) {
			continue
		}
		top, base := float64(p.Pos[1])+float64(p.Size[1]), float64(p.Pos[1])
		if y >= top || y <= base {
			continue
		}
		dx, dz := x-float64(p.Pos[0]), z-float64(p.Pos[2])
		c, s := math.Cos(float64(p.Yaw)), math.Sin(float64(p.Yaw))
		lx, lz := dx*c+dz*s, -dx*s+dz*c
		side := math.Min(float64(p.Size[0])/2-math.Abs(lx), float64(p.Size[2])/2-math.Abs(lz))
		h = math.Max(h, -math.Min(top-y, side))
	}
	return h
}

// The top of the box nearest a point, and whether the point is over it (for snapping poses).
func (f floorField) onProp(x, z float64) (stageProp, bool) {
	for _, p := range f.props {
		if f.at(x, z) > f.floor+1e-4 && f.inFootprint(p, x, z) {
			return p, true
		}
	}
	return stageProp{}, false
}

func (f floorField) inFootprint(p stageProp, x, z float64) bool {
	dx, dz := x-float64(p.Pos[0]), z-float64(p.Pos[2])
	c, s := math.Cos(float64(p.Yaw)), math.Sin(float64(p.Yaw))
	lx, lz := dx*c+dz*s, -dx*s+dz*c
	return math.Abs(lx) <= float64(p.Size[0])/2 && math.Abs(lz) <= float64(p.Size[2])/2
}
