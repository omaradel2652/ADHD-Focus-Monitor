# ADHD Focus Monitor: Passive Context-Aware Interventions for Cognitive Support

**Prepared for submission to ASSETS 2026 & MIT Media Lab Research Portfolio**

## Abstract

The **ADHD Focus Monitor** is a research-grade Chrome Extension designed to provide non-pharmacological, context-aware cognitive support for individuals with Attention-Deficit/Hyperactivity Disorder (ADHD). This tool leverages passive, entirely local AI eye-tracking combined with instantaneous Large Language Model (LLM) interventions to detect mind-wandering in real-time and gently scaffold users back to their intended tasks. By combining a zero-trust privacy architecture with high-frequency behavioral monitoring, this extension serves as a novel medium for evaluating continuous partial attention and digital therapeutic efficacy in authentic desktop environments.

---

## Core Innovations

1. **Escalating 5-Level Intervention Ladder**  
   Rather than relying on static, easily habituated digital timers, the system analyzes the duration of off-screen distraction and escalates interventions dynamically:
   - *Level 1-2:* Silent logging and subtle UI cues.
   - *Level 3-4:* Mechanical page disruptions (auto-scrolling away from distracting feeds, brief visual border flashes).
   - *Level 5:* Empathic, context-aware AI conversational overlay designed to negotiate refocusing without inducing cognitive overload.

2. **MV3-Compliant Local Computer Vision**  
   To bypass deep Chrome Manifest V3 (MV3) Content Security Policy (CSP) constraints regarding remote code execution, the extension utilizes a dedicated Chrome Offscreen Document. This isolates the high-performance execution of the **MediaPipe FaceLandmarker API**, allowing for continuous, 30fps pupil-tracking and blink-rate calculation without impacting the main thread performance of the user's active tabs.

3. **Sub-Second LLM Conversational Coaching**  
   Traditional LLMs introduce crippling latency that breaks the "flow" of intervention. This architecture integrates the **Cerebras LLaMA-3.1 API**, leveraging wafer-scale inference to generate empathetic, contextually relevant debriefs and interventions in sub-second intervals.

---

## Research Methodology

This software was engineered explicitly for a structured **10-Day Pilot Study** evaluating digital intervention efficacy:

- **Screening:** Participants are screened for baseline symptomatology using the validated Adult ADHD Self-Report Scale (ASRS-v1.1).
- **Study Design (10-Day Progression):**
  - **Days 1–2 (Calibration):** The system operates silently, reading eye-gaze and tracking attention to establish an un-intervened clinical baseline.
  - **Days 3–8 (Active Condition A):** The full suite of escalating interventions and LLM coaching is active.
  - **Days 9–10 (Sham Condition B):** To control for the Hawthorne effect, the UI remains visibly active, but 50% of triggered interventions are silently dropped by the system’s logic. This evaluates whether the *presence* of the tool (rather than its active interruptions) is responsible for behavior change.

---

## Privacy & Ethics

**Zero-Trust Data Architecture**

Ethics and privacy are paramount when designing assistive technology for neurodivergent populations. The ADHD Focus Monitor operates under a strict, privacy-by-design paradigm:
- **Local-Only Processing:** All webcam inputs, facial landmark inference, and eye-tracking computations occur strictly on-device within the isolated Chrome sandbox.
- **No Video Recording:** The system **never** records, saves, captures, or transmits any audio or video data. 
- **Data Minimization:** Only anonymized, aggregated numerical statistics (e.g., calculated focus score, timestamped distraction counts, and session durations) are synchronized over an encrypted channel to the secure Supabase research database. 

---

## Technical Architecture

The extension is built to be lightweight, modern, and highly modular:
- **Environment:** Chrome Manifest V3 (Service Workers, Offscreen Documents, Storage API)
- **Computer Vision:** Google MediaPipe FaceLandmarker (WASM)
- **Inference / AI Logic:** Cerebras API (LLaMA-3.1-8b)
- **Data Persistence:** Supabase (PostgreSQL via REST API)
- **UI/UX:** Vanilla HTML/CSS/JS (Zero dependency framework to ensure maximum execution speed and minimum memory footprint)

---

## Installation (Developer Mode)

For peer reviewers, researchers, and early participants, the extension must be side-loaded locally.

1. Clone or download this repository to your local machine.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. In the top right corner, toggle **"Developer mode"** to ON.
4. Click the **"Load unpacked"** button in the top left.
5. Select the root directory of this project (`adhd-monitor`).
6. Pin the extension to your Chrome toolbar.
7. Click the extension icon (🧠) to launch the setup flow, enter your designated Participant Code and Cerebras Developer Key, and begin the calibration phase.
