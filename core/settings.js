// core/settings.js — Runtime flags (portable, no localStorage)
//
// Moved from src/index.js + src/settings.js.
// Now uses core/config.js instead of localStorage.

import { get, set } from './config.js';

export function isRetrievalEnabled() {
    return get('retrievalEnabled', false);
}

export function setRetrievalEnabled(val) {
    if (val) {
        if (!get('memoryEnabled', true)) {
            console.warn('[core] Cannot enable Smart Retrieval: Memory System is not enabled');
            return;
        }
    }
    set('retrievalEnabled', !!val);
}
