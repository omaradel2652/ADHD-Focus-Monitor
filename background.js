/**
 * ADHD Focus Monitor — background.js (Service Worker)
 * Timer logic relocated to Extension Icon Badge.
 */

importScripts('supabase.js');

// ─── OFFSCREEN DOCUMENT ───────────────────────────────────────
async function createOffscreenDocument() {
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    console.log('[Background] Existing offscreen:', existing.length);
    
    if (existing.length > 0) {
      console.log('[Background] Offscreen already exists');
      return;
    }
    
    console.log('[Background] Creating offscreen...');
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['USER_MEDIA'],
      justification: 'Face detection via webcam'
    });
    console.log('[Background] Offscreen created OK');
    
    // Verify after 3 seconds
    setTimeout(async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });
      console.log('[Background] Offscreen alive after 3s:', contexts.length);
    }, 3000);
    
  } catch(e) {
    console.error('[Background] Offscreen FAILED:', e.message, e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
    console.log('[ADHD Monitor] Extension installed. Phase 2 active.');
    resetIcon();
});

// ─── Listen for Message from Popup or Content Script ──────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_FACE_TRACKING') {
        // Forward to offscreen
        chrome.runtime.sendMessage({ 
            type: 'START_FACE_TRACKING' 
        }).catch(() => {});
        sendResponse({ success: true });
        return true;
    }

    if (msg.type === 'OFFSCREEN_LOG') {
        console.log('[Background] OFFSCREEN LOG:', msg.message);
        return true;
    }

    if (msg.type === 'OFFSCREEN_ERROR') {
        console.error('[Background] OFFSCREEN CRASH:', msg.error);
        return true;
    }

    if (msg.type === 'FACE_RESULTS') {
        // Forward to all valid tabs
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                if (tab.url && 
                    !tab.url.startsWith('chrome://') && 
                    !tab.url.startsWith('chrome-extension://')) {
                    chrome.tabs.sendMessage(tab.id, {
                        type: 'FACE_RESULTS',
                        hasFace: msg.hasFace,
                        landmarks: msg.landmarks || [],
                        blendshapes: msg.blendshapes || null,
                        eyeBlinkLeft: msg.eyeBlinkLeft || 0,
                        eyeBlinkRight: msg.eyeBlinkRight || 0
                    }).catch(() => {});
                }
            });
        });
        return true;
    }

    if (msg.type === 'SESSION_START') {
        handleSessionStart(msg.payload, msg.sessionPayload);
        sendResponse({ success: true });
        return true;
    }
    if (msg.type === 'SESSION_END') {
        handleSessionEnd();
        sendResponse({ success: true });
        return true;
    }

    // Phase 2: Distraction Logging
    if (msg.type === 'LOG_DISTRACTION') {
        handleLogDistraction(msg.payload, sendResponse);
        return true; // async response
    }
    if (msg.type === 'UPDATE_INTERVENTION') {
        handleUpdateIntervention(msg.payload, sendResponse);
        return true; // async response
    }
    if (msg.type === 'STATS_UPDATE') {
        // Potentially update badge or local cache
        updateBadge();
        sendResponse({ success: true });
    }

    // Phase 2 Fix: Handle permission granted from dedicated tab
    if (msg.type === 'PERMISSION_GRANTED') {
        handlePermissionGranted();
        return true;
    }
});

async function handlePermissionGranted() {
    const data = await chrome.storage.local.get(['pendingSession', 'participant_code']);
    if (!data.pendingSession) return;

    console.log('[Background] Permission granted. Starting session from pending...', JSON.stringify(data.pendingSession));

    const { topic, reason, mood, duration } = data.pendingSession;
    const now = Date.now();
    const sessionId = uuid();

    const sessionPayload = {
        session_active: true,
        session_start_time: now,
        current_topic: topic,
        study_reason: reason,
        current_mood: mood,
        session_duration: duration,
        focus_score: 100,
        distraction_count: 0,
        ai_interventions_sent: 0,
        mechanical_interventions_sent: 0,
        ai_refocus_success_count: 0,
        ai_refocus_fail_count: 0,
        max_level_reached: 0,
        running_summary: '',
        session_id: sessionId,
        participant_code: data.participant_code || 'P001',
        chat_done: true,
        activeSession: {
            startTime: now,
            duration: Number(duration),
            score: 100,
            topic: topic,
            reason: reason
        }
    };

    console.log('[Background] Saving sessionPayload to storage...');
    await chrome.storage.local.set(sessionPayload);
    await chrome.storage.local.remove('pendingSession');

    chrome.storage.local.get('activeSession', (d) => {
        console.log('[Background] Verified activeSession in storage:', d.activeSession);
    });

    handleSessionStart({ session_duration: duration }, sessionPayload);
}

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

