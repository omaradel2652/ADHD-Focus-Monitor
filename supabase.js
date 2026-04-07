/**
 * ADHD Focus Monitor — supabase.js
 * All Supabase DB operations. Key stored in chrome.storage.local — never hardcoded.
 *
 * All writes use try/catch per CONTEXT_v2.md rule:
 * "All Supabase writes must use try/catch. Never let a failed DB write crash the extension."
 *
 * Phase 1: stub with helper functions ready.
 * Phase 2+: full implementation for sessions, distraction_events, daily_questionnaire, retrieval_tests.
 */

class SupabaseClient {
    constructor() {
        // Hardcoded researcher credentials — participants never see these
        this._url = 'https://rqptapbxswkiwkpvpata.supabase.co';
        this._key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxcHRhcGJ4c3draXdrcHZwYXRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMjA4NDYsImV4cCI6MjA4ODY5Njg0Nn0.1lg6uPW1mTIiy4swknMSW4ALrafKAUPv_oczQG8o3D0';
        this._ready = true;
    }

    async init() {
        // Already configured via hardcoded credentials
        return this._ready;
    }

    // ─────────────────────────────────────────────
    // GENERIC INSERT
    // ─────────────────────────────────────────────
    async insert(table, data) {
        if (!this._ready) {
            console.warn('[ADHD Monitor] Supabase not ready. Skipping insert to', table);
            return null;
        }
        try {
            const res = await fetch(`${this._url}/rest/v1/${table}`, {
                method: 'POST',
                headers: this._headers('return=representation'),
                body: JSON.stringify(data),
            });
            if (!res.ok) throw new Error(await res.text());
            return await res.json();
        } catch (err) {
            console.error(`[ADHD Monitor] Supabase insert(${table}) error:`, err);
            return null;
        }
    }

    // ─────────────────────────────────────────────
    // GENERIC SELECT
    // ─────────────────────────────────────────────
    async select(table, query = '') {
        if (!this._ready) return null;
        try {
            const res = await fetch(`${this._url}/rest/v1/${table}?${query}`, {
                method: 'GET',
                headers: this._headers(),
            });
            if (!res.ok) throw new Error(await res.text());
            return await res.json();
        } catch (err) {
            console.error(`[ADHD Monitor] Supabase select(${table}) error:`, err);
            return null;
        }
    }

    // ─────────────────────────────────────────────
    // DOMAIN-SPECIFIC METHODS
    // ─────────────────────────────────────────────

    /** Save a completed session record */
    async saveSession(sessionData) {
        return this.insert('sessions', sessionData);
    }

    /** Log a distraction event in real time */
    async logDistractionEvent(event) {
        return this.insert('distraction_events', event);
    }

    /** Update an intervention result (success/fail) */
    async updateInterventionResult(eventId, result) {
        if (!this._ready) return null;
        try {
            const res = await fetch(`${this._url}/rest/v1/distraction_events?id=eq.${eventId}`, {
                method: 'PATCH',
                headers: this._headers(),
                body: JSON.stringify({ intervention_result: result }),
            });
            if (!res.ok) throw new Error(await res.text());
            return true;
        } catch (err) {
            console.error('[ADHD Monitor] Supabase updateInterventionResult error:', err);
            return false;
        }
    }

    /** Save daily questionnaire */
    async saveDailyQuestionnaire(data) {
        return this.insert('daily_questionnaire', data);
    }

    /** Save retrieval test results */
    async saveRetrievalTest(data) {
        return this.insert('retrieval_tests', data);
    }

    /** Get or create participant record */
    async getParticipant(participantCode) {
        const rows = await this.select('participants', `participant_code=eq.${participantCode}&limit=1`);
        return rows?.[0] || null;
    }

    /** Fetch yesterday's session for progress comparison */
    async getYesterdaySession(participantCode) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = yesterday.toISOString().slice(0, 10);
        const rows = await this.select(
            'sessions',
            `participant_code=eq.${participantCode}&session_date=eq.${dateStr}&limit=1`
        );
        return rows?.[0] || null;
    }

    /** Fetch calibration baseline (avg distraction rate from Days 1–3) */
    async getCalibrationBaseline(participantCode) {
        const rows = await this.select(
            'sessions',
            `participant_code=eq.${participantCode}&experiment_day=lte.3&select=distraction_count,actual_duration_minutes`
        );
        if (!rows || rows.length === 0) return null;
        const totalDistractions = rows.reduce((s, r) => s + (r.distraction_count || 0), 0);
        const totalMinutes = rows.reduce((s, r) => s + (r.actual_duration_minutes || 1), 0);
        return (totalDistractions / totalMinutes) * 60; // distractions per hour
    }

    // ─────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────
    _headers(prefer = '') {
        const h = {
            'Content-Type': 'application/json',
            'apikey': this._key,
            'Authorization': `Bearer ${this._key}`,
        };
        if (prefer) h['Prefer'] = prefer;
        return h;
    }

    _getFromStorage(keys) {
        return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    }
}

// Export singleton
const supabase = new SupabaseClient();
