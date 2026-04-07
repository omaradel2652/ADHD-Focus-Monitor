import { FilesetResolver, FaceDetector, FaceLandmarker } from './mediapipe/vision_bundle.js';
window.FilesetResolver = FilesetResolver;
window.FaceDetector = FaceDetector;
window.FaceLandmarker = FaceLandmarker;
window.mediapipeReady = true;
console.log('[MediaPipe Loader] Ready');