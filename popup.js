/**
 * ADHD Focus Monitor — popup.js  (Phase 1 — fixed)
 * Fixes applied:
 *  1. Duration negotiation with editable input + confirm button
 *  2. Timer overlay sent to content.js via chrome.tabs.sendMessage
 *  3. All session state stored in chrome.storage.LOCAL (survives popup close)
 *  4. Popup restores state from storage on reopen
 */
console.log('[Popup] popup.js loaded successfully');

try {

// ─── CONSTANTS ───────────────────────────────────────────
const API_URL = 'https://api.cerebras.ai/v1/chat/completions';
const MODEL = 'llama3.1-8b';
const STEPS = ['topic', 'reason', 'mood', 'duration'];

// ─── 10-DAY PILOT CONDITION MAP ─────────────────────────
// Days 1-2: Calibration (condition A, interventions off)
// Days 3-8: Condition A (full active system)
// Days 9-10: Condition B (sham — 50% silent skip)
// Day >10: Study complete
function getConditionForDay(day) {
    if (day <= 2) return 'A';   // calibration
    if (day <= 8) return 'A';   // full
    if (day <= 10) return 'B';  // sham
    return 'COMPLETE';          // study over
}

function calcExperimentDay(startDateStr) {
    if (!startDateStr) return 1;
    const start = new Date(startDateStr + 'T00:00:00');
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.floor((now - start) / (1000 * 60 * 60 * 24)) + 1;
}

const SYSTEM_PROMPT = `You are a warm, friendly ADHD study coach having a natural conversation to set up a study session.
Your goal is to find out 4 things through natural conversation:
- What the user is studying
- Why it matters to them personally right now
- How they are feeling (energy level, stress, mood)
- Agree on a session duration based on their mood
If the user negotiates or asks for a different duration, you MUST agree to their requested time immediately, confirm the new duration, and end your message with EXACTLY the word 'READY_TO_START' to finish the setup.
Once you have all 4 pieces of info, end with something encouraging and say READY_TO_START
Max 2 sentences per message.`;

const SYSTEM_PROMPT_DEBRIEF = `You are a warm AI study coach wrapping up a session.
Have a natural conversation (max 6 exchanges total):
1. Start with ONE genuine observation using the actual numbers provided.
2. Ask how they feel about what they learned today.
3. Ask if they noticed any ADHD symptoms (restlessness, zoning out, racing thoughts).
4. End with one encouraging sentence about their next session.
Never use bullet points. Sound like a supportive friend.`;

// ─── STATE ───────────────────────────────────────────────
let state = {
    apiKey: '',
    pCode: 'P001',
    history: [],
    debriefHistory: [],
    debriefCount: 0,
    waiting: false,
    done: false,
    presessionComplete: false,
    postSessionStep: '', // 'debrief', 'retrieval', 'rating', 'summary'
    collected: { topic: '', reason: '', mood: '', duration: 25 },
    stats: { score: 100, distractions: 0, maxLevel: 0, actualDuration: 0 },
    ratings: { learn: 5, focus: 5 }
};

// ─── DOM ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
let screens = {};

// ─── BOOT ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[Popup] DOM loaded');
    const btnStartChk = document.getElementById('btn-start');
    console.log('[Popup] Start button found:', !!btnStartChk);

    screens = {
        setup: $('sc-setup'),
        chat: $('sc-chat'),
        active: $('sc-active'),
        debrief: $('sc-debrief'),
        rating: $('sc-rating'),
        summary: $('sc-final-summary'),
        complete: $('sc-complete')
    };

    bindEvents();

    // 0. Update experiment day and condition based on start date
    const dayData = await local(['experiment_start_date']);
    if (dayData.experiment_start_date) {
        const currentDay = calcExperimentDay(dayData.experiment_start_date);
        const currentCondition = getConditionForDay(currentDay);
        await chrome.storage.local.set({ experiment_day: currentDay, condition: currentCondition });

        // Study complete — block new sessions
        if (currentCondition === 'COMPLETE') {
            showScreen('complete');
            return;
        }
    }

    // 1. Check if session already active → restore active screen
    const stored = await local(['cerebras_api_key', 'participant_code', 'session_active',
        'session_start_time', 'session_duration', 'current_topic', 'focus_score', 'activeSession',
        'postSessionStep', 'debriefHistory', 'debriefCount', 'retrievalData', 'ratings', 'sessionStats',
        'supabase_url', 'supabase_anon_key']);

    if (stored.postSessionStep) {
        console.log('[Popup] Booting into postSessionStep:', stored.postSessionStep);
        state.apiKey = stored.cerebras_api_key || '';
        state.pCode = stored.participant_code || 'P001';
        state.debriefHistory = stored.debriefHistory || [];
        state.debriefCount = stored.debriefCount || 0;
        state.retrieval = stored.retrievalData || state.retrieval;
        state.ratings = stored.ratings || state.ratings;
        state.stats = stored.sessionStats || state.stats;
        state.collected.topic = stored.current_topic || '';
        state.postSessionStep = stored.postSessionStep;
        console.log('[Popup] Extracted state.stats:', state.stats);
        showScreen(state.postSessionStep);
        restorePostSessionUI();
        return;
    }

    if (stored.activeSession || stored.session_active) {
        state.apiKey = stored.cerebras_api_key || '';
        state.pCode = stored.participant_code || 'P001';
        showScreen('active');
        restoreActiveUI(stored);
        return;
    }

    // 2. Check for saved chat progress (popup was closed mid-chat)
    const chat = await local(['conversationHistory', 'presessionComplete', 'chat_collected']);
    if (stored.cerebras_api_key && chat.conversationHistory && chat.conversationHistory.length > 0) {
        state.apiKey = stored.cerebras_api_key;
        state.pCode = stored.participant_code || 'P001';
        state.history = chat.conversationHistory;
        state.collected = chat.chat_collected || state.collected;
        state.done = chat.presessionComplete || false;

        showScreen('chat');
        replayMessages();
        return;
    }

    // 3. Fresh start — need API key?
    if (stored.cerebras_api_key && stored.participant_code) {
        state.apiKey = stored.cerebras_api_key;
        state.pCode = stored.participant_code;
        showScreen('chat');
        await startChat();
    } else {
        showScreen('setup');
        if (stored.cerebras_api_key) $('inp-key').value = stored.cerebras_api_key;
        if (stored.participant_code) $('inp-code').value = stored.participant_code;
    }
});

