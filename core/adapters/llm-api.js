// core/adapters/llm-api.js — OpenAI-compatible API LLM adapter
//
// Direct fetch to any OpenAI-compatible endpoint.
// No TavernHelper or SillyTavern dependencies.

export function createAPILLM(config) {
    var url = config.url || '';
    var key = config.key || '';
    var model = config.model || 'gpt-4o-mini';

    return async function callLLM(messages, options) {
        options = options || {};
        var timeout = options.timeout || 120;

        var controller = new AbortController();
        var timer = setTimeout(function() { controller.abort(); }, timeout * 1000);

        try {
            var response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + key
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    temperature: options.temperature || 0.3,
                    max_tokens: options.max_tokens || 2048
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                var errText = '';
                try { errText = await response.text(); } catch(e) {}
                throw new Error('API error ' + response.status + ': ' + (errText.substring(0, 200)));
            }

            var data = await response.json();
            // Support both OpenAI format and proxy format
            return data.choices?.[0]?.message?.content || data.content || '';
        } finally {
            clearTimeout(timer);
        }
    };
}
