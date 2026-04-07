/**
 * ADHD Focus Monitor — camera-permission.js
 * Handles camera access requests from the dedicated permission tab.
 */

document.getElementById('btn-allow').onclick = async () => {
    const errorEl = document.getElementById('error-msg');
    errorEl.style.display = 'none';

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        
        // Don't stop the stream - just save the permission flag
        await chrome.storage.local.set({ cameraGranted: true });
        
        // Tell background.js to resume/start the session
        chrome.runtime.sendMessage({ type: 'PERMISSION_GRANTED' });
        
        // Close this permission tab
        window.close();
    } catch (err) {
        console.error('[ADHD Monitor] Camera Access Error:', err);
        errorEl.textContent = 'Camera access was denied. Please enable it in your browser settings to use the focus monitor.';
        errorEl.style.display = 'block';
    }
};