// ─── EVENT BINDING ───────────────────────────────────────
function bindEvents() {
    // Setup
    const btnSave = $('btn-save');
    if (btnSave) btnSave.addEventListener('click', onSaveKey);

    const inpKey = $('inp-key');
    if (inpKey) inpKey.addEventListener('keydown', e => { if (e.key === 'Enter') onSaveKey(); });

    // Chat send
    const btnSend = $('btn-send');
    if (btnSend) btnSend.addEventListener('click', onSend);

    const chatInput = $('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
        });
        chatInput.addEventListener('input', autoResize);
    }

    // Start session
    const btnStart = $('btn-start');
    if (btnStart) btnStart.addEventListener('click', onStart);

    // End session
    const btnEnd = $('btn-end');
    if (btnEnd) btnEnd.addEventListener('click', onEnd);

    // Post-session Debrief
    const btnSendDebrief = $('btn-send-debrief');
    if (btnSendDebrief) btnSendDebrief.addEventListener('click', onSendDebrief);
    const debriefInput = $('debrief-input');
    if (debriefInput) {
        debriefInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSendDebrief(); }
        });
    }
    const btnEndDebrief = $('btn-end-debrief');
    if (btnEndDebrief) btnEndDebrief.addEventListener('click', initSelfRating);

    // Rating Sliders
    const rateLearn = $('rate-learn');
    if (rateLearn) rateLearn.addEventListener('input', () => { $('val-learn').textContent = rateLearn.value; });
    const rateFocus = $('rate-focus');
    if (rateFocus) rateFocus.addEventListener('input', () => { $('val-focus').textContent = rateFocus.value; });

    const btnSubmitRating = $('btn-submit-rating');
    if (btnSubmitRating) btnSubmitRating.addEventListener('click', onFinishPostSession);

    const btnRestart = $('btn-restart');
    if (btnRestart) btnRestart.addEventListener('click', onRestartSession);
}

