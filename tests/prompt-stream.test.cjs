const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('async function readChatCompletionStream(');
const end = source.indexOf('async function generateImagePromptForMessage(', start);
assert.ok(start >= 0 && end > start, 'stream reader not found');

function makeResponse(chunks) {
    const encoder = new TextEncoder();
    let i = 0;
    return {
        body: {
            getReader: () => ({
                read: async () => (i < chunks.length
                    ? { value: encoder.encode(chunks[i++]), done: false }
                    : { value: undefined, done: true }),
            }),
        },
    };
}

const context = vm.createContext({ TextDecoder, TextEncoder });
vm.runInContext(source.slice(start, end), context);

test('stream reader joins deltas split across network chunks', async () => {
    const seen = [];
    const response = makeResponse([
        'data: {"choices":[{"delta":{"content":"red "}}]}\n\ndata: {"choi',
        'ces":[{"delta":{"content":"dress"}}]}\n\n: keep-alive\n',
        'data: [DONE]\n\n',
    ]);
    const text = await context.readChatCompletionStream(response, t => seen.push(t));
    assert.equal(text, 'red dress');
    assert.deepEqual(seen, ['red ', 'red dress']);
});

test('panel has stream toggle and cancel button wired to the abort controller', () => {
    assert.match(source, /class="menu_button iig-pp-pill iig-prompt-stream-toggle/);
    assert.match(source, /class="menu_button iig-pp-btn iig-prompt-cancel" hidden/);
    assert.match(source, /activePromptAbortControllers\.get\(messageId\)\?\.abort\(\)/);
    assert.match(source, /\.\.\.\(onChunk \? \{ stream: true \} : \{\}\)/);
});

test('the panel is a one-line card with status, live preview, stop and «Авто»', () => {
    assert.match(source, /class="iig-pp-summary iig-prompt-panel-toggle"/);
    assert.match(source, /class="iig-pp-chip iig-prompt-chip"/);
    assert.match(source, /class="iig-pp-progress"/);
    assert.match(source, /iig-prompt-auto-toggle/);
    assert.match(source, /promptAutoGenerate: false/);
    // Auto runs only for freshly generated replies, marked on MESSAGE_RECEIVED.
    assert.match(source, /event_types\.MESSAGE_RECEIVED[\s\S]{0,200}pendingAutoPrompts\.add/);
    assert.match(source, /pendingAutoPrompts\.delete\(Number\(messageId\)\)\) maybeAutoGeneratePrompt/);
});

