# Repurpose third-party components

## OpenCV and YuNet face detector

- Project: OpenCV (`opencv-python-headless`) and OpenCV Zoo YuNet
- Upstream: https://github.com/opencv/opencv and https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
- Model file: `face_detection_yunet_2023mar.onnx`
- Model source revision: OpenCV Zoo `47534e27c9851bb1128ccc0102f1145e27f23f98`, downloaded for SAI-15 on 2026-08-13
- Model SHA-256: `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`
- License: Apache-2.0 for OpenCV/OpenCV Zoo; the YuNet model directory declares MIT
- Use: local CPU face bounding boxes and confidence only
- Modifications: none to the model; Vidmyo wraps OpenCV's public `FaceDetectorYN` API
- Notices: the verbatim model-directory license ships as `models/YUNET_LICENSE`

Vidmyo does not copy ClipsAI, OpenSource Clipping, PodCLI, or other clipping
pipelines. They informed product research only. In particular, no AGPL code or
token-gated diarization component is linked into this package.