// ─── SETUP SCREEN ────────────────────────────────────────
async function onSaveKey() {
    const key = $('inp-key').value.trim();
    const code = $('inp-code').value.trim();

    if (!key) { toast('Please enter your Cerebras API key.'); return; }
    if (!code) { toast('Please enter your participant code.'); return; }

    $('btn-save').textContent = 'Saving…';
    $('btn-save').disabled = true;

    try {
        const today = new Date().toISOString().slice(0, 10);
        await chrome.storage.local.set({ 
            cerebras_api_key: key, 
            participant_code: code,
            experiment_start_date: today,
            experiment_day: 1,
            condition: getConditionForDay(1)
        });
        state.apiKey = key;
        state.pCode = code;
        showScreen('chat');
        await startChat();
    } catch (e) {
        toast('Error saving: ' + e.message);
        $('btn-save').textContent = 'Save & Continue →';
        $('btn-save').disabled = false;
    }
}

// ─── CHAT FLOW ────────────────────────────────────────────
async function startChat() {
    state.history = [];
    state.done = false;
    state.collected = { topic: '', reason: '', mood: '', duration: 25 };

    // UI update
    $('prog-label').textContent = 'Setting up your session...';
    $('prog-fill').style.width = '10%';
    await saveChatState();

    const typingId = addTyping();
    const opening = await ai([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Start the conversation warmly.' },
    ]);
    removeTyping(typingId);

    if (opening) {
        addMsg('ai', opening);
        state.history.push({ role: 'assistant', content: opening });
        await saveChatState();
    }
}

async function onSend() {
    if (state.waiting) return;
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.style.height = 'auto';
    setSend(true);

    try {
        addMsg('usr', text);
        state.history.push({ role: 'user', content: text });
        await saveChatState();

        const typingId = addTyping();
        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...state.history
        ];

        const resp = await ai(messages);
        removeTyping(typingId);

        if (resp) {
            const isReady = resp.includes('READY_TO_START');
            const clean = resp.replace('READY_TO_START', '').trim();

            addMsg('ai', clean);
            state.history.push({ role: 'assistant', content: resp });

            if (isReady) {
                await extractSessionData();
            }
            await saveChatState();
        }
    } catch (e) {
        console.error('[ADHD Monitor] onSend error:', e);
        toast('Failed to send message.');
    } finally {
        setSend(false);
        if (input) input.focus();
    }
}

async function extractSessionData(retry = false) {
    $('prog-label').textContent = 'Finalizing details...';
    $('prog-fill').style.width = '90%';

    const convoText = state.history.map(m => `${m.role}: ${m.content}`).join('\n');
    const extractionPrompt = `Based on this conversation, extract these 4 values.
Return ONLY valid JSON, nothing else, no markdown:
{
  "topic": "what the user is studying",
  "reason": "why it matters to them", 
  "mood": "how they described their feeling",
  "duration": 25
}

IMPORTANT: For 'duration', extract the FINAL agreed-upon time strictly in MINUTES. If the conversation mentions '1 hour', you MUST output 60. If it says '1.5 hours', output 90. ALWAYS convert hours to minutes mathematically before outputting. Only output the final integer in minutes.

Conversation:
${convoText}`;

    try {
        const rawJson = await ai([{ role: 'user', content: extractionPrompt }]);
        console.log('[ADHD Monitor] Raw Extraction Response:', rawJson);

        // Basic cleanup in case AI includes markdown blocks
        const cleanJson = rawJson.replace(/```json|```/g, '').trim();
        const extracted = JSON.parse(cleanJson);

        // Store in storage (using local as per previous persistence fixes)
        await chrome.storage.local.set({
            current_topic: extracted.topic,
            study_reason: extracted.reason,
            current_mood: extracted.mood,
            session_duration: extracted.duration
        });

        state.collected = {
            topic: extracted.topic,
            reason: extracted.reason,
            mood: extracted.mood,
            duration: extracted.duration
        };

        setupDone();
    } catch (e) {
        console.error('[ADHD Monitor] Extraction failed:', e);
        if (!retry) {
            console.log('[ADHD Monitor] Retrying extraction...');
            await extractSessionData(true);
        } else {
            toast('Failed to finalize details. Please try again.');
            // Allow retry by not setting state.done
        }
    }
}

// ─── SETUP COMPLETE ──────────────────────────────────────
function setupDone() {
    state.done = true;
    $('prog-label').textContent = 'Ready to start!';
    $('prog-fill').style.width = '100%';

    renderSummary();
    $('start-cta').classList.add('show');

    const msgs = $('chat-msgs');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;

    saveChatState();
}

