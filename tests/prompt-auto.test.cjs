const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm'); const assert = require('node:assert/strict'); const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const grab = name => { const start = source.indexOf(`function ${name}(`); const end = source.slice(start).search(/\r?\n\}\r?\n/); return source.slice(start, start + end + source.slice(start + end).indexOf('}') + 1); };
const chat = [{ is_user: false, mes: 'Hello there', extra: {} }];
let calls = 0;
let images = 0;
let promptOk = true;
const settings = { promptAutoGenerate: true };
const ctx = vm.createContext({ getSettings: () => settings, SillyTavern: { getContext: () => ({ chat }) }, runPromptGeneration: () => { calls++; return Promise.resolve(promptOk); }, runImageFromPrompt: () => { images++; } });
vm.runInContext(grab('promptSourceHash') + '\n' + grab('maybeAutoGeneratePrompt') + '\nglobalThis.auto = maybeAutoGeneratePrompt; globalThis.hash = promptSourceHash;', ctx);
test('«Авто» writes a prompt once per reply text and only when switched on', () => {
ctx.auto(0); assert.equal(calls, 1);
chat[0].extra.iig_prompt_block = { sourceHash: ctx.hash('Hello there') }; ctx.auto(0); assert.equal(calls, 1);
chat[0].mes = 'New swipe text'; ctx.auto(0); assert.equal(calls, 2);
settings.promptAutoGenerate = false; chat[0].mes = 'x'; ctx.auto(0); assert.equal(calls, 2);
});

test('«Авто» draws the picture right after a successful prompt, not after a failed one', async () => {
    images = 0;
    settings.promptAutoGenerate = true;
    chat[0].mes = 'Another reply';
    promptOk = true;
    ctx.auto(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(images, 1);
    chat[0].mes = 'Yet another reply';
    promptOk = false;
    ctx.auto(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(images, 1);
});

