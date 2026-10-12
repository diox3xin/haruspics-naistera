const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function setup(config = {}) {
    const settings = { apiType: 'openai', endpoint: 'https://api.openai.com', model: 'gpt-image-1', apiKey: 'test', ...config };
    const context = { extensionSettings: { inline_image_gen: settings }, characters: [{ name: 'Анна', avatar: 'anna.png' }], characterId: 0, name1: 'Юлия', saveSettingsDebounced() {}, chat: [], saveChat: async () => {} };
    const requests = [];
    const sandbox = vm.createContext({
        URL, structuredClone, console: { log() {}, warn() {}, error() {} }, queueMicrotask() {},
        SillyTavern: { getContext: () => context },
        fetch: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ data: [{ b64_json: 'PNG' }], choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,PNG' } }] } }] }) }; },
    });
    vm.runInContext(source, sandbox);
    sandbox.getSettings();
    return { sandbox, settings, context, requests };
}

test('exact aspect ratios are not replaced by orientation, per-image parameters win', () => {
    const { sandbox: s, settings } = setup({ imageDefaults: { quality: 'low', aspectRatio: '1:1' } });
    assert.throws(() => s.resolveImageOptions(settings, { aspectRatio: '16:9' }), /не поддерживает/);
    const result = s.resolveImageOptions(settings, { aspectRatio: '3:2', quality: 'high' });
    assert.equal(result.size, '1536x1024'); assert.equal(result.quality, 'high');
    assert.throws(() => s.resolveImageOptions(settings, { aspectRatio: '0:1' }), /больше нуля/);
});

test('OpenAI Images sends exact size and API quality', async () => {
    const { sandbox: s, requests } = setup();
    await s.generateImageOpenAI('forest', '', {}, { aspectRatio: '2:3', quality: 'high' });
    assert.equal(requests[0].body.size, '1024x1536');
    assert.equal(requests[0].body.quality, 'high');
});

test('Chat image_config is opt-in outside OpenRouter and uses per-image settings', async () => {
    for (const [endpoint, config, expected] of [
        ['https://openrouter.ai/api/v1', 'auto', true],
        ['https://example.com/v1', 'auto', false],
        ['https://example.com/v1', 'enabled', true],
        ['https://openrouter.ai/api/v1', 'disabled', false],
    ]) {
        const { sandbox: s, requests } = setup({ apiType: 'openai-chat', endpoint, chatImageConfig: config, model: 'google/gemini-3-pro-image-preview' });
        await s.generateImageOpenAIChat('forest', '', {}, { aspectRatio: '16:9', imageSize: '4K' });
        assert.equal(!!requests[0].body.image_config, expected);
        if (expected) assert.deepEqual(requests[0].body.image_config, { aspect_ratio: '16:9', image_size: '4K' });
        assert.match(requests[0].body.messages[0].content[0].text, /16:9/);
    }
});

test('unsupported resolution/quality are not sent; NovelAI pixels remain explicit', () => {
    const { sandbox: s } = setup();
    const gemini = s.resolveImageOptions({ apiType: 'gemini', model: 'gemini-2.5-flash-image', endpoint: 'https://generativelanguage.googleapis.com', imageSize: '4K' });
    assert.equal(gemini.imageSize, undefined);
    const nai = s.resolveImageOptions({ apiType: 'novelai', novelaiWidth: 832, novelaiHeight: 1216 }, { size: '1024x1024', quality: 'high' });
    assert.equal(nai.size, '1024x1024'); assert.equal(nai.quality, undefined);
    assert.throws(() => s.resolveImageOptions({ apiType: 'novelai' }, { size: '1000x1024' }), /кратны 64/);
});

test('transfer rules distinguish source tattoos from target tattoos', () => {
    const { sandbox: s } = setup();
    const text = s.buildTransferDirective({ ignore: ['tattoos', 'body', 'unknown'], preserve: ['tattoos', 'body'] }, 'Анна');
    assert.match(text, /Do not copy tattoos, body shape and proportions from the SOURCE/);
    assert.match(text, /does NOT remove these traits from the TARGET/);
    assert.match(text, /Preserve the TARGET character's tattoos, body shape/);
    assert.doesNotMatch(text, /unknown/);
});

test('migration is additive and stable, normalizing malformed transfer rules', () => {
    const legacy = { id: 'old', name: 'Coat', imageData: 'original', target: 'char', transferRules: { ignore: ['tattoos', 'tattoos', 'unknown'] } };
    const { sandbox: s, settings } = setup({ wardrobeItems: [legacy], npcReferences: [{ name: 'Аня', outfit: 'red dress' }] });
    s.getSettings(); s.getSettings();
    assert.equal(settings.wardrobeItems[0], legacy);
    assert.equal(legacy.imageData, 'original');
    assert.deepEqual(Array.from(legacy.transferRules.ignore), ['tattoos']);
    assert.equal(settings.npcReferences[0].outfits.length, 1);
    assert.equal(settings.npcReferences[0].outfit, 'red dress');
});

test('Cyrillic aliases match whole names; adapted outfits do not mutate original', () => {
    const { sandbox: s } = setup();
    assert.equal(s.nameAppearsInPrompt('Анна', 'Анна, у окна.'), true);
    assert.equal(s.nameAppearsInPrompt('Анна', 'Аннабель'), false);
    assert.equal(s.nameAppearsInPrompt('Ann', 'Joanna'), false);
    const outfit = { id: 'old', name: 'Coat', imageData: 'OLD', transferRules: { ignore: ['tattoos'] } };
    const copy = s.makeAdaptedOutfit(outfit, { id: 'npc:2', name: 'Анна', kind: 'npc' }, 'NEW', 'clothed');
    assert.notEqual(copy.id, outfit.id); assert.equal(copy.ownerId, 'npc:2');
    copy.transferRules.ignore.push('body');
    assert.equal(outfit.imageData, 'OLD'); assert.deepEqual(outfit.transferRules.ignore, ['tattoos']);
});

test('persona and bot appearance descriptions reach NovelAI without modifying chat', async () => {
    const { sandbox: s, settings, context } = setup({ apiType: 'novelai' });
    const people = s.getFusionPeople();
    people[0].primary.description = 'curvy body, red hair'; people[1].primary.description = 'short black hair';
    settings.characterLibraryEnabled = true;
    const result = await s.collectReferenceImages('Анна и Юлия');
    assert.match(result.textDirectives.join(' '), /curvy body, red hair/);
    assert.match(result.textDirectives.join(' '), /short black hair/);
    assert.equal(result.imageRefs.length, 0); assert.equal(context.chat.length, 0);
    assert.equal(s.getFusionPeople()[0].record, people[0].record);
});

test('message guard rejects swipe/chat changes, preserving foreign metadata', () => {
    const { sandbox: s, context } = setup();
    const message = { swipe_id: 0, extra: { extblocks: { untouched: true }, display_text: 'other extension' } };
    context.chat.push(message);
    const original = JSON.stringify(message.extra);
    s.assertFusionMessageCurrent(context.chat, 0, message, 0);
    message.swipe_id = 1;
    assert.throws(() => s.assertFusionMessageCurrent(context.chat, 0, message, 0), /свайп/);
    const oldChat = context.chat; context.chat = [];
    assert.throws(() => s.assertFusionMessageCurrent(oldChat, 0, message, 1), /чат/);
    assert.equal(JSON.stringify(message.extra), original);
});