async function handleLogDistraction(payload, sendResponse) {
    const data = await chrome.storage.local.get(['session_id', 'experiment_day', 'session_interventions']);
    await supabase.init();

    const eventData = {
        ...payload,
        session_id: data.session_id,
        experiment_day: data.experiment_day || 1
    };

    const result = await supabase.logDistractionEvent(eventData);
    const id = result && result[0] ? result[0].id : uuid();

    // Log for daily report
    const interventions = data.session_interventions || [];
    interventions.push({
        id: id,
        timestamp: Date.now(),
        level: eventData.escalation_level,
        type: eventData.trigger_signal,
        success: null // Will be updated
    });
    await chrome.storage.local.set({ session_interventions: interventions });

    sendResponse({ id: id, success: !!result });
}

async function handleUpdateIntervention(payload, sendResponse) {
    await supabase.init();
    const ok = await supabase.updateInterventionResult(payload.id, payload.result);

    // Update daily report log
    const data = await chrome.storage.local.get('session_interventions');
    const interventions = data.session_interventions || [];
    const event = interventions.find(e => e.id === payload.id);
    if (event) {
        event.success = (payload.result === 'success');
        await chrome.storage.local.set({ session_interventions: interventions });
    }

    sendResponse({ success: ok });
}

// ─── Listen for Storage Changes (Alternative to Messages) ─────
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.activeSession) {
        if (!changes.activeSession.newValue) {
            // Session ended
            handleSessionEnd();
        } else if (!changes.activeSession.oldValue) {
            // Session started
            // The popup might already call SESSION_START message, but this is a fallback
            // Actually, relying purely on the storage change is cleaner.
            // But we will handle both safely.
            updateBadge();
        }
    }
});

// ─── Session Handlers ─────────────────────────────────────────
async function handleSessionStart(payload, fullSessionPayload = null) {
    console.log('[Background] handleSessionStart called with:', JSON.stringify(payload));
    const { session_duration } = payload;
    
    await createOffscreenDocument();
    console.log('[Background] Offscreen document created and ready');

    chrome.storage.local.get([
        'activeSession', 'current_topic', 'study_reason',
        'current_mood', 'session_id', 'participant_code'
    ], (data) => {
        const broadcastPayload = fullSessionPayload || {
            activeSession: data.activeSession,
            current_topic: data.current_topic,
            study_reason: data.study_reason,
            current_mood: data.current_mood,
            session_id: data.session_id,
            participant_code: data.participant_code
        };

        console.log('[Background] Broadcasting to all tabs...');
        chrome.tabs.query({}, (allTabs) => {
            allTabs.forEach(tab => {
                if (tab.url &&
                    !tab.url.startsWith('chrome://') &&
                    !tab.url.startsWith('chrome-extension://')) {
                    chrome.tabs.sendMessage(tab.id, {
                        type: 'SESSION_START_DIRECT',
                        payload: broadcastPayload
                    }, () => {
                        if (chrome.runtime.lastError) {}
                    });
                    console.log('[Background] Sent to tab:', tab.id, tab.url);
                }
            });
        });
    });

    chrome.alarms.create('timerTick', { periodInMinutes: 1 / 60 });
    chrome.alarms.create('session_end', { delayInMinutes: session_duration });
    chrome.action.setBadgeBackgroundColor({ color: '#6c63ff' });
    if (chrome.action.setBadgeTextColor) {
        chrome.action.setBadgeTextColor({ color: '#ffffff' });
    }
    updateBadge();
}

async function handleSessionEnd() {
    console.log('[Background] handleSessionEnd called');
    chrome.alarms.clearAll();
    resetIcon();

    // Destroy offscreen document (stops camera stream automatically)
    try {
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        if (existingContexts.length > 0) {
            await chrome.offscreen.closeDocument();
            console.log('[Background] Offscreen document closed successfully');
        } else {
            console.log('[Background] No offscreen document to close');
        }
    } catch(e) {
        console.error('[Background] Error closing offscreen:', e);
    }

    // Broadcast session end to all content scripts
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
                chrome.tabs.sendMessage(tab.id, { type: 'SESSION_END_DIRECT' }).catch(() => {});
            }
        });
    });
}

