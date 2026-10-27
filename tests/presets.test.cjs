const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('const PRESET_FIELDS = [');
const end = source.indexOf('function deletePreset(', start);
assert.ok(start >= 0 && end > start, 'preset code must exist');

function setup(settings) {
    const context = vm.createContext({ getSettings: () => settings, saveSettings: () => context.syncActivePresetFromSettings(settings) });
    vm.runInContext(`${source.slice(start, end)}\nglobalThis.loadPreset = loadPreset; globalThis.syncActivePresetFromSettings = syncActivePresetFromSettings;`, context);
    return context;
}

const novelai = () => ({ id: 'nai', name: 'NovelAI', apiType: 'novelai', novelaiNegativePrompt: 'long negative', novelaiWidth: 1152 });
const gemini = () => ({ id: 'gem', name: 'Gemini', apiType: 'gemini', model: 'nano', novelaiNegativePrompt: '', novelaiWidth: 832 });

test('a Gemini preset does not overwrite NovelAI fields', () => {
    const settings = { apiType: 'novelai', novelaiNegativePrompt: 'long negative', novelaiWidth: 1152, apiPresets: [novelai(), gemini()], activePresetId: 'nai' };
    const ctx = setup(settings);
    ctx.loadPreset('gem');
    assert.equal(settings.apiType, 'gemini');
    assert.equal(settings.model, 'nano');
    assert.equal(settings.novelaiNegativePrompt, 'long negative');
    assert.equal(settings.novelaiWidth, 1152);
});

test('edits made while a preset is selected are kept in that preset', () => {
    const settings = { apiType: 'novelai', novelaiNegativePrompt: 'long negative', novelaiWidth: 1152, apiPresets: [novelai(), gemini()], activePresetId: 'nai' };
    const ctx = setup(settings);
    settings.novelaiNegativePrompt = 'edited negative';
    ctx.syncActivePresetFromSettings(settings);
    ctx.loadPreset('gem');
    ctx.loadPreset('nai');
    assert.equal(settings.novelaiNegativePrompt, 'edited negative');
});

test('changing the API type detaches the preset instead of rewriting it', () => {
    const settings = { apiType: 'novelai', apiPresets: [novelai()], activePresetId: 'nai' };
    const ctx = setup(settings);
    settings.apiType = 'openai';
    ctx.syncActivePresetFromSettings(settings);
    assert.equal(settings.activePresetId, null);
    assert.equal(settings.apiPresets[0].apiType, 'novelai');
});
