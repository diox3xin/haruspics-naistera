const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from);
    return source.slice(from, to);
}

function collector(config = {}, outfit = {}, hair = null, refs = []) {
    const context = vm.createContext({
        getSettings: () => ({ apiType: 'naistera', npcReferences: [], ...config }),
        SillyTavern: { getContext: () => ({ characters: [{ name: 'Hero' }], characterId: 0, name1: 'User' }) },
        collectCharacterLibraryReferences: async kind => ({ descriptions: [], refs: kind === 'char' ? refs : [], hasPrimary: true }),
        getActiveWardrobeItem: () => outfit,
        getActiveHairstyleItem: kind => kind === 'char' ? hair : null,
        detectMimeType: () => 'image/png', iigLog: () => {}, MAX_IMAGE_REFS: 4,
    });
    vm.runInContext(section('async function collectReferenceImages(', '// IMAGE GENERATION: OpenAI'), context);
    return context.collectReferenceImages('forest');
}

test('text-only wardrobe excludes its images for both character and user', async () => {
    const result = await collector({ wardrobeSendMode: 'text' }, { imageData: 'PRIVATE_IMAGE', description: 'blue coat' });
    assert.equal(result.imageRefs.length, 0);
    assert.deepEqual(Array.from(result.textOnlyClothing, ref => ref.charName), ['Hero', 'User']);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_IMAGE/);
});

test('wardrobe descriptions without a photo work for every provider', async () => {
    for (const apiType of ['naistera', 'novelai', 'novelai-direct', 'openai', 'gemini']) {
        const result = await collector({ apiType }, { description: 'red dress', imageData: null });
        assert.equal(result.imageRefs.length, 0, apiType);
        assert.equal(result.textOnlyClothing.length, 2, apiType);
    }
});

test('none mode suppresses wardrobe but keeps independent hairstyle descriptions', async () => {
    const result = await collector({ wardrobeSendMode: 'none', hairstyleSendMode: 'text' },
        { imageData: 'COAT', description: 'red coat' }, { imageData: 'HAIR', description: 'short curls' });
    assert.equal(result.textOnlyClothing.length, 0);
    assert.equal(result.imageRefs.length, 0);
    assert.match(result.textDirectives.join(' '), /short curls/);
    assert.doesNotMatch(JSON.stringify(result), /red coat|COAT|"HAIR"/);
});

test('both mode preserves image references and falls back to text when slots are full', async () => {
    const outfit = { imageData: 'COAT', description: 'red coat' };
    assert.equal((await collector({}, outfit)).imageRefs.length, 2);
    const full = await collector({}, outfit, null, Array.from({ length: 4 }, () => ({ type: 'face', data: 'FACE' })));
    assert.equal(full.imageRefs.length, 4);
    assert.equal(full.textOnlyClothing.length, 2);
});

test('NovelAI uses hairstyle text and reports missing wardrobe descriptions', async () => {
    for (const apiType of ['novelai', 'novelai-direct']) {
        const result = await collector({ apiType }, { name: 'Coat', imageData: 'COAT' }, { description: 'long braids', imageData: 'HAIR' });
        assert.equal(result.imageRefs.length, 0);
        assert.equal(result.warnings.length, 2);
        assert.match(result.textDirectives.join(' '), /long braids/);
    }
});

test('generated legacy tags retain prompt, style and options for regeneration', async () => {
    const context = vm.createContext({ iigLog: () => {} });
    vm.runInContext(section('function escapeHtml(', '// SETTINGS'), context);
    vm.runInContext(section('function buildGeneratedImageTag(', 'async function restoreImageRegenButtons('), context);
    vm.runInContext(section('async function parseImageTags(', '// DOM HELPERS'), context);
    const tag = { prompt: `Hero's "coat" <red> & blue`, style: 'anime', aspectRatio: '2:3', negativePrompt: 'blur' };
    const html = context.buildGeneratedImageTag(tag, '/images/result.png');
    const parsed = await context.parseImageTags(html, { forceAll: true });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].prompt, tag.prompt);
    assert.equal(parsed[0].style, tag.style);
    assert.equal(parsed[0].aspectRatio, '2:3');
    assert.equal(parsed[0].negativePrompt, 'blur');
    assert.doesNotMatch(html, /<red>/);
});

class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attrs = {}; this.events = {}; }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key]; }
    addEventListener(name, handler) { this.events[name] = handler; }
    replaceWith(other) {
        const parent = this.parent;
        parent.children[parent.children.indexOf(this)] = other;
        other.parent = parent;
        this.parent = null;
    }
    closest() { return this.parent?.className === 'iig-image-wrapper' ? this.parent : null; }
    querySelector(selector) { return this.children.find(child => '.' + child.className === selector) || null; }
}

test('restores visible regen buttons after rendering, without duplicate wrappers', async () => {
    const parent = new Element('div');
    const images = [new Element('img'), new Element('img')];
    for (const img of images) { img.setAttribute('src', '/images/generated.png'); parent.appendChild(img); }
    const context = vm.createContext({
        document: { createElement: tag => new Element(tag) },
        SillyTavern: { getContext: () => ({ chat: { 7: { mes: 'saved tags' } } }) },
        processingMessages: new Set(),
        parseImageTags: async () => images.map(() => ({ existingSrc: '/images/generated.png' })),
    });
    vm.runInContext(section('function wrapImageWithRegen(', '// MESSAGE PROCESSING'), context);
    const message = { isConnected: true, querySelectorAll: () => images };
    await context.restoreImageRegenButtons(message, 7);
    await context.restoreImageRegenButtons(message, 7);
    assert.equal(parent.children.length, 2);
    for (const wrapper of parent.children) {
        assert.equal(wrapper.className, 'iig-image-wrapper');
        assert.equal(wrapper.children.length, 2);
        assert.match(wrapper.children[0].style.cssText, /display:flex/);
        assert.equal(wrapper.children[0].dataset.messageId, 7);
        assert.equal(wrapper.children[0].dataset.tagIndex, parent.children.indexOf(wrapper));
    }
    // Actual clicks (including cloned buttons) are covered by regen-browser.test.cjs.
    const processing = section('async function processMessageTags(', '// SINGLE IMAGE REGENERATION');
    assert.ok(processing.lastIndexOf('restoreImageRegenButtons(') > processing.indexOf('mesTextEl.innerHTML = context.messageFormatting'));
});

test('crop coordinates support reverse dragging and clamp to image boundaries', () => {
    const context = vm.createContext({});
    vm.runInContext(section('function getCropRectangle(', '// Returns null on cancel'), context);
    const crop = context.getCropRectangle({ x: 900, y: 500 }, { x: -10, y: 20 }, 800, 400);
    assert.deepEqual(JSON.parse(JSON.stringify(crop)), { x: 0, y: 20, width: 800, height: 380 });
});

test('saved image is changed only after confirmation, preserving name and description', async () => {
    for (const edited of [null, 'ORIGINAL', 'CROPPED']) {
        let saved = 0;
        const context = vm.createContext({
            openReferenceImageEditor: async () => edited,
            resizeImageBase64: async image => image,
            saveSettings: () => saved++, renderQuickWardrobeList() {}, toastr: { success() {} },
        });
        vm.runInContext(section('function editSavedReferenceImage(', 'function addReferenceCardControls('), context);
        const item = { imageData: 'ORIGINAL', name: 'Coat', description: 'red coat' };
        await context.editSavedReferenceImage(item, () => {});
        assert.equal(item.imageData, edited === 'CROPPED' ? edited : 'ORIGINAL');
        assert.equal(saved, edited === 'CROPPED' ? 1 : 0);
        assert.equal(item.description, 'red coat');
    }
});

test('new helpers and text buttons are declared once', () => {
    for (const name of ['editSavedReferenceImage', 'addReferenceCardControls', 'bindReferenceUpload', 'openReferenceImageEditor']) {
        assert.equal(source.match(new RegExp(`function ${name}\\(`, 'g')).length, 1, name);
    }
    for (const target of ['char', 'user']) {
        assert.equal(source.match(new RegExp(`id="iig_wardrobe_${target}_text"`, 'g')).length, 1);
    }
});