function renderSummary() {
    $('summary-grid').innerHTML = `
    <div class="sg-item"><label>📖 Topic</label><span title="${esc(state.collected.topic)}">${esc(trunc(state.collected.topic, 26))}</span></div>
    <div class="sg-item"><label>⏱ Duration</label><span><input type="number" id="edit-duration" value="${state.collected.duration}" min="1" max="120" style="width:50px;background:var(--card);color:var(--text);border:1px solid var(--border-lit);border-radius:6px;padding:2px 6px;text-align:center;font-size:14px;font-weight:700;"> min</span></div>
    <div class="sg-item"><label>💡 Why</label><span title="${esc(state.collected.reason)}">${esc(trunc(state.collected.reason, 26))}</span></div>
    <div class="sg-item"><label>🌡 Mood</label><span>${esc(trunc(state.collected.mood, 26))}</span></div>
  `;
}

// ─── START SESSION ────────────────────────────────────────
async function onStart() {
    console.log('[Popup] START clicked, saving session...');

    // Read the (possibly user-edited) duration from the input field
    const editDur = $('edit-duration');
    if (editDur) {
        const manualDuration = parseInt(editDur.value) || state.collected.duration;
        state.collected.duration = manualDuration;
        await chrome.storage.local.set({ session_duration: manualDuration });
    }

    console.log('[Popup] Current state.collected:', JSON.stringify(state.collected));
    
    $('btn-start').textContent = 'Starting…';
    $('btn-start').disabled = true;

    try {
        // Phase 2 Fix: Check for camera permission first
        const data = await chrome.storage.local.get('cameraGranted');
        if (!data.cameraGranted) {
            // Save pending session state so background can resume after permission
            await chrome.storage.local.set({
                pendingSession: {
                    topic: state.collected.topic,
                    reason: state.collected.reason,
                    mood: state.collected.mood,
                    duration: state.collected.duration
                }
            });
            // Open the dedicated permission page
            chrome.tabs.create({ url: chrome.runtime.getURL('camera-permission.html') });
            window.close(); // Popup must close
            return;
        }

        // Recalculate experiment day & condition right before starting
        const dayInfo = await local(['experiment_start_date']);
        const experimentDay = calcExperimentDay(dayInfo.experiment_start_date);
        const sessionCondition = getConditionForDay(experimentDay);

        if (sessionCondition === 'COMPLETE') {
            showScreen('complete');
            return;
        }

        await chrome.storage.local.set({ experiment_day: experimentDay, condition: sessionCondition });

        const now = Date.now();
        const sessionPayload = {
            session_active: true,
            session_start_time: now,
            current_topic: state.collected.topic,
            study_reason: state.collected.reason,
            current_mood: state.collected.mood,
            session_duration: state.collected.duration,
            focus_score: 100,
            distraction_count: 0,
            ai_interventions_sent: 0,
            mechanical_interventions_sent: 0,
            ai_refocus_success_count: 0,
            ai_refocus_fail_count: 0,
            max_level_reached: 0,
            running_summary: '',
            session_id: uuid(),
            participant_code: state.pCode,
            chat_done: true,
            experiment_day: experimentDay,
            condition: sessionCondition,
        };

        // Fix 3: store ALL state in local so it persists after popup closes
        await chrome.storage.local.set(sessionPayload);

        // Tell background to set alarms and start monitoring
        chrome.runtime.sendMessage({
            type: 'SESSION_START', 
            payload: {
                session_duration: state.collected.duration,
                current_topic: state.collected.topic,
                study_reason: state.collected.reason,
                current_mood: state.collected.mood,
            },
            sessionPayload: sessionPayload
        });

        // Trigger content.js across all tabs
        await chrome.storage.local.set({
            activeSession: {
                startTime: now,
                duration: Number(state.collected.duration),
                score: 100,
                topic: state.collected.topic,
                reason: state.collected.reason
            }
        });

        // Verification log
        chrome.storage.local.get('activeSession', (d) => {
            console.log('[Popup] Verified saved:', d.activeSession);
        });

        showScreen('active');
        $('active-sub').textContent = `Studying: ${state.collected.topic}`;
        startPopupTimer(state.collected.duration, now);

    } catch (e) {
        toast('Failed to start: ' + e.message);
        $('btn-start').textContent = '▶  START SESSION';
        $('btn-start').disabled = false;
    }
}

// ─── ACTIVE SCREEN ────────────────────────────────────────
function restoreActiveUI(stored) {
    $('hdr-dot').classList.add('on');
    $('active-sub').textContent = `Studying: ${stored.current_topic || '…'}`;
    $('live-score').textContent = stored.focus_score ?? 100;
    startPopupTimer(stored.session_duration || 25, stored.session_start_time || Date.now());
}

function startPopupTimer(durMin, startTime) {
    const endTime = startTime + durMin * 60000;
    const el = $('live-timer');
    $('hdr-dot').classList.add('on');

    const tick = async () => {
        const rem = Math.max(0, endTime - Date.now());
        const m = Math.floor(rem / 60000);
        const s = Math.floor((rem % 60000) / 1000);
        if (el) el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

        // Sync score from storage
        try {
            const d = await local(['focus_score']);
            const scoreEl = $('live-score');
            if (scoreEl && d.focus_score !== undefined) scoreEl.textContent = d.focus_score;
        } catch (_) { }

        if (rem > 0) {
            setTimeout(tick, 1000);
        } else {
            initPostSessionFlow();
        }
    };
    tick();
}

async function onEnd() {
    if (!confirm('End session now?')) return;
    await chrome.storage.local.set({ session_active: false, presessionComplete: false });
    await chrome.storage.local.remove(['activeSession', 'conversationHistory', 'postSessionStep', 'debriefHistory', 'debriefCount', 'retrievalData', 'ratings', 'sessionStats']);
    chrome.runtime.sendMessage({ type: 'SESSION_END', payload: {} });

    window.close();
}

// ─── CHAT RESTORE (popup reopened mid-chat) ──────────────
function replayMessages() {
    const label = $('prog-label');
    const fill = $('prog-fill');
    if (label) label.textContent = state.done ? 'Ready to start!' : 'Setting up your session...';
    if (fill) fill.style.width = state.done ? '100%' : '50%';

    // Re-render all historical messages
    state.history.forEach(m => {
        if (m.role === 'assistant') addMsg('ai', m.content, false);
        if (m.role === 'user') addMsg('usr', m.content, false);
    });
    // Show appropriate UI based on current step
    if (state.done) {
        renderSummary();
        $('start-cta').classList.add('show');
    }
    setTimeout(() => { const c = $('chat-msgs'); c.scrollTop = c.scrollHeight; }, 50);
}

// ─── POST-SESSION FLOW ────────────────────────────────────
async function initPostSessionFlow() {
    state.postSessionStep = 'debrief';
    await chrome.storage.local.set({ session_active: false, postSessionStep: 'debrief' });

    // Fetch stats
    const stored = await local(['focus_score', 'distraction_count', 'max_level_reached', 'session_duration', 'current_topic', 'study_reason']);
    state.stats = {
        score: stored.focus_score ?? 100,
        distractions: stored.distraction_count ?? 0,
        maxLevel: stored.max_level_reached ?? 0,
        actualDuration: stored.session_duration ?? 25
    };
    state.collected.topic = stored.current_topic || '';
    state.collected.reason = stored.study_reason || '';

    showScreen('debrief');
    await startDebriefChat();
}

async function startDebriefChat() {
    try {
        console.log('[Popup] startDebriefChat called! Emptying debrief history...');
        state.debriefHistory = [];
        state.debriefCount = 0;
        await savePostSessionState();

        const dynamicSystemPrompt = `You are a focus coach wrapping up a session.
Session data: Topic: ${state.collected.topic}, Duration: ${state.stats.actualDuration}min, Focus: ${state.stats.score}/100, Distractions: ${state.stats.distractions}, Max level: ${state.stats.maxLevel}.
Keep your response to exactly ONE or TWO short sentences. Do not ask open-ended questions that require long answers. Acknowledge their effort using the actual numbers and say something encouraging.`;

        console.log('[Popup] Injecting typing indicator...');
        const typingId = addTypingTo('debrief-msgs');
        
        console.log('[Popup] Fetching initial AI debrief response...');
        const opening = await ai([
            { role: 'system', content: dynamicSystemPrompt },
            { role: 'user', content: `Please begin the debrief based on the session data.` },
        ]);
        
        console.log('[Popup] Received AI response:', opening);
        removeTypingFrom('debrief-msgs', typingId);

        if (opening) {
            addMsgTo('debrief-msgs', 'ai', opening);
            state.debriefHistory.push({ role: 'assistant', content: opening });
            await savePostSessionState();
        } else {
            console.warn('[Popup] AI returned null for opening debrief!');
        }
    } catch (e) {
        console.error('[Popup] Crash in startDebriefChat:', e);
    }
}

