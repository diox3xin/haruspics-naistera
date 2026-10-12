const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const section = (from, to) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start + from.length);
    assert.ok(start >= 0 && end > start, `section ${from}`);
    return source.slice(start, end);
};

function load(overrides = {}) {
    const calls = { fetch: [], generate: [], saved: 0, added: [] };
    const settings = { refGenSource: 'main', apiType: 'openai-chat', wardrobeItems: [], ...overrides.settings };
    const context = vm.createContext({
        getSettings: () => settings,
        saveSettings: () => calls.saved++,
        detectMimeType: () => 'image/png',
        buildOpenAIUrl: (base, p) => `${base}/v1/${p}`,
        buildAuthHeaders: (key, extra) => ({ ...extra, Authorization: `Bearer ${key}` }),
        parseImageFromApiResponse: r => r.image || null,
        toastr: { warning() {}, error() {}, success() {} },
        addWardrobeItem: (name, imageData, target, category) => {
            const item = { id: 'x', name, imageData, target, category, description: '' };
            calls.added.push(item);
            return item;
        },
        generateImageWithRetry: async (prompt, style, onStatus, options) => {
            calls.generate.push({ prompt, options });
            return 'data:image/png;base64,MAIN';
        },
        fetch: async (url, init) => {
            calls.fetch.push({ url, body: JSON.parse(init.body) });
            return { ok: true, json: async () => ({ image: 'data:image/png;base64,CUSTOM' }) };
        },
    });
    vm.runInContext(
        section('const REF_GEN_FLAG_DEFAULTS', '// API PRESETS SYSTEM').replace('const REF_GEN_FLAG_DEFAULTS', 'globalThis.REF_GEN_FLAG_DEFAULTS'),
        context,
    );
    return { context, calls, settings };
}

test('prompt reflects refs, description and flags', () => {
    const { context } = load();
    const prompt = context.buildReferenceGenPrompt({
        name: 'Mira', description: 'tall, athletic', hasCharacterRef: true, hasOutfitRef: true,
        flags: { ignoreTattoos: true, bodyFromDescription: true, noHairTransfer: true, noAccessoriesTransfer: false },
    });
    assert.match(prompt, /reference sheet of Mira/);
    assert.match(prompt, /CHARACTER reference/);
    assert.match(prompt, /OUTFIT reference/);
    assert.match(prompt, /Appearance and body: tall, athletic/);
    assert.match(prompt, /tattoos/);
    assert.match(prompt, /hairstyle/);
    assert.doesNotMatch(prompt, /jewelry/);
});

test('refined description wins over the raw one; refs omitted when absent', () => {
    const { context } = load();
    const prompt = context.buildReferenceGenPrompt({ description: 'raw', refinedDescription: 'refined', flags: {} });
    assert.match(prompt, /Appearance and body: refined/);
    assert.doesNotMatch(prompt, /CHARACTER reference|OUTFIT reference/);
});

test('main source uses generateImageWithRetry with face and clothing refs', async () => {
    const { context, calls } = load();
    const result = await context.generateReferenceImage({ name: 'Mira', characterImage: 'AAA', outfitImage: 'BBB', finalPrompt: 'edited prompt' });
    assert.equal(result, 'MAIN');
    assert.equal(calls.generate[0].prompt, 'edited prompt');
    const refs = calls.generate[0].options.refData.imageRefs;
    assert.deepEqual(Array.from(refs, r => r.type), ['face', 'clothing']);
    assert.equal(calls.fetch.length, 0);
});

test('custom source posts to its own endpoint and validates config', async () => {
    const { context, calls, settings } = load({ settings: { refGenSource: 'custom' } });
    await assert.rejects(() => context.generateReferenceImage({ finalPrompt: 'p' }), /endpoint/);
    Object.assign(settings, { refGenEndpoint: 'https://x', refGenApiKey: 'k', refGenModel: 'm' });
    const result = await context.generateReferenceImage({ finalPrompt: 'p', outfitImage: 'BBB' });
    assert.equal(result, 'CUSTOM');
    assert.equal(calls.fetch[0].url, 'https://x/v1/chat/completions');
    assert.equal(calls.fetch[0].body.model, 'm');
    assert.equal(calls.generate.length, 0);
});

test('saving keeps description, prompt and flags with the wardrobe item', () => {
    const { context, calls } = load();
    const item = context.saveGeneratedReference({
        target: 'user', name: 'Mira', itemName: 'Body ref', description: 'raw',
        refinedDescription: 'refined', finalPrompt: 'final', flags: { noHairTransfer: true },
    }, 'IMG');
    assert.equal(calls.added[0].target, 'user');
    assert.equal(item.description, 'refined');
    assert.equal(item.refGen.finalPrompt, 'final');
    assert.equal(item.refGen.sourceDescription, 'raw');
    assert.equal(item.refGen.flags.noHairTransfer, true);
    assert.equal(item.refGen.flags.ignoreTattoos, true);
    assert.ok(calls.saved > 0);
    assert.throws(() => context.saveGeneratedReference({}, null), /сгенерируйте/);
});
