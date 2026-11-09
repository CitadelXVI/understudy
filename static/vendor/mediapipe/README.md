# MediaPipe Tasks Vision (vendored)

`@mediapipe/tasks-vision` 1.1.1 (Apache-2.0, see LICENSE) with its wasm, plus the float16 `pose_landmarker_heavy` and
`hand_landmarker` models from storage.googleapis.com/mediapipe-models. Loaded by `js/mocap.js`; nothing is fetched from
the network at run time.

One local change: the bundle's usage logger posted to `https://odml.pa.googleapis.com/v1/log` every minute. That URL is
replaced with `http://127.0.0.1:9/mediapipe-logging-disabled`; the first failed send stops the logger for good.
Re-apply after updating the bundle.
