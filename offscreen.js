chrome.runtime.sendMessage({type:'OFFSCREEN_LOG',message:'line 1'}).catch(()=>{});
console.log('[Offscreen] *** offscreen.js v4 (FaceLandmarker) starting ***');

chrome.runtime.sendMessage({type:'OFFSCREEN_LOG',message:'line 2 - about to call waitForMediaPipe'}).catch(()=>{});

waitForMediaPipe();

chrome.runtime.sendMessage({type:'OFFSCREEN_LOG',message:'line 3 - waitForMediaPipe called'}).catch(()=>{});

async function waitForMediaPipe() {
  try {
    chrome.runtime.sendMessage({type:'OFFSCREEN_LOG',
      message:'waitForMediaPipe entered'}).catch(()=>{});
    
    let tries = 0;
    while (tries < 50) {
      chrome.runtime.sendMessage({type:'OFFSCREEN_LOG',
        message:'try ' + tries + ' FaceLandmarker=' + 
        typeof window.FaceLandmarker}).catch(()=>{});
      
      if (window.FaceLandmarker && window.FilesetResolver) {
        break;
      }
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
    
    chrome.runtime.sendMessage({type:'OFFSCREEN_LOG',
      message:'MediaPipe ready after ' + tries + ' tries'
    }).catch(()=>{});
    
    startTracking();
  } catch(e) {
    chrome.runtime.sendMessage({type:'OFFSCREEN_ERROR',
      error: 'waitForMediaPipe failed: ' + e.message
    }).catch(()=>{});
  }
}

async function startTracking() {
  chrome.runtime.sendMessage({type:'OFFSCREEN_LOG', message:'startTracking entered'}).catch(()=>{});

  try {
    // 1. Resolve WASM files from local mediapipe/ folder
    chrome.runtime.sendMessage({type:'OFFSCREEN_LOG', message:'step 1: resolve WASM...'}).catch(()=>{});
    const wasmPath = chrome.runtime.getURL('mediapipe');
    const vision = await window.FilesetResolver.forVisionTasks(wasmPath);
    chrome.runtime.sendMessage({type:'OFFSCREEN_LOG', message:'step 1 complete: FilesetResolver done'}).catch(()=>{});

    // 2. Create FaceLandmarker with local model file
    chrome.runtime.sendMessage({type:'OFFSCREEN_LOG', message:'step 2: load FaceLandmarker...'}).catch(()=>{});
    const modelPath = chrome.runtime.getURL('mediapipe/face_landmarker.task');

    const faceLandmarker = await window.FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: 'CPU'
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: true
    });
    chrome.runtime.sendMessage({type:'OFFSCREEN_LOG', message:'step 2 complete: FaceLandmarker created'}).catch(()=>{});

    // 3. Open camera
    chrome.runtime.sendMessage({type:'OFFSCREEN_LOG', message:'step 3: requesting camera...'}).catch(()=>{});
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: 'user' }
    });
    chrome.runtime.sendMessage({type:'OFFSCREEN_LOG', message:'step 3 complete: camera granted'}).catch(()=>{});

    const video = document.createElement('video');
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    document.body.appendChild(video);

    await new Promise(resolve => {
      video.onloadedmetadata = () => resolve();
    });

    await video.play();
    console.log('[Offscreen] Video dimensions:', video.videoWidth, 'x', video.videoHeight);
    chrome.runtime.sendMessage({type:'OFFSCREEN_LOG', message:'video playing: ' + video.videoWidth + 'x' + video.videoHeight}).catch(()=>{});

    // 4. Detection loop (Using setInterval because requestAnimationFrame pauses offscreen)
    chrome.runtime.sendMessage({type:'OFFSCREEN_LOG', message:'starting setInterval detection loop...'}).catch(()=>{});
    
    setInterval(() => {
      if (!video || video.paused || video.readyState < 2) return;
      
      try {
        const results = faceLandmarker.detectForVideo(video, performance.now());
        const hasFace = results.faceLandmarks && results.faceLandmarks.length > 0;
        
        let eyeBlinkLeft = 0;
        let eyeBlinkRight = 0;
        
        if (hasFace && results.faceBlendshapes && results.faceBlendshapes.length > 0) {
          const bs = results.faceBlendshapes[0].categories || [];
          const lb = bs.find(c => c.categoryName === 'eyeBlinkLeft');
          const rb = bs.find(c => c.categoryName === 'eyeBlinkRight');
          eyeBlinkLeft = lb ? lb.score : 0;
          eyeBlinkRight = rb ? rb.score : 0;
        }
        
        chrome.runtime.sendMessage({
          type: 'FACE_RESULTS',
          hasFace: hasFace,
          landmarks: hasFace ? results.faceLandmarks[0] : [],
          blendshapes: hasFace && results.faceBlendshapes ? results.faceBlendshapes[0] : null,
          eyeBlinkLeft: eyeBlinkLeft,
          eyeBlinkRight: eyeBlinkRight
        }).catch(() => {});
        
      } catch(e) {
        chrome.runtime.sendMessage({type:'OFFSCREEN_ERROR', error: 'detectLoop fail: ' + e.message}).catch(()=>{});
      }
    }, 100);

  } catch (e) {
    chrome.runtime.sendMessage({type:'OFFSCREEN_ERROR', error: 'startTracking fail: ' + e.message}).catch(()=>{});
  }
}

// Global error handler for silent background crashes
window.onerror = function(msg, src, line, col, err) {
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_ERROR',
    error: msg + ' at ' + src + ':' + line
  }).catch(() => {});
};
window.addEventListener('unhandledrejection', function(event) {
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_ERROR',
    error: 'Unhandled Promise: ' + (event.reason ? event.reason.message || event.reason : 'Unknown')
  }).catch(() => {});
});