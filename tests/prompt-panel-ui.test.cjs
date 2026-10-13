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

test('Gemini format toggle appears for apiType=gemini or Gemini-family model', () => {
    assert.match(source, /iig-gemini-format-toggle/);
    assert.match(source, /geminiRandomFormat/);
    assert.match(source, /apiType === 'gemini' \|\| isGeminiModel\(settings\.model/);
});

test('Gemini random format picks random aspect ratio only (image size stays)', () => {
    assert.match(source, /isGemini && settings\.geminiRandomFormat/);
    assert.match(source, /VALID_ASPECT_RATIOS\[Math\.floor\(Math\.random\(\)/);
    // image size must NOT be randomized
    assert.doesNotMatch(source, /imageSize = VALID_IMAGE_SIZES\[Math\.floor\(Math\.random\(\)/);
});

test('Gemini logs reference breakdown for debugging', () => {
    assert.match(source, /iigLog\('INFO', `Gemini refs: faces=/);
    assert.match(source, /clothingImages=/);
    assert.match(source, /hairstyles=/);
    assert.match(source, /textClothing=/);
    assert.match(source, /textDirectives=/);
});