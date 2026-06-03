// core/adapters/history/index.js — History reader registry + factory
//
// Allows platform-specific history readers to be registered by name.
// Users configure which reader to use via config.json:
//   { "history": { "reader": "trae-sqlite", "path": "..." } }
//
// Built-in readers are registered in their own files via import side-effects.

var _readers = {};

/**
 * Register a history reader factory.
 *
 * @param {string} name - Reader name (e.g. "trae-sqlite", "generic-json")
 * @param {Function} factory - (config) => { readHistory(chatId): Promise<Array> }
 */
export function registerReader(name, factory) {
    _readers[name] = factory;
}

/**
 * Create a history reader from config.
 *
 * @param {Object} config - { reader: string, path: string, ...readerSpecific }
 * @returns {Object|null} - { readHistory(chatId) } or null if no reader configured
 */
export function createReader(config) {
    if (!config || !config.reader) return null;
    var factory = _readers[config.reader];
    if (!factory) {
        console.error('[history] Unknown reader:', config.reader, '- available:', Object.keys(_readers).join(', '));
        return null;
    }
    return factory(config);
}

/**
 * Get list of registered reader names.
 */
export function listReaders() {
    return Object.keys(_readers);
}
