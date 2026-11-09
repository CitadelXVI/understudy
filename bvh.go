// BVH export: the clip's skeleton and motion in centimetres at 30 fps,
// the layout Unreal, Blender and Cascadeur read without help.
package main

import (
	"fmt"
	"math"
	"strings"
)

// Quaternion (XYZW) to Euler ZXY in degrees, BVH's "Zrotation Xrotation Yrotation" order.
func quatToEulerZXY(x, y, z, w float64) (rz, rx, ry float64) {
	// Rotation matrix.
	m00 := 1 - 2*(y*y+z*z)
	m01 := 2 * (x*y - z*w)
	m10 := 2 * (x*y + z*w)
	m11 := 1 - 2*(x*x+z*z)
	m20 := 2 * (x*z - y*w)
	m21 := 2 * (y*z + x*w)
	m22 := 1 - 2*(x*x+y*y)
	// R = Rz * Rx * Ry
	rx = math.Asin(math.Max(-1, math.Min(1, m21)))
	if math.Abs(m21) < 0.999999 {
		rz = math.Atan2(-m01, m11)
		ry = math.Atan2(-m20, m22)
	} else {
		rz = math.Atan2(m10, m00)
		ry = 0
	}
	deg := 180 / math.Pi
	return rz * deg, rx * deg, ry * deg
}

func buildBVH(roots, rotations []float32, skeleton skeletonDefinition, scale float64) []byte {
	joints := len(skeleton.parents)
	frames := len(roots) / 3
	children := make([][]int, joints)
	for j, p := range skeleton.parents {
		if p >= 0 {
			children[p] = append(children[p], j)
		}
	}
	var sb strings.Builder
	sb.WriteString("HIERARCHY\n")
	var write func(j, depth int)
	write = func(j, depth int) {
		indent := strings.Repeat("\t", depth)
		o := skeleton.offsets[j]
		if skeleton.parents[j] < 0 {
			fmt.Fprintf(&sb, "ROOT %s\n%s{\n%s\tOFFSET 0.000000 0.000000 0.000000\n%s\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n", skeleton.names[j], indent, indent, indent)
		} else {
			fmt.Fprintf(&sb, "%sJOINT %s\n%s{\n%s\tOFFSET %.6f %.6f %.6f\n%s\tCHANNELS 3 Zrotation Xrotation Yrotation\n", indent, skeleton.names[j], indent, indent, float64(o[0])*scale, float64(o[1])*scale, float64(o[2])*scale, indent)
		}
		if len(children[j]) == 0 {
			fmt.Fprintf(&sb, "%s\tEnd Site\n%s\t{\n%s\t\tOFFSET 0.000000 %.6f 0.000000\n%s\t}\n", indent, indent, indent, 0.05*scale, indent)
		}
		for _, c := range children[j] {
			write(c, depth+1)
		}
		fmt.Fprintf(&sb, "%s}\n", indent)
	}
	write(0, 0)
	fmt.Fprintf(&sb, "MOTION\nFrames: %d\nFrame Time: %.6f\n", frames, 1.0/fps)
	// Channel order follows the hierarchy walk.
	var order []int
	var walk func(j int)
	walk = func(j int) {
		order = append(order, j)
		for _, c := range children[j] {
			walk(c)
		}
	}
	walk(0)
	for f := 0; f < frames; f++ {
		parts := make([]string, 0, 3+joints*3)
		parts = append(parts, fmt.Sprintf("%.4f %.4f %.4f", float64(roots[f*3])*scale, float64(roots[f*3+1])*scale, float64(roots[f*3+2])*scale))
		for _, j := range order {
			at := (f*joints + j) * 4
			rz, rx, ry := quatToEulerZXY(float64(rotations[at]), float64(rotations[at+1]), float64(rotations[at+2]), float64(rotations[at+3]))
			parts = append(parts, fmt.Sprintf("%.4f %.4f %.4f", rz, rx, ry))
		}
		sb.WriteString(strings.Join(parts, " "))
		sb.WriteString("\n")
	}
	return []byte(sb.String())
}
