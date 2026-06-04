// core/config.js — Unified configuration interface
//
// Replaces localStorage-based config scattered across multiple modules.
// Inject a config loader at startup: initConfig(loaderFn) where loaderFn()
// returns a flat key-value object.

var _store = {};

export function initConfig(loader) {
    if (typeof loader === 'function') {
        _store = loader() || {};
    } else if (typeof loader === 'object') {
        _store = loader || {};
    }
}

export function get(key, defaultValue) {
    if (key in _store) return _store[key];
    return defaultValue !== undefined ? defaultValue : undefined;
}

export function set(key, val) {
    _store[key] = val;
}

export function getAll() {
    return _store;
}

// ─── Convenience accessors for common NE settings ───

export function getStmBatchSize() {
    return Number(get('stmBatch', 10));
}

// @deprecated — replaced by cursor engine
export function getStmWordsThreshold() {
    return Number(get('stmWordsThreshold', 500));
}

export function getStmMaxUnconsolidated() {
    return Number(get('stmMaxUnconsolidated', 20));
}

export function isMemoryEnabled() {
    return !!get('memoryEnabled', true);
}

export function isStateSchemaEnabled() {
    return !!get('enableStateSchema', false);
}

export function isRetrievalEnabled() {
    return !!get('retrievalEnabled', false);
}

export function isTelemetryEnabled() {
    return !!get('enableTelemetry', false);
}

export function getSecondaryAPIConfig() {
    return {
        url: get('secondary_api_url', ''),
        key: get('secondary_api_key', ''),
        model: get('secondary_api_model', '')
    };
}

// ─── Cursor engine configuration (v2) ───

export function getExtractionMode() {
    return get('extractionMode', 'agent');  // 'agent' | 'rp'
}

export function getInitialStmWindow() {
    return Number(get('initialStmWindow', 4));
}

export function getStmExpandStep() {
    return Number(get('stmExpandStep', 4));
}

export function getMaxStmWindow() {
    return Number(get('maxStmWindow', 20));
}

export function getInitialLtmWindow() {
    return Number(get('initialLtmWindow', 8));
}

export function getLtmExpandStep() {
    return Number(get('ltmExpandStep', 4));
}

export function getMaxLtmWindow() {
    return Number(get('maxLtmWindow', 30));
}

export function getStmMinBatchForCursor() {
    return Number(get('stmMinBatchForCursor', 3));
}

export function getLtmMinBatch() {
    return Number(get('ltmMinBatch', 15));
}

export function isCursorEngineEnabled() {
    return get('useCursorEngine', true);
}

export function getBm25SimilarityThreshold() {
    return Number(get('bm25SimilarityThreshold', 0.3));
}

export function getMaxPartialGenerations() {
    return Number(get('maxPartialGenerations', 3));
}