async function onSendDebrief() {
    if (state.waiting || state.debriefCount >= 2) return;
    const input = $('debrief-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.style.height = 'auto';
    state.waiting = true;

    try {
        addMsgTo('debrief-msgs', 'usr', text);
        state.debriefHistory.push({ role: 'user', content: text });
        state.debriefCount++;
        await savePostSessionState();

        const dynamicSystemPrompt = `You are a focus coach wrapping up a session.
Session data: Topic: ${state.collected.topic}, Duration: ${state.stats.actualDuration}min, Focus: ${state.stats.score}/100, Distractions: ${state.stats.distractions}, Max level: ${state.stats.maxLevel}.
Keep your response to exactly ONE or TWO short sentences. Do not ask open-ended questions. Acknowledge their effort and say goodbye.`;

        const typingId = addTypingTo('debrief-msgs');
        const messages = [
            { role: 'system', content: dynamicSystemPrompt },
            ...state.debriefHistory
        ];
        const resp = await ai(messages);
        removeTypingFrom('debrief-msgs', typingId);

        if (resp) {
            addMsgTo('debrief-msgs', 'ai', resp);
            state.debriefHistory.push({ role: 'assistant', content: resp });
            await savePostSessionState();

            if (state.debriefCount >= 2) {
                // Auto-transition directly to self-rating (no retrieval test)
                setTimeout(() => initSelfRating(), 3000);
            }
        }
    } catch (e) {
        console.error('[ADHD Monitor] onSendDebrief error:', e);
        toast('Failed to send message.');
    } finally {
        state.waiting = false;
        if (input) input.focus();
    }
}

async function savePostSessionState() {
    try {
        await chrome.storage.local.set({
            postSessionStep: state.postSessionStep,
            debriefHistory: state.debriefHistory,
            debriefCount: state.debriefCount,
            ratings: state.ratings,
            sessionStats: state.stats
        });
    } catch (_) { }
}

function restorePostSessionUI() {
    console.log('[Popup] restorePostSessionUI - Current Step:', state.postSessionStep);
    if (state.postSessionStep === 'debrief') {
        const historyLen = state.debriefHistory ? state.debriefHistory.length : 0;
        console.log('[Popup] Debrief history length:', historyLen);
        if (historyLen === 0) {
            console.log('[Popup] Triggering startDebriefChat from empty history...');
            startDebriefChat();
        } else {
            console.log('[Popup] Restoring existing debrief chat history...');
            state.debriefHistory.forEach(m => addMsgTo('debrief-msgs', m.role === 'assistant' ? 'ai' : 'usr', m.content, false));
            refreshDebriefUI();
        }
    }
}

function refreshDebriefUI() {
    const stepEl = $('debrief-step');
    if (stepEl) stepEl.textContent = `${state.debriefCount}/6`;
    const msgs = $('debrief-msgs');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

// ─── UTILITIES (Extended) ──────────────────────────────────
function addMsgTo(targetId, role, text, animate = true) {
    const c = $(targetId);
    if (!c) return;
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    if (role === 'ai') div.innerHTML = `<div class="av">🧠</div><div class="bubble">${esc(text)}</div>`;
    else div.innerHTML = `<div class="bubble">${esc(text)}</div>`;

    if (animate) {
        div.style.opacity = '0';
        div.style.transform = 'translateY(6px)';
        div.style.transition = 'opacity .25s ease, transform .25s ease';
        c.appendChild(div);
        requestAnimationFrame(() => { div.style.opacity = '1'; div.style.transform = 'translateY(0)'; });
    } else {
        c.appendChild(div);
    }
    c.scrollTop = c.scrollHeight;
}

function addTypingTo(targetId) {
    const id = 'ty-' + Date.now();
    const c = $(targetId);
    if (!c) return id;
    const el = document.createElement('div');
    el.id = id; el.className = 'msg ai';
    el.innerHTML = `<div class="av">🧠</div><div class="bubble typing"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
    c.appendChild(el); c.scrollTop = c.scrollHeight;
    return id;
}

function removeTypingFrom(targetId, id) { document.getElementById(id)?.remove(); }

// ─── AI CALL ─────────────────────────────────────────────
async function ai(messages) {
    state.waiting = true;
    try {
        const r = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.apiKey}`,
            },
            body: JSON.stringify({ model: MODEL, messages, max_tokens: 180, temperature: 0.7 }),
        });
        if (!r.ok) {
            const err = await r.text();
            throw new Error(`${r.status}: ${err}`);
        }
        const d = await r.json();
        return d.choices?.[0]?.message?.content?.trim() || '';
    } catch (e) {
        console.error('[ADHD Monitor] AI error:', e);
        toast('AI error: ' + e.message);
        return null;
    } finally {
        state.waiting = false;
    }
}


