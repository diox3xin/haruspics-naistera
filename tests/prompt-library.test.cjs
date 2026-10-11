const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function load(start, end, settings) {
    const context = vm.createContext({
        MODULE_NAME: 'inline_image_gen',
        structuredClone: value => JSON.parse(JSON.stringify(value)),
        SillyTavern: { getContext: () => ({ extensionSettings: { inline_image_gen: settings }, saveSettingsDebounced() {} }) },
    });
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from);
    vm.runInContext(source.slice(from, to), context);
    return context;
}

test('prompt instruction library contains image and comic defaults and supports custom entries', () => {
    const context = load('const defaultSettings', '// WARDROBE SYSTEM', {});
    const items = context.getPromptInstructions();
    assert.equal(Array.from(items, item => item.id).join(','), 'builtin-image,builtin-comic');
    const custom = context.addPromptInstruction('My panels', 'Return a panel-by-panel prompt.', 'comic');
    assert.equal(context.getSettings().activePromptInstructionId, custom.id);
    assert.equal(context.getActivePromptInstruction().prompt, 'Return a panel-by-panel prompt.');
});

test('active negative is independent from API preset fields and tag overrides it', () => {
    const settings = {
        negativeGalleryItems: [{ id: 'neg-1', name: 'Clean', prompt: 'blurry, low quality' }],
        activeNegativeId: 'neg-1',
    };
    const context = load('const defaultSettings', '// WARDROBE SYSTEM', settings);
    assert.equal(context.getActiveNegativePrompt(), 'blurry, low quality');
    assert.equal(context.getEffectiveNegativePrompt(''), 'blurry, low quality');
    assert.equal(context.getEffectiveNegativePrompt('only this image'), 'only this image');
});