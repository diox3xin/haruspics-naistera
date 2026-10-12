const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('const IMAGE_TAG_FORMAT');
const end = source.indexOf('function updateWardrobeInjection()', start);
assert.ok(start >= 0 && end > start, 'image mode helpers must exist');

function setup(settings) {
    const calls = [];
    const classes = new Set();
    const context = vm.createContext({
        MODULE_NAME: 'iig',
        iigLog: () => {},
        getSettings: () => settings,
        SillyTavern: { getContext: () => ({ setExtensionPrompt: (...args) => calls.push(args) }) },
        document: { body: { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } } },
    });
    vm.runInContext(source.slice(start, end), context);
    return { context, calls, classes };
}

test('normalize falls back to inline', () => {
    const { context } = setup({});
    assert.equal(context.normalizeImageDisplayMode('extblocks'), 'extblocks');
    assert.equal(context.normalizeImageDisplayMode('external'), 'inline');
    assert.equal(context.normalizeImageDisplayMode(undefined), 'inline');
});

test('instructions differ per mode and keep the tag format', () => {
    const { context } = setup({});
    const inline = context.buildImageModeInstruction('inline');
    const ext = context.buildImageModeInstruction('extblocks');
    assert.match(inline, /inline mode/);
    assert.match(inline, /Do NOT wrap it in HTML/);
    assert.match(ext, /HTML\/CSS artifact/);
    for (const text of [inline, ext]) assert.ok(text.includes(`src="[IMG:GEN]"`));
});

test('injection is cleared when disabled and set when enabled', () => {
    const settings = { enabled: true, injectImageModeInstruction: false, imageDisplayMode: 'extblocks', imageModeInjectionDepth: 3 };
    const { context, calls } = setup(settings);
    context.updateImageModeInjection();
    assert.deepEqual(calls.at(-1), ['iig_image_mode', '', 0, 0]);
    settings.injectImageModeInstruction = true;
    context.updateImageModeInjection();
    const [key, text, position, depth] = calls.at(-1);
    assert.equal(key, 'iig_image_mode');
    assert.match(text, /external blocks mode/);
    assert.equal(position, 1);
    assert.equal(depth, 3);
    settings.enabled = false;
    context.updateImageModeInjection();
    assert.equal(calls.at(-1)[1], '');
});

test('applyImageDisplayMode toggles body classes', () => {
    const { context, classes } = setup({ imageDisplayMode: 'inline' });
    context.applyImageDisplayMode('extblocks');
    assert.ok(classes.has('iig-mode-extblocks') && !classes.has('iig-mode-inline'));
    context.applyImageDisplayMode('inline');
    assert.ok(classes.has('iig-mode-inline') && !classes.has('iig-mode-extblocks'));
});
