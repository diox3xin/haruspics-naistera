const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const zlib = require('node:zlib');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('async function extractNovelAIPng(');
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
        normalizeApiKey: key => String(key || '').trim().replace(/^Bearer\s+/i, ''),
        Uint8Array, DataView, TextDecoder, Response, Blob, DecompressionStream, btoa,
        SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }) }) },
        fetch: async (url, init) => { requests.push({ url, init }); return response; },
        namesAppearInPrompt: (names, text) => names.some(name => String(text).toLowerCase().includes(String(name).toLowerCase())),
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

function zipPng(png, deflate = true) {
    const file = Buffer.from('image_0.png');
    const compressed = deflate ? zlib.deflateRawSync(png) : png;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(png.length, 22); local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(png.length, 24); central.writeUInt16LE(file.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + file.length, 12);
    end.writeUInt32LE(local.length + file.length + compressed.length, 16);
    const zip = Buffer.concat([local, file, compressed, central, file, end]);
    return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
}

test('direct NovelAI sends own token only to image.novelai.net and extracts stored and deflated PNG', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pZHjTQAAAAASUVORK5CYII=', 'base64');
    for (const deflate of [false, true]) {
        const { generate, requests } = setup({ ok: true, arrayBuffer: async () => zipPng(png, deflate) }, { apiType: 'novelai-direct', novelaiApiKey: 'own-token' });
        assert.equal(await generate('cat', '', {}), `data:image/png;base64,${png.toString('base64')}`);
        assert.equal(requests[0].url, 'https://image.novelai.net/ai/generate-image');
        assert.equal(requests[0].init.headers.Authorization, 'Bearer own-token');
        assert.doesNotMatch(requests[0].init.body, /own-token|not-sent-to-novelai/);
        const body = JSON.parse(requests[0].init.body);
        assert.equal(body.parameters.params_version, 4);
        assert.equal(body.parameters.v4_prompt.caption.base_caption, 'cat');
    }
});

test('direct NovelAI exposes upstream error without leaking the token and rejects invalid ZIP', async () => {
    const settings = { apiType: 'novelai-direct', novelaiApiKey: 'private-key' };
    const failed = setup({ ok: false, status: 400, text: async () => 'Bad Request private-key' }, settings);
    await assert.rejects(failed.generate('cat', '', {}), /Bad Request \[redacted\]/);
    const missingImage = setup({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }, settings);
    await assert.rejects(missingImage.generate('cat', '', {}), /ZIP/);
});

test('collector forwards library and wardrobe descriptions, not images, to official NovelAI', async () => {
    const collectorStart = source.indexOf('async function collectReferenceImages(');
    const collectorEnd = source.indexOf('// IMAGE GENERATION: OpenAI', collectorStart);
    assert.ok(collectorStart >= 0 && collectorEnd > collectorStart);
    // «Всегда отправлять» is ignored for NovelAI: only people named in the prompt are included.
    const settings = { apiType: 'novelai', npcReferences: [], autoDetectNames: true, sendCharAvatar: true, sendUserAvatar: true };
    const context = vm.createContext({
        getSettings: () => settings,
        SillyTavern: { getContext: () => ({ characters: [{ name: 'Hero' }], characterId: 0, name1: 'User' }) },
        collectCharacterProfileReferences: async (kind) => ({
            descriptions: [`${kind} library description`],
            appearance: `${kind} appearance tags`,
            refs: [{ data: 'LIBRARY_IMAGE', type: 'face' }],
            names: [],
            hasPrimary: true,
        }),
        namesAppearInPrompt: (names, prompt) => names.some(name => name && String(prompt).toLowerCase().includes(String(name).toLowerCase())),
        getNpcAliases: () => [], splitNameList: value => (Array.isArray(value) ? value : [value]).filter(Boolean),
        collectRpgCharacterReferences: async () => ({ descriptions: [], refs: [] }),
        getActiveWardrobeItem: (kind) => kind === 'char'
            ? { imageData: 'WARDROBE_IMAGE', description: 'green jacket', name: 'Jacket' }
            : null,
        getActiveHairstyleItem: () => null,
        detectMimeType: () => 'image/png',
        iigLog: () => {},
        MAX_IMAGE_REFS: 4,
    });
    vm.runInContext(source.slice(collectorStart, collectorEnd), context);
    const result = await context.collectReferenceImages('Hero in a forest');
    assert.equal(result.imageRefs.length, 0);
    assert.equal(result.textOnlyClothing.length, 1);
    assert.equal(result.textOnlyClothing[0].description, 'green jacket');
    // Appearance travels per person (for separate character prompts), not as a generic directive.
    assert.deepEqual(Array.from(result.people, p => `${p.name}: ${p.appearance}`), ['Hero: char appearance tags']);
    assert.doesNotMatch(result.textDirectives.join(' '), /library description/);
    settings.apiType = 'novelai-direct';
    const custom = await context.collectReferenceImages('Hero in a forest');
    assert.equal(custom.imageRefs.length, 0);
    assert.deepEqual(Array.from(custom.people, p => p.name), ['Hero']);
});
test('"|" prompts become separate NovelAI character prompts with each person\'s own tags', async () => {
    const { generate, requests } = setup({ ok: false, status: 500, text: async () => '' }, { apiType: 'novelai-direct', novelaiApiKey: 'tok' });
    await assert.rejects(generate.call(null, '2girls, cafe | Marta, laughing | Eveline, reading', 'gouache', {
        people: [
            { name: 'Eveline', names: ['Eveline'], appearance: 'pink hair, freckles' },
            { name: 'Marta', names: ['Marta'], appearance: 'black bob' },
        ],
        textOnlyClothing: [{ charName: 'Eveline', description: 'lace gloves' }],
        textDirectives: [],
    }));
    const body = JSON.parse(requests[0].init.body);
    const chars = body.parameters.v4_prompt.caption.char_captions.map(c => c.char_caption);
    assert.deepEqual(chars, ['Marta, laughing, black bob', 'Eveline, reading, pink hair, freckles, lace gloves']);
    assert.equal(body.parameters.characterPrompts.length, 2);
    assert.equal(body.parameters.v4_negative_prompt.caption.char_captions.length, 2);
    assert.equal(body.input, 'gouache, 2girls, cafe');
    assert.doesNotMatch(body.input, /pink hair|black bob|\|/);
});

test('SillyTavern route has no character prompts: tags follow their own segment in one string', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pZHjTQAAAAASUVORK5CYII=';
    const { generate, requests } = setup({ ok: true, text: async () => png });
    await generate('2girls | Marta | Eveline', '', {
        people: [{ name: 'Eveline', names: ['Eveline'], appearance: 'pink hair' }, { name: 'Marta', names: ['Marta'], appearance: 'black bob' }],
    });
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.prompt, '2girls, Marta, black bob, Eveline, pink hair');
});

test('without "|" every person in the scene still gets an own character prompt with outfit and hairstyle', async () => {
    const { generate, requests } = setup({ ok: false, status: 500, text: async () => '' }, { apiType: 'novelai-direct', novelaiApiKey: 'tok' });
    await assert.rejects(generate.call(null, '2girls, Eveline and Marta in a sewing room', '', {
        people: [
            { name: 'Eveline', names: ['Eveline'], appearance: 'pink hair' },
            { name: 'Marta', names: ['Marta'], appearance: 'red hair, freckles' },
        ],
        textOnlyClothing: [{ charName: 'Eveline', description: 'grey dress, lace gloves' }],
        personTags: [{ charName: 'Marta', description: 'braided bun' }, { charName: 'Marta', description: 'brown work dress, white apron' }],
        textDirectives: [],
    }));
    const body = JSON.parse(requests[0].init.body);
    const chars = body.parameters.v4_prompt.caption.char_captions.map(c => c.char_caption);
    assert.deepEqual(chars, ['Eveline, pink hair, grey dress, lace gloves', 'Marta, red hair, freckles, braided bun, brown work dress, white apron']);
    assert.equal(body.input, '2girls, Eveline and Marta in a sewing room');
});

test('a hairstyle or NPC outfit goes into its owner\'s "|" part, not the scene', async () => {
    const { generate, requests } = setup({ ok: false, status: 500, text: async () => '' }, { apiType: 'novelai-direct', novelaiApiKey: 'tok' });
    await assert.rejects(generate.call(null, 'workroom | Marta, smiling | Eveline, frozen', '', {
        people: [{ name: 'Eveline', names: ['Eveline'], appearance: '' }, { name: 'Marta', names: ['Marta'], appearance: '' }],
        personTags: [{ charName: 'Eveline', description: 'messy bob' }, { charName: 'Marta', description: 'apron' }],
        textDirectives: [],
    }));
    const body = JSON.parse(requests[0].init.body);
    const chars = body.parameters.v4_prompt.caption.char_captions.map(c => c.char_caption);
    assert.deepEqual(chars, ['Marta, smiling, apron', 'Eveline, frozen, messy bob']);
    assert.equal(body.input, 'workroom');
});