// ─── Alarms ───────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'session_end') {
        // Fetch stats before clearing
        const stored = await chrome.storage.local.get([
            'activeSession', 'focus_score', 'distraction_count', 
            'max_level_reached', 'session_duration', 'current_topic', 
            'study_reason', 'blinkStats', 'interventions_sent',
            'experiment_day', 'condition'
        ]);

        const stats = {
            score: stored.focus_score ?? 100,
            distractions: stored.distraction_count ?? 0,
            maxLevel: stored.max_level_reached ?? 0,
            actualDuration: stored.session_duration ?? 25,
            blinkTotal: stored.blinkStats?.total ?? 0,
            blinkHighest: stored.blinkStats?.highest ?? 0,
            interventionsSent: stored.interventions_sent ?? 0,
            day: stored.experiment_day ?? 1,
            condition: stored.condition ?? 'A'
        };

        handleSessionEnd();

        // Set post-session state so popup knows where to resume
        await chrome.storage.local.remove('activeSession');
        await chrome.storage.local.set({
            session_active: false,
            postSessionStep: 'debrief',
            sessionStats: stats,
            current_topic: stored.current_topic,
            study_reason: stored.study_reason
        });

        // Automatically open the popup
        if (chrome.action.openPopup) {
            chrome.action.openPopup().catch(err => console.warn('[ADHD Monitor] openPopup failed:', err));
        }
    } else if (alarm.name === 'timerTick') {
        updateBadge();
    }
});

// ─── Badge Update Logic ───────────────────────────────────────
async function updateBadge() {
    try {
        const data = await chrome.storage.local.get('activeSession');
        const session = data.activeSession;

        // If session exists but marked as inactive, clear badge
        const sessionActiveCheck = await chrome.storage.local.get('session_active');

        if (!session || !session.startTime || !session.duration || sessionActiveCheck.session_active === false) {
            chrome.action.setBadgeText({ text: '' });
            return;
        }

        const now = Date.now();
        const remMs = Math.max(0, session.startTime + session.duration * 60000 - now);

        if (remMs <= 0) {
            handleSessionEnd();
            return;
        }

        // Calculate minutes and seconds
        const remSec = Math.floor(remMs / 1000);
        const minutes = Math.floor(remSec / 60);
        const seconds = remSec % 60;

        // Requirement: minutes > 0 ? "Xm" : "Xs"
        const text = minutes > 0 ? `${minutes}m` : `${seconds}s`;

        // Set badge
        chrome.action.setBadgeText({ text });
        chrome.action.setBadgeBackgroundColor({ color: '#6c63ff' });
        if (chrome.action.setBadgeTextColor) {
            chrome.action.setBadgeTextColor({ color: '#ffffff' });
        }

        // Also draw the purple progress ring icon
        drawProgressIcon(remMs, session.duration * 60000);

    } catch (err) {
        console.error('[ADHD Monitor] Badge update failed:', err);
    }
}

// ─── Canvas Icon Drawing ──────────────────────────────────────
function drawProgressIcon(remMs, totalMs) {
    const canvas = new OffscreenCanvas(128, 128);
    const ctx = canvas.getContext('2d');

    // Calculate progress (0.0 to 1.0)
    const progress = Math.max(0, Math.min(1, remMs / totalMs));
    const angle = progress * 2 * Math.PI;

    ctx.clearRect(0, 0, 128, 128);

    // Background circle (dark gray)
    ctx.beginPath();
    ctx.arc(64, 64, 54, 0, 2 * Math.PI);
    ctx.strokeStyle = '#1e1e2e';
    ctx.lineWidth = 12;
    ctx.stroke();

    // Progress arc (purple)
    // If progress is very small, we might want to ensure at least a dot, but standard Math.PI/2 is fine
    ctx.beginPath();
    ctx.arc(64, 64, 54, -Math.PI / 2, -Math.PI / 2 + angle);
    ctx.strokeStyle = '#6c63ff';
    ctx.lineWidth = 12;
    // Use round caps for a polished look
    ctx.lineCap = 'round';
    ctx.stroke();

    // Set the extension icon
    const imageData = ctx.getImageData(0, 0, 128, 128);
    chrome.action.setIcon({ imageData });
}

function resetIcon() {
    chrome.action.setBadgeText({ text: '' });
    // We don't have static icon files, so just draw a default "inactive" state
    const canvas = new OffscreenCanvas(128, 128);
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, 128, 128);
    ctx.beginPath();
    ctx.arc(64, 64, 54, 0, 2 * Math.PI);
    ctx.strokeStyle = '#6c63ff'; // Just a static purple circle outline when idle
    ctx.lineWidth = 12;
    ctx.stroke();

    const imageData = ctx.getImageData(0, 0, 128, 128);
    chrome.action.setIcon({ imageData });
}
