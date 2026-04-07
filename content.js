/**
 * ADHD Focus Monitor — content.js
 * Phase 2: MediaPipe FaceMesh Monitoring & Intervention Ladder
 */

(function () {
    let state = {
        active: false,
        condition: 'A', // A=Full, B=Sham (set dynamically per day)
        apiKey: null,
        startTime: 0,
        duration: 0,
        score: 100,
        distractions: 0,
        topic: '',
        reason: '',
        summary: '',
        day: 1,

        // Monitoring
        faceDetected: false,
        headLostCounter: 0,
        isGazeDrifting: false,
        gazeDriftCounter: 0,
        blinks: [],
        lastEAR: 1.0,
        eyeClosed: false,
        eyeCloseStart: 0,
        lastBlinkTime: 0,
        isDistracted: false,
        lastSignal: 'none',

        // Intervention
        currentEventId: null,
        level: 0,
        refocusTimer: null,
        debug: true, // Visible during testing
        calibrated: false, // MediaPipe doesn't need manual 9-dot calibration like WebGazer

        // Analytics
        totalSessionBlinks: 0,
        highestBlinkRate: 0,
        interventionsSent: 0,
        syncTimer: null
    };

    const API_URL = 'https://api.cerebras.ai/v1/chat/completions';
    const MODEL = 'llama3.1-8b';

    let faceMesh = null;
    let camera = null;

    // ─── DEBUGGING ───────────────────────────────────────────────

    chrome.storage.local.get('activeSession', (data) => {
        console.log('[ADHD Debug] activeSession on load:', JSON.stringify(data.activeSession));
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.activeSession) {
            console.log('[ADHD Debug] activeSession changed:', JSON.stringify(changes.activeSession.newValue));
            // Automatically init if session was just started
            if (changes.activeSession.newValue && !state.active) {
                state.active = true;
                init();
            }
        }
    });

    // Fallback 1: Direct Message + FACE_RESULTS forwarding
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === 'SESSION_START_DIRECT') {
            console.log('[ADHD Debug] Direct message received!');
            if (!state.active) {
                state.active = true;
                init().then(() => {
                    // Force overlay to appear immediately without page reload
                    ensureDebugOverlay();
                    updateDebugOverlay();
                    if (!state.overlayInterval) {
                        state.overlayInterval = setInterval(updateDebugOverlay, 500);
                    }
                });
            }
        }
        if (msg.type === 'SESSION_END_DIRECT') {
            console.log('[ADHD] Session end received — cleaning up.');
            state.active = false;

            // Clear all intervals
            if (state.overlayInterval) { clearInterval(state.overlayInterval); state.overlayInterval = null; }
            if (state.syncTimer) { clearInterval(state.syncTimer); state.syncTimer = null; }
            if (state.summaryInterval) { clearInterval(state.summaryInterval); state.summaryInterval = null; }
            if (state.escalationTimer) { clearTimeout(state.escalationTimer); state.escalationTimer = null; }
            if (state.focusResetTimer) { clearTimeout(state.focusResetTimer); state.focusResetTimer = null; }

            // Remove debug overlay
            document.getElementById('adhd-mp-debug')?.remove();
            // Remove intervention overlay container
            document.getElementById('adhd-ai-overlay-container')?.remove();
            // Remove full chatbot
            document.getElementById('adhd-full-chatbot')?.remove();
            // Remove timer bar
            document.getElementById('adhd-timer-bar')?.remove();

            return;
        }
        if (msg.type === 'FACE_RESULTS') {
            // Process face data into state
            processFaceResults(msg.hasFace, msg.landmarks, msg.eyeBlinkLeft, msg.eyeBlinkRight);
            return true;
        }
    });

    // Fallback 2: Polling
    const pollInterval = setInterval(async () => {
        if (state.active) {
            clearInterval(pollInterval);
            return;
        }
        const data = await chrome.storage.local.get('activeSession');
        if (data.activeSession && !state.active) {
            console.log('[ADHD Debug] Polling found session:', data.activeSession);
            state.active = true;
            clearInterval(pollInterval);
            init();
        }
    }, 2000);

    // ─── INITIALIZATION ──────────────────────────────────────────

    // Inject base URL into page so mediapipe loader can find it
    const marker = document.createElement('script');
    marker.dataset.adhdBase = chrome.runtime.getURL('mediapipe/');
    marker.id = 'adhd-base-marker';
    document.head.appendChild(marker);

    async function init() {
        console.log('[ADHD Monitor] Content script loaded.');

        chrome.storage.local.get('activeSession', (data) => {
            console.log('[ADHD Debug] init() checking session:', JSON.stringify(data.activeSession));
        });

        const data = await chrome.storage.local.get([
            'activeSession', 'current_topic', 'study_reason',
            'running_summary', 'focus_score', 'distraction_count',
            'experiment_day', 'cerebras_api_key', 'participant_code',
            'condition', 'dev_mode'
        ]);

        if (data.activeSession) {
            console.log('[ADHD] Session detected. Initializing MediaPipe...');
            state.active = true;
            state.condition = data.condition || 'A';
            state.apiKey = data.cerebras_api_key;
            state.pCode = data.participant_code || 'P001';
            state.startTime = data.activeSession.startTime;
            state.duration = data.activeSession.duration;
            state.score = data.focus_score ?? 100;
            state.distractions = data.distraction_count ?? 0;
            state.topic = data.current_topic || '';
            state.reason = data.study_reason || '';
            state.summary = data.running_summary || '';
            state.day = data.experiment_day || 1;
            state.level = data.current_level || 0;
            state.devMode = data.dev_mode || false;

            // Phase 5: Transcript Extraction
            updateContextSummary();
            if (state.summaryInterval) clearInterval(state.summaryInterval);
            state.summaryInterval = setInterval(updateContextSummary, 5 * 60 * 1000);

            injectTimerBar();
            ensureDebugOverlay();
            await setupMediaPipe();
            showDebugOverlay();

            // Refresh overlay UI independently of message arrivals
            if (state.overlayInterval) clearInterval(state.overlayInterval);
            state.overlayInterval = setInterval(updateDebugOverlay, 500);

            if (state.syncTimer) clearInterval(state.syncTimer);
            state.syncTimer = setInterval(() => {
                if (!state.active) return;
                chrome.storage.local.set({
                    blinkStats: { 
                        total: state.totalSessionBlinks || 0, 
                        highest: state.highestBlinkRate || 0 
                    },
                    interventions_sent: state.interventionsSent || 0
                });
            }, 2000);
        }
    }

    async function setupMediaPipe() {
        console.log('[ADHD Debug] setupMediaPipe called (Offscreen Architecture)');
        
        // Tell offscreen to start camera and FaceMesh
        chrome.runtime.sendMessage({ type: 'START_FACE_TRACKING' });
        console.log('[MediaPipe] Offscreen capture loop started');
        // FACE_RESULTS listener is registered globally above
    }


    // ─── MONITORING ──────────────────────────────────────────────

    function processFaceResults(hasFace, landmarks, eyeBlinkLeft, eyeBlinkRight) {
        if (!state.active) return;

        // Signal 1: Head Movement (Face lost)
        if (!hasFace) {
            if (state.faceDetected) {
                console.log('[ADHD] Face lost');
                state.faceDetected = false;
            }
            state.headLostCounter += 100;
            checkDistractionStatus('head_movement');
            return;
        }

        if (!state.faceDetected) {
            console.log('[ADHD] Face detected');
            state.faceDetected = true;
        }
        state.headLostCounter = 0;

        // Signal 2: Gaze Direction (requires 478 landmarks from FaceLandmarker)
        if (landmarks && landmarks.length >= 468) {
            handleGaze(landmarks);
        }

        // Signal 3: Blink Rate
        if (eyeBlinkLeft !== undefined && eyeBlinkRight !== undefined && (eyeBlinkLeft > 0 || eyeBlinkRight > 0)) {
            handleBlinkScores(eyeBlinkLeft, eyeBlinkRight);
        } else if (landmarks && landmarks.length >= 468) {
            handleBlinks(landmarks);
        }

        checkDistractionStatus();
    }

    // ─── CONTEXT EXTRACTION (PHASE 5) ────────────────────────────

    async function updateContextSummary() {
        if (!state.active) return;
        const text = (await getYouTubeTranscript()) || getPageContent();
        if (text) {
            state.summary = text;
            chrome.storage.local.set({ running_summary: text });
            console.log('[ADHD] Updated running_summary (length = ' + text.length + ')');
        }
    }

    async function getYouTubeTranscript() {
        try {
            const videoId = new URLSearchParams(window.location.search).get('v');
            if (!videoId) return null;

            const response = await fetch(
                `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}&fmt=json3`
            );
            if (!response.ok) return null;

            const data = await response.json();
            const text = data.events
                ?.filter(e => e.segs)
                ?.map(e => e.segs.map(s => s.utf8).join(''))
                ?.join(' ')
                ?.replace(/\s+/g, ' ')
                ?.trim();

            return text ? text.substring(0, 1500) : null;
        } catch(e) {
            return null;
        }
    }

    function getPageContent() {
        const body = document.body.innerText;
        return body ? body.substring(0, 1500).replace(/\s+/g, ' ').trim() : '';
    }

    function handleBlinkScores(leftScore, rightScore) {
        const isBlinking = leftScore > 0.35 || rightScore > 0.35;
        const now = Date.now();

        if (isBlinking && !state.eyeClosed) {
            state.eyeClosed = true;
            state.eyeCloseStart = now;
        } else if (!isBlinking && state.eyeClosed) {
            const duration = now - state.eyeCloseStart;
            state.eyeClosed = false;
            
            if (duration >= 80 && duration <= 400 && now - state.lastBlinkTime > 200) {
                // Valid blink!
                state.blinks.push(now);
                state.lastBlinkTime = now;
                state.totalSessionBlinks = (state.totalSessionBlinks || 0) + 1;
            } else if (duration > 500) {
                console.log('[ADHD] Long eye closure detected:', duration, 'ms');
            }
        }

        // Rolling 60s window
        state.blinks = state.blinks.filter(t => now - t < 60000);
        state.highestBlinkRate = Math.max(state.highestBlinkRate || 0, state.blinks.length);
    }

    function handleGaze(landmarks) {
        // Left eye corners: 33, 133. Left iris: 468
        // Right eye corners: 362, 263. Right iris: 473
        const leftIris = landmarks[468];
        const leftL = landmarks[33];
        const leftR = landmarks[133];

        const irisPos = (leftIris.x - leftL.x) / (leftR.x - leftL.x);

        if (irisPos < 0.2 || irisPos > 0.8) {
            state.isGazeDrifting = true;
            state.gazeDriftCounter += 33;
        } else {
            state.isGazeDrifting = false;
            state.gazeDriftCounter = 0;
        }
    }

    function handleBlinks(landmarks) {
        // EAR = (dist(top,bottom)) / (dist(left,right))
        // Left eye: 159 (top), 145 (bottom), 33 (left), 133 (right)
        const top = landmarks[159];
        const bot = landmarks[145];
        const left = landmarks[33];
        const right = landmarks[133];

        const vert = Math.abs(top.y - bot.y);
        const horiz = Math.abs(left.x - right.x);
        const ear = vert / horiz;

        if (ear < 0.18 && state.lastEAR >= 0.18) {
            const now = Date.now();
            state.blinks.push(now);
            state.totalSessionBlinks = (state.totalSessionBlinks || 0) + 1;
            console.log('[ADHD] Blink detected');
        }
        state.lastEAR = ear;

        // Rolling 60s window
        const now = Date.now();
        state.blinks = state.blinks.filter(t => now - t < 60000);
        state.highestBlinkRate = Math.max(state.highestBlinkRate || 0, state.blinks.length);
    }

    function handleHeadPose(headPose) {
        const { pitch, yaw, roll } = headPose;
        // Define thresholds for significant head movement
        const PITCH_THRESHOLD = 0.2; // radians, ~11 degrees
        const YAW_THRESHOLD = 0.2;   // radians, ~11 degrees
        const ROLL_THRESHOLD = 0.2;  // radians, ~11 degrees

        if (Math.abs(pitch) > PITCH_THRESHOLD || Math.abs(yaw) > YAW_THRESHOLD || Math.abs(roll) > ROLL_THRESHOLD) {
            state.isHeadMoving = true;
            state.headMovementCounter += 33; // Increment counter for each frame
        } else {
            state.isHeadMoving = false;
            state.headMovementCounter = 0;
        }
    }

    function checkDistractionStatus(forcedSignal = null) {
        let signal = forcedSignal;
        const now = Date.now();

        if (state.headLostCounter >= 3000) signal = 'head_lost';
        else if (state.gazeDriftCounter >= 3000) signal = 'gaze_drift';
        else if (state.blinks.length > 25) signal = 'blink_rate';
        else if (state.headMovementCounter >= 3000) signal = 'head_movement'; // New signal

        state.lastSignal = signal || 'none';

        if (signal && !state.isDistracted) {
            triggerDistracted(signal);
        } else if (!signal && state.isDistracted) {
            restoreFocus();
        }
    }

    // ─── DISTRACTION HANDLING ────────────────────────────────────

    async function triggerDistracted(trigger) {
        console.log(`[ADHD] DISTRACTED fired: ${trigger}`);
        state.isDistracted = true;
        state.distractions++;
        state.score = Math.max(0, state.score - 1);

        if (state.focusResetTimer) {
            clearTimeout(state.focusResetTimer);
            state.focusResetTimer = null;
        }

        chrome.storage.local.set({
            distraction_count: state.distractions,
            focus_score: state.score,
            current_level: state.level
        });

        // Fire intervention first, then log to Supabase with complete data
        await fireIntervention(trigger);
    }

    function restoreFocus() {
        console.log('[ADHD] Focus restored');
        state.isDistracted = false;
        
        if (state.escalationTimer) {
            clearTimeout(state.escalationTimer);
            state.escalationTimer = null;
        }

        if (state.currentEventId) {
            chrome.runtime.sendMessage({
                type: 'UPDATE_INTERVENTION',
                payload: { id: state.currentEventId, result: 'success' }
            });
            state.currentEventId = null;
        }

        // 2-minute focus reset timer
        if (state.focusResetTimer) clearTimeout(state.focusResetTimer);
        state.focusResetTimer = setTimeout(() => {
            if (!state.isDistracted) {
                console.log('[ADHD] 2 minutes of continuous focus. Resetting level to 0.');
                state.level = 0;
                chrome.storage.local.set({ current_level: 0 });
            }
        }, 120000);
    }

    async function fireIntervention(trigger) {
        if (!state.devMode && state.day <= 2) {
            console.log('[ADHD] Calibration mode (Day ' + state.day + ') - logging only');
            return;
        }

        // Sham Condition Check
        if (state.condition === 'B' && Math.random() < 0.5) {
            console.log('[ADHD] Condition B: Sham skip intervention UI');
            logShamSkip();
            return;
        }

        state.level++;
        const currentLevel = Math.min(state.level, 5);
        chrome.storage.local.set({ current_level: currentLevel });

        state.interventionsSent = (state.interventionsSent || 0) + 1;
        chrome.storage.local.set({ interventions_sent: state.interventionsSent });

        // Determine points deducted
        let pointsDeducted = 1; // base deduction from triggerDistracted
        if (currentLevel >= 2) {
            state.score = Math.max(0, state.score - 1);
            chrome.storage.local.set({ focus_score: state.score });
            pointsDeducted = 2; // extra deduction for mechanical levels
        }

        // Determine mechanical action string
        let mechanicalAction = 'none';
        if (currentLevel >= 2 && currentLevel <= 3) {
            const v = document.querySelector('video');
            mechanicalAction = v ? 'video_skip' : 'scroll';
        } else if (currentLevel === 4) {
            mechanicalAction = 'border_flash';
        } else if (currentLevel >= 5) {
            mechanicalAction = 'chatbot';
        }

        console.log(`[ADHD] Firing Intervention Level ${currentLevel}`);

        playChime();

        // Get AI message FIRST
        const aiMessage = await getInterventionAI(currentLevel);
        if (aiMessage && currentLevel < 5) showAIOverlay(aiMessage, currentLevel);

        executeEffect(currentLevel);

        // NOW log to Supabase with complete data
        const timeInSession = (Date.now() - state.startTime) / 60000;
        const eventData = {
            participant_code: state.pCode,
            trigger_signal: trigger || state.lastSignal || 'unknown',
            escalation_level: currentLevel,
            time_in_session_minutes: timeInSession,
            ai_message_sent: aiMessage || '',
            mechanical_action: mechanicalAction,
            points_deducted: pointsDeducted
        };

        chrome.runtime.sendMessage({ type: 'LOG_DISTRACTION', payload: eventData }, (resp) => {
            if (resp && resp.id) state.currentEventId = resp.id;
        });

        // Escalation check after 30s
        if (state.escalationTimer) clearTimeout(state.escalationTimer);
        state.escalationTimer = setTimeout(() => {
            if (state.isDistracted) {
                console.log('[ADHD] Still distracted after 30s, escalating...');
                playBuzz();
                chrome.runtime.sendMessage({
                    type: 'UPDATE_INTERVENTION',
                    payload: { id: state.currentEventId, result: 'fail' }
                });
                fireIntervention(trigger); // Escalate with same trigger
            }
        }, 30000);
    }

    function logShamSkip() {
        if (state.currentEventId) {
            chrome.runtime.sendMessage({
                type: 'UPDATE_INTERVENTION',
                payload: { id: state.currentEventId, result: 'sham_skipped' }
            });
        }
    }

    // ─── EFFECTS & UI ────────────────────────────────────────────

    function executeEffect(level) {
        if (level >= 2) {
            const v = document.querySelector('video');
            if (v) v.currentTime = Math.max(0, v.currentTime - 30);
            else window.scrollBy(0, -300);
        }
        if (level === 4) flashBorder();
        if (level >= 5) showFullChatbot();
    }

    function showAIOverlay(msg, level) {
        let container = document.getElementById('adhd-ai-overlay-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'adhd-ai-overlay-container';
            container.style.cssText = 'position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;';
            document.body.appendChild(container);

            const style = document.createElement('style');
            style.textContent = `
                @keyframes adhd-slide-in {
                    from { opacity: 0; transform: translateX(20px) translateY(-8px); }
                    to { opacity: 1; transform: translateX(0) translateY(0); }
                }
                @keyframes adhd-drain {
                    from { width: 100%; }
                    to { width: 0%; }
                }
                .adhd-notification {
                    position: fixed; top: 20px; right: 20px;
                    display: inline-block;
                    max-width: 360px; width: calc(100vw - 40px);
                    background: rgba(40, 30, 60, 0.85); /* Not that transparent purple */
                    backdrop-filter: blur(20px) saturate(180%);
                    -webkit-backdrop-filter: blur(20px) saturate(180%);
                    border: 1px solid rgba(255, 255, 255, 0.25);
                    border-radius: 16px;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), 0 2px 8px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.3);
                    padding: 20px 24px;
                    pointer-events: auto;
                    animation: adhd-slide-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
                    overflow: hidden;
                }
                .adhd-notif-level {
                    font-size: 11px; color: rgba(255, 255, 255, 0.5);
                    text-transform: uppercase; letter-spacing: 1.5px;
                    margin-bottom: 8px; font-weight: 600;
                }
                .adhd-notif-text {
                    color: white; font-size: 15px; line-height: 1.6; font-weight: 400;
                    margin-right: 20px;
                    word-wrap: break-word;
                }
                .adhd-notif-close {
                    position: absolute; top: 12px; right: 12px;
                    background: none; border: none; color: rgba(255, 255, 255, 0.5);
                    font-size: 20px; cursor: pointer; padding: 4px; line-height: 1;
                }
                .adhd-notif-progress {
                    position: absolute; bottom: 0; left: 0;
                    height: 3px; background: rgba(108, 99, 255, 0.8);
                    animation: adhd-drain 8s linear forwards;
                }
            `;
            document.head.appendChild(style);
        }

        const notif = document.createElement('div');
        notif.className = 'adhd-notification';
        notif.innerHTML = `
            <button class="adhd-notif-close">×</button>
            <div class="adhd-notif-level">Level ${level}</div>
            <div class="adhd-notif-text">${msg}</div>
            <div class="adhd-notif-progress"></div>
        `;

        container.appendChild(notif);

        const dismiss = () => {
            if (!notif.parentNode) return;
            notif.style.opacity = '0';
            notif.style.transform = 'translateX(20px)';
            notif.style.transition = 'all 0.3s ease';
            setTimeout(() => notif.remove(), 300);
        };

        notif.querySelector('.adhd-notif-close').onclick = dismiss;
        setTimeout(dismiss, 8000);
    }

    function playChime() {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1100, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
    }

    function playBuzz() {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
    }

    function flashBorder() {
        const overlay = document.createElement('div');
        overlay.id = 'adhd-flash-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            pointer-events: none;
            z-index: 999997;
            background: transparent;
            box-shadow: inset 0 0 80px 40px rgba(108, 99, 255, 0.6);
            animation: adhd-damage-flash 0.4s ease-out 3;
        `;
        const style = document.createElement('style');
        style.id = 'adhd-flash-style';
        style.textContent = `
            @keyframes adhd-damage-flash {
                0%   { opacity: 1; }
                50%  { opacity: 0.2; }
                100% { opacity: 1; }
            }
        `;
        document.head.appendChild(style);
        document.body.appendChild(overlay);
        setTimeout(() => {
            overlay.remove();
            document.getElementById('adhd-flash-style')?.remove();
        }, 1200);
    }

    // ─── DEBUG OVERLAY ───────────────────────────────────────────

    function ensureDebugOverlay() {
        if (document.getElementById('adhd-mp-debug')) return;
        const div = document.createElement('div');
        div.id = 'adhd-mp-debug';
        div.style.cssText = 'position:fixed;top:10px;left:10px;z-index:999999;background:rgba(0,0,0,0.8);color:#0f0;padding:10px;border-radius:5px;font-family:monospace;font-size:12px;pointer-events:none;';
        document.body.appendChild(div);
    }

    function showDebugOverlay() {
        ensureDebugOverlay();
        updateDebugOverlay();
    }

    function updateDebugOverlay() {
        const div = document.getElementById('adhd-mp-debug');
        if (!div || !state.debug) return;

        let dot = '🟢';
        if (state.isGazeDrifting) dot = '🟡';
        if (state.isDistracted) dot = '🔴';

        const mode = (!state.devMode && state.day <= 3) ? '<br>CALIBRATION - logging only' : '';

        div.innerHTML = `
            ${dot} Face: ${state.faceDetected ? 'OK' : 'LOST'}<br>
            Signal: ${state.lastSignal}<br>
            Count: ${state.distractions}<br>
            Score: ${state.score}<br>
            Blinks (60s): ${state.blinks.length}
            ${mode}
        `;
        div.style.display = 'block';
    }

    window.addEventListener('keydown', (e) => {
        if (e.altKey && e.key === 'd') {
            state.debug = !state.debug;
            updateDebugOverlay();
        }
    });

    // ─── HELPERS ─────────────────────────────────────────────────

    function injectTimerBar() {
        // Reuse logic from previous version
        if (document.getElementById('adhd-timer-bar')) return;
        const bar = document.createElement('div');
        bar.id = 'adhd-timer-bar';
        const fill = document.createElement('div');
        fill.id = 'adhd-timer-fill';
        bar.appendChild(fill);
        document.body.appendChild(bar);

        setInterval(() => {
            if (!state.startTime) return;
            const elapsed = (Date.now() - state.startTime) / (state.duration * 60000);
            const remain = Math.max(0, 100 - (elapsed * 100));
            fill.style.width = `${remain}%`;
        }, 1000);
    }

    async function getInterventionAI(level, userMessage = null) {
        if (!state.apiKey) return "Let's stay focused on our goal!";
        
        const timeElapsed = (Date.now() - state.startTime) / 60000;
        const timeRemaining = Math.max(0, state.duration - timeElapsed).toFixed(0);
        
        let sys = `You are a warm ADHD focus coach. 
Topic: ${state.topic}. Reason: ${state.reason}. 
Distractions: ${state.distractions}. Score: ${state.score}. 
Time remaining: ${timeRemaining} minutes. Level: ${level}.
Recent Content: ${state.summary ? state.summary.substring(0, 500) : 'None'}.
Respond in 1-2 sentences only. No bullets.`;

        let messages = [{ role: 'system', content: sys }];
        if (userMessage) {
            messages.push({ role: 'user', content: userMessage });
        }

        try {
            const r = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
                body: JSON.stringify({ model: MODEL, messages: messages, max_tokens: 150 })
            });
            const d = await r.json();
            return d.choices?.[0]?.message?.content;
        } catch (e) { return null; }
    }

    function showFullChatbot() {
        if (document.getElementById('adhd-full-chatbot')) return;

        console.log('[ADHD] Level 5 reached. Opening focus reset chatbot.');

        const panel = document.createElement('div');
        panel.id = 'adhd-full-chatbot';
        panel.style.cssText = `
            position: fixed; top: 20px; right: 20px; z-index: 2147483647;
            width: 400px; height: 500px;
            background: #1e1e2e; border-radius: 16px; border: 1px solid #6c63ff; 
            box-shadow: 0 10px 40px rgba(0,0,0,0.5);
            display: flex; flex-direction: column;
            font-family: 'Inter', sans-serif; color: #fff;
            overflow: hidden;
            animation: adhd-chatbot-slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        `;

        let style = document.getElementById('adhd-chatbot-anim-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'adhd-chatbot-anim-style';
            style.textContent = `
                @keyframes adhd-chatbot-slide-in {
                    from { transform: translateX(30px); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
            `;
            document.head.appendChild(style);
        }

        panel.innerHTML = `
            <div style="padding: 15px 20px; border-bottom: 1px solid #313244; display: flex; align-items: center; justify-content: space-between; background: #6c63ff;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <span style="font-size: 20px;">🧠</span>
                    <div>
                        <div style="font-weight: 700; color: white;">Focus Reset Required</div>
                        <div style="font-size: 11px; opacity: 0.8; color: white;">Please respond to continue</div>
                    </div>
                </div>
                <button class="adhd-chatbot-close" style="background: none; border: none; color: white; font-size: 24px; cursor: pointer; padding: 0;">&times;</button>
            </div>
            <div id="adhd-full-chat-msgs" style="flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 10px; background: #1e1e2e;"></div>
            <div style="padding: 15px 20px; border-top: 1px solid #313244; display: flex; gap: 10px; background: #181825;">
                <input id="adhd-full-chat-input" type="text" placeholder="Type your response..." style="flex: 1; background: #2a2f47; border: 1px solid #313244; color: #fff; border-radius: 8px; padding: 10px; outline: none;">
                <button id="adhd-full-chat-send" style="background: #6c63ff; color: #fff; border: none; border-radius: 8px; padding: 0 15px; cursor: pointer; font-weight: 600;">Send</button>
            </div>
        `;
        document.body.appendChild(panel);

        panel.querySelector('.adhd-chatbot-close').onclick = () => panel.remove();

        const msgs = panel.querySelector('#adhd-full-chat-msgs');
        const input = panel.querySelector('#adhd-full-chat-input');
        const send = panel.querySelector('#adhd-full-chat-send');

        const addMsg = (role, text) => {
            const m = document.createElement('div');
            m.style.cssText = `
                padding: 10px 14px; border-radius: 12px; font-size: 13px; max-width: 80%;
                ${role === 'ai' ? 'background: #2a2f47; align-self: flex-start;' : 'background: #6c63ff; align-self: flex-end; margin-left: auto;'}
            `;
            m.textContent = text;
            msgs.appendChild(m);
            msgs.scrollTop = msgs.scrollHeight;
        };

        const handleSend = async () => {
            const txt = input.value.trim();
            if (!txt) return;
            input.value = '';
            addMsg('usr', txt);

            const reply = await getInterventionAI(6, txt);
            if (reply) {
                addMsg('ai', reply);
                if (reply.toLowerCase().includes('good luck') || reply.toLowerCase().includes('back to work')) {
                    setTimeout(() => panel.remove(), 2000);
                }
            }
        };

        send.onclick = handleSend;
        input.onkeydown = (e) => { if (e.key === 'Enter') handleSend(); };

        addMsg('ai', "Hey! It seems you've drifted off quite a bit. Let's take a quick breath. How's the focus going right now?");
    }

})();
