const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const defaultsStart = source.indexOf('const defaultSettings');
const defaultsEnd = source.indexOf('// MODEL DETECTION', defaultsStart);
const start = source.indexOf('const FULL_PRESET_EXCLUDED_KEYS');
const end = source.indexOf('function renderFullPresetSelect()', start);
assert.ok(defaultsStart >= 0 && defaultsEnd > defaultsStart, 'defaults must exist');
assert.ok(start >= 0 && end > start, 'full preset helpers must exist');

function setup() {
    const context = vm.createContext({ structuredClone, saveCalls: 0 });
    vm.runInContext(source.slice(defaultsStart, defaultsEnd), context);
    vm.runInContext(`
        var settings = structuredClone(defaultSettings);
        function getSettings() { return settings; }
        function saveSettings() { saveCalls++; }
    `, context);
    vm.runInContext(source.slice(start, end), context);
    return context;
}

test('preset stores API, style selection and toggles but not wardrobe or libraries', () => {
    const ctx = setup();
    Object.assign(ctx.settings, {
        apiType: 'gemini', apiKey: 'k1', model: 'm1',
        activeStyleIds: ['s1'], activeNegativeId: 'n1', activePromptInstructionId: 'p1',
        sendCharAvatar: true, imageDisplayMode: 'extblocks',
        wardrobeItems: [{ id: 'w1' }], activeWardrobeChar: 'w1',
        styleGalleryItems: [{ id: 's1' }],
    });
    const preset = ctx.saveCurrentAsFullPreset('  Gemini  ');
    assert.equal(preset.name, 'Gemini');
    assert.equal(ctx.settings.activeFullPresetId, preset.id);
    assert.equal(preset.values.apiKey, 'k1');
    assert.deepEqual([...preset.values.activeStyleIds], ['s1']);
    assert.equal(preset.values.sendCharAvatar, true);
    assert.equal(preset.values.imageDisplayMode, 'extblocks');
    for (const key of ['wardrobeItems', 'activeWardrobeChar', 'styleGalleryItems', 'characterProfiles', 'fullPresets', 'apiPresets', 'settingsUiState']) {
        assert.ok(!Object.hasOwn(preset.values, key), `${key} must not be stored`);
    }
});

test('applying a preset restores values and leaves wardrobe untouched', () => {
    const ctx = setup();
    Object.assign(ctx.settings, { apiType: 'gemini', model: 'a', activeStyleIds: ['s1'], maxRetries: 3 });
    const preset = ctx.saveCurrentAsFullPreset('A');
    Object.assign(ctx.settings, {
        apiType: 'openai', model: 'b', activeStyleIds: ['s2'], maxRetries: 0,
        wardrobeItems: [{ id: 'w9' }], activeWardrobeChar: 'w9',
    });
    ctx.applyFullPreset(preset.id);
    assert.equal(ctx.settings.apiType, 'gemini');
    assert.equal(ctx.settings.model, 'a');
    assert.deepEqual([...ctx.settings.activeStyleIds], ['s1']);
    assert.equal(ctx.settings.maxRetries, 3);
    assert.equal(ctx.settings.activeWardrobeChar, 'w9');
    assert.equal(ctx.settings.wardrobeItems.length, 1);
});

test('applied values are copies, so later edits do not mutate the preset', () => {
    const ctx = setup();
    ctx.settings.activeStyleIds = ['s1'];
    const preset = ctx.saveCurrentAsFullPreset('A');
    ctx.applyFullPreset(preset.id);
    ctx.settings.activeStyleIds.push('s2');
    assert.deepEqual([...preset.values.activeStyleIds], ['s1']);
});

test('older presets missing a key keep the current value; update/rename/delete work', () => {
    const ctx = setup();
    const preset = ctx.saveCurrentAsFullPreset('A');
    delete preset.values.requestTimeout;
    ctx.settings.requestTimeout = 300;
    ctx.applyFullPreset(preset.id);
    assert.equal(ctx.settings.requestTimeout, 300);

    ctx.settings.model = 'new-model';
    ctx.updateFullPresetFromCurrent(preset.id);
    assert.equal(preset.values.model, 'new-model');

    assert.equal(ctx.renameFullPreset(preset.id, '   '), null);
    ctx.renameFullPreset(preset.id, 'B');
    assert.equal(preset.name, 'B');

    ctx.deleteFullPreset(preset.id);
    assert.equal(ctx.settings.fullPresets.length, 0);
    assert.equal(ctx.settings.activeFullPresetId, null);
    assert.equal(ctx.applyFullPreset(preset.id), null);
});
