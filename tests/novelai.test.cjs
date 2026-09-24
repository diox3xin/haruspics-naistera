const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('async function generateImageNovelAI(');
const end = source.indexOf('async function generateImageOpenAI(', start);
assert.ok(start >= 0 && end > start, 'NovelAI provider must exist');

function setup(response, settings = {}) {
    const requests = [];
    const config = {
        novelaiModel: 'nai-diffusion-5-full', novelaiWidth: 832, novelaiHeight: 1216,
        novelaiSteps: 28, novelaiScale: 5, novelaiSampler: 'k_dpmpp_2m',
        novelaiScheduler: 'karras', novelaiNegativePrompt: 'blurry', novelaiSeed: -1,
        novelaiSm: false, novelaiSmDyn: false, novelaiDecrisper: false,
        novelaiVarietyBoost: false, apiKey: 'not-sent-to-novelai', ...settings,
    };
    const context = vm.createContext({
        getSettings: () => config,
        iigLog: () => {},
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }) }) },
        fetch: async (url, init) => { requests.push({ url, init }); return response; },
    });
    vm.runInContext(source.slice(start, end), context);
    return { generate: context.generateImageNovelAI, requests };
}

test('sends text only via SillyTavern and converts its base64 PNG response', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pZHjTQAAAAASUVORK5CYII=';
    const { generate, requests } = setup({ ok: true, text: async () => png });
    const result = await generate('forest', 'anime', {
        textDirectives: ['[CHARACTER APPEARANCE]: red hair'],
        imageRefs: [{ data: 'SECRET_IMAGE_DATA', description: 'red hair', name: 'Hero', type: 'face' }],
        textOnlyClothing: [{ charName: 'Hero', description: 'blue coat' }],
    }, { negativePrompt: 'low quality', aspectRatio: '1:1' });
    assert.equal(result, `data:image/png;base64,${png}`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/novelai/generate-image');
    assert.equal(requests[0].init.headers['X-CSRF-Token'], 'test');
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.model, 'nai-diffusion-5-full');
    assert.equal(body.negative_prompt, 'low quality');
    assert.equal(body.width, body.height);
    assert.match(body.prompt, /anime.*red hair.*blue coat.*forest/);
    assert.doesNotMatch(requests[0].init.body, /SECRET_IMAGE_DATA|not-sent-to-novelai|reference_image_multiple/);
    assert.equal(body.seed, -1);
});

test('missing token gives actionable error', async () => {
    const { generate } = setup({ ok: false, status: 400 });
    await assert.rejects(generate('cat', '', {}), /Access Token.*SillyTavern/);
});

test('rejects invalid image response instead of uploading it', async () => {
    const { generate } = setup({ ok: true, text: async () => '<html>not an image</html>' });
    await assert.rejects(generate('cat', '', {}), /некорректное изображение/);
});

test('uses default negative prompt and ignores malformed aspect ratio', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pZHjTQAAAAASUVORK5CYII=';
    const { generate, requests } = setup({ ok: true, text: async () => png });
    await generate('cat', '', {}, { aspectRatio: '100:1', negativePrompt: null });
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.width, 832);
    assert.equal(body.height, 1216);
    assert.equal(body.negative_prompt, 'blurry');
});

test('reports an outdated SillyTavern server', async () => {
    const { generate } = setup({ ok: false, status: 404 });
    await assert.rejects(generate('cat', '', {}), /Обновите SillyTavern/);
});

test('collector forwards library and wardrobe descriptions, not images, to official NovelAI', async () => {
    const collectorStart = source.indexOf('async function collectReferenceImages(');
    const collectorEnd = source.indexOf('// IMAGE GENERATION: OpenAI', collectorStart);
    assert.ok(collectorStart >= 0 && collectorEnd > collectorStart);
    const settings = { apiType: 'novelai', npcReferences: [], autoDetectNames: false };
    const context = vm.createContext({
        getSettings: () => settings,
        SillyTavern: { getContext: () => ({ characters: [{ name: 'Hero' }], characterId: 0, name1: 'User' }) },
        collectCharacterLibraryReferences: async (kind) => ({
            descriptions: [`${kind} library description`],
            refs: [{ data: 'LIBRARY_IMAGE', type: 'face' }],
            hasPrimary: true,
        }),
        getActiveWardrobeItem: (kind) => kind === 'char'
            ? { imageData: 'WARDROBE_IMAGE', description: 'green jacket', name: 'Jacket' }
            : null,
        detectMimeType: () => 'image/png',
        iigLog: () => {},
        MAX_IMAGE_REFS: 4,
    });
    vm.runInContext(source.slice(collectorStart, collectorEnd), context);
    const result = await context.collectReferenceImages('Hero in a forest');
    assert.equal(result.imageRefs.length, 0);
    assert.equal(result.textOnlyClothing.length, 1);
    assert.equal(result.textOnlyClothing[0].description, 'green jacket');
    assert.match(result.textDirectives.join(' '), /char library description.*user library description/);
});