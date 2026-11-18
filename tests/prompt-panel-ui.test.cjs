const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('Prompt panel has collapse toggles in extblocks mode', () => {
    assert.match(source, /iig-prompt-panel-toggle/);
    assert.match(source, /iig-prompt-meta-toggle/);
    assert.match(source, /promptPanelCollapsed/);
    assert.match(source, /promptMetaCollapsed/);
    assert.match(source, /iig-collapsed-hidden/);
});

test('random format toggle appears for every API except NovelAI', () => {
    assert.match(source, /iig-gemini-format-toggle/);
    assert.match(source, /geminiRandomFormat/);
    assert.match(source, /const showFormat = !NOVELAI_API_TYPES\.includes\(settings\.apiType\);/);
});

test('random format picks the aspect ratio once per picture, over the tag ratio, size stays', () => {
    const retry = source.slice(source.indexOf('async function generateImageWithRetry('), source.indexOf('const timeoutMs', source.indexOf('async function generateImageWithRetry(')));
    assert.match(retry, /if \(usesRandomAspectRatio\(settings, options\)\) \{\s*\/\/[^\n]*\n\s*options = \{ \.\.\.options, aspectRatio: pickRandomAspectRatio\(\) \};/);
    assert.match(source, /VALID_ASPECT_RATIOS\[Math\.floor\(Math\.random\(\)/);
    assert.doesNotMatch(source, /geminiRandomFormat && !options\.aspectRatio/);
    assert.doesNotMatch(source, /imageSize = VALID_IMAGE_SIZES\[Math\.floor\(Math\.random\(\)/);
    // reference generation keeps its portrait format
    assert.match(source, /aspectRatio: '2:3', keepAspectRatio: true/);
});

test('usesRandomAspectRatio: on for Banana / GPT Image, off for NovelAI and refgen', () => {
    const vm = require('node:vm');
    const grab = name => { const i = source.indexOf(`function ${name}(`); const end = source.slice(i).search(/\r?\n\}\r?\n/); return source.slice(i, i + end + source.slice(i + end).indexOf('}') + 1); };
    const ctx = vm.createContext({});
    vm.runInContext(source.match(/const NOVELAI_API_TYPES = [^\n]+/)[0] + '\n' + grab('usesRandomAspectRatio') + '\nglobalThis.f = usesRandomAspectRatio;', ctx);
    assert.equal(ctx.f({ geminiRandomFormat: true, apiType: 'gemini' }), true);
    assert.equal(ctx.f({ geminiRandomFormat: true, apiType: 'openai' }), true);
    assert.equal(ctx.f({ geminiRandomFormat: false, apiType: 'openai' }), false);
    assert.equal(ctx.f({ geminiRandomFormat: true, apiType: 'novelai-direct' }), false);
    assert.equal(ctx.f({ geminiRandomFormat: true, apiType: 'gemini' }, { keepAspectRatio: true }), false);
});

test('Gemini logs reference breakdown for debugging', () => {
    assert.match(source, /iigLog\('INFO', `Gemini refs: faces=/);
    assert.match(source, /clothingImages=/);
    assert.match(source, /hairstyles=/);
    assert.match(source, /textClothing=/);
    assert.match(source, /textDirectives=/);
});