// ─── STEP 3: SELF RATING ─────────────────────────────────
function initSelfRating() {
    state.postSessionStep = 'rating';
    showScreen('rating');
    savePostSessionState();
}

async function onFinishPostSession() {
    const learn = parseInt($('rate-learn').value);
    const focus = parseInt($('rate-focus').value);
    state.ratings = { learn, focus };

    state.postSessionStep = 'summary';
    showScreen('summary');
    await savePostSessionState();

    const stored = await local(['experiment_day', 'condition']);
    state.stats.day = stored.experiment_day || 1;
    state.stats.condition = stored.condition || 'A';

    await finalizeSession();
}

// ─── STEP 4: SAVE & SUMMARY ──────────────────────────────
async function finalizeSession() {
    const resScore = $('res-score');
    const resDist = $('res-dist');
    const resRet = $('res-retrieval');
    const resDur = $('res-dur');
    const vsYesterday = $('res-vs-yesterday');
    const aiMsg = $('res-ai-msg');

    if (resScore) resScore.textContent = state.stats.score;
    if (resDist) resDist.textContent = state.stats.distractions;
    if (resDur) resDur.textContent = state.stats.actualDuration;

    // 1. Save to Supabase
    try {
        const sessionData = {
            participant_code: state.pCode,
            session_date: new Date().toISOString().slice(0, 10),
            experiment_day: state.stats.day || 1,
            condition: state.stats.condition || 'A',
            current_topic: state.collected.topic,
            study_reason: state.collected.reason,
            current_mood: state.collected.mood,
            planned_duration_minutes: state.stats.actualDuration, // Assuming planned == duration set
            actual_duration_minutes: state.stats.actualDuration,
            focus_score_final: state.stats.score,
            distraction_count: state.stats.distractions,
            blink_count_total: state.stats.blinkTotal || 0,
            avg_blink_rate: (state.stats.blinkTotal || 0) / (state.stats.actualDuration || 1),
            max_blink_rate: state.stats.blinkHighest || 0,
            interventions_sent: state.stats.interventionsSent || 0,
            max_level_reached: state.stats.maxLevel,
            self_rated_learning: state.ratings.learn,
            self_rated_focus: state.ratings.focus,
            retrieval_score: 0,
            ai_debrief_summary: state.debriefHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
        };

        const ok = await supabase.init();
        if (ok) {
            await supabase.saveSession(sessionData);
            
            // Also save specifically to daily_questionnaire for redundancy/clarity if needed
            await supabase.saveDailyQuestionnaire({
                participant_code: state.pCode,
                learn_rating: state.ratings.learn,
                focus_rating: state.ratings.focus,
                retrieval_score: state.retrieval.score
            });

            if (state.retrieval.questions.length > 0) {
                await supabase.saveRetrievalTest({
                    participant_code: state.pCode,
                    questions: state.retrieval.questions,
                    answers: state.retrieval.answers,
                    total_score: state.retrieval.score
                });
            }
        }
    } catch (e) { console.error('[ADHD Monitor] Supabase save failed:', e); }

    // 2. Fetch Comparison
    let yesterdayStats = null;
    try {
        yesterdayStats = await supabase.getYesterdaySession(state.pCode);
        if (yesterdayStats && vsYesterday) {
            const diff = state.stats.score - yesterdayStats.focus_score;
            const sign = diff >= 0 ? '+' : '';
            vsYesterday.innerHTML = `<strong>Yesterday:</strong> ${yesterdayStats.focus_score} (${sign}${diff})`;
        } else if (vsYesterday) {
            vsYesterday.textContent = "No data from yesterday to compare.";
        }
    } catch (_) { if (vsYesterday) vsYesterday.textContent = "Couldn't fetch yesterday's data."; }

    // 3. AI Comparison Sentence
    const compPrompt = `Today's Focus: ${state.stats.score}, Distractions: ${state.stats.distractions}, Knowledge Score: ${state.retrieval.score}/3.
Yesterday's Focus: ${yesterdayStats ? yesterdayStats.focus_score : 'Unknown'}.
Generate a ONE-SENTENCE encouraging performance comparison.`;

    const msg = await ai([{ role: 'user', content: compPrompt }]);
    if (aiMsg && msg) aiMsg.textContent = msg;
}

