// core/adapters/llm-callback.js — Host-injected LLM adapter
//
// Use when the host (e.g., Trae AI, a browser extension, or another
// AI agent) provides its own LLM capabilities.
//
// callLLM(messages) → returns Promise<string>
// The host function handles the actual LLM call however it wants.

export function createCallbackLLM(llmFn) {
    if (typeof llmFn !== 'function') {
        throw new Error('createCallbackLLM requires a function: (messages: array) => Promise<string>');
    }

    return async function callLLM(messages, options) {
        return llmFn(messages, options);
    };
}
