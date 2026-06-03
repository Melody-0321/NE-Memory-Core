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