async function onRestartSession() {
    await chrome.storage.local.remove(['activeSession', 'conversationHistory', 'postSessionStep', 'debriefHistory', 'debriefCount', 'retrievalData', 'ratings', 'sessionStats', 'presessionComplete', 'chat_collected']);
    await chrome.storage.local.set({ session_active: false });
    window.location.reload();
}

function restorePostSessionUI() {
    if (state.postSessionStep === 'debrief') {
        if (state.debriefHistory.length === 0) {
            startDebriefChat();
        } else {
            state.debriefHistory.forEach(m => addMsgTo('debrief-msgs', m.role === 'assistant' ? 'ai' : 'usr', m.content, false));
            refreshDebriefUI();
        }
    } else if (state.postSessionStep === 'retrieval') {
        showNextRetrievalQ();
    } else if (state.postSessionStep === 'rating') {
        // Sliders already have defaults or could be restored if needed
    } else if (state.postSessionStep === 'summary') {
        finalizeSession();
    }
}

// ─── UI HELPERS ──────────────────────────────────────────
function showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => {
        if (el) el.classList.toggle('active', k === name);
    });
}

function addMsg(role, text, animate = true) {
    const c = $('chat-msgs');
    if (!c) return;
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    if (role === 'ai') {
        div.innerHTML = `<div class="av">🧠</div><div class="bubble">${esc(text)}</div>`;
    } else {
        div.innerHTML = `<div class="bubble">${esc(text)}</div>`;
    }
    if (animate) {
        div.style.opacity = '0'; div.style.transform = 'translateY(6px)';
        div.style.transition = 'opacity .25s ease, transform .25s ease';
        c.appendChild(div);
        requestAnimationFrame(() => { div.style.opacity = '1'; div.style.transform = 'translateY(0)'; });
    } else {
        c.appendChild(div);
    }
    c.scrollTop = c.scrollHeight;
}

function addTyping() {
    const id = 'ty-' + Date.now();
    const c = $('chat-msgs');
    if (!c) return id;
    const el = document.createElement('div');
    el.id = id; el.className = 'msg ai';
    el.innerHTML = `<div class="av">🧠</div><div class="bubble typing"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
    c.appendChild(el); c.scrollTop = c.scrollHeight;
    return id;
}
function removeTyping(id) { document.getElementById(id)?.remove(); }

function setSend(disabled) {
    const btn = $('btn-send');
    const inp = $('chat-input');
    if (btn) btn.disabled = disabled;
    if (inp) inp.disabled = disabled;
}

const PROG = {
    topic: { label: 'Setting up...', pct: '25%' },
    reason: { label: 'Understanding goals...', pct: '50%' },
    mood: { label: 'Adjusting to you...', pct: '75%' },
    done: { label: 'Ready to start!', pct: '100%' }
};

function setProgress(step) {
    const p = PROG[step] || PROG.done;
    const label = $('prog-label');
    const fill = $('prog-fill');
    if (label) label.textContent = p.label;
    if (fill) fill.style.width = p.pct;
}

function autoResize() {
    const t = $('chat-input');
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 80) + 'px';
}

function local(keys) {
    return new Promise(r => chrome.storage.local.get(keys, r));
}

async function saveChatState() {
    try {
        await chrome.storage.local.set({
            conversationHistory: state.history,
            presessionComplete: state.done,
            chat_collected: state.collected
        });
    } catch (_) { }
}

// ─── UTILITIES ───────────────────────────────────────────
function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3500);
}

function showScreen(id) {
    Object.values(screens).forEach(s => {
        if (s) s.classList.remove('active');
    });
    const target = id === 'debrief' ? 'debrief' : 
                   id === 'retrieval' ? 'retrieval' : 
                   id === 'rating' ? 'rating' : 
                   id === 'summary' ? 'summary' : id;
    const s = screens[target];
    if (s) s.classList.add('active');
}

function esc(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function trunc(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : (s || ''); }

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

} catch(err) {
    console.error('[Popup] Fatal error:', err);
}
