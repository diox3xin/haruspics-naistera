const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `missing ${start}`);
    return source.slice(from, to);
}

function collector(settings, { profileNames = { char: [], user: [] } } = {}) {
    const context = vm.createContext({
        getSettings: () => ({ apiType: 'gemini', autoDetectNames: true, sendCharAvatar: false, sendUserAvatar: false, ...settings }),
        SillyTavern: { getContext: () => ({ characters: [{ name: 'Иван Петров' }], characterId: 0, name1: 'Ева Гринёва' }) },
        getExtensionPersona: () => ({ name: 'Ева Гринёва', description: '' }),
        getExtensionCharacter: () => null,
        collectCharacterProfileReferences: async kind => ({
            descriptions: [`[${kind} appearance]`], names: profileNames[kind] || [],
            refs: [{ type: 'face', name: kind, data: `${kind.toUpperCase()}_FACE` }], hasPrimary: true,
        }),
        collectRpgCharacterReferences: async () => ({ descriptions: [], refs: [], outfits: [] }),
        getActiveWardrobeItem: kind => ({ name: `${kind} coat`, description: `${kind} coat text`, imageData: `${kind.toUpperCase()}_COAT` }),
        getActiveHairstyleItem: () => null,
        getActiveNpcOutfit: () => null,
        ensureNpcDefaults: () => {},
        detectMimeType: () => 'image/png', iigLog: () => {}, MAX_IMAGE_REFS: 4,
    });
    vm.runInContext(section('const NAME_IGNORED_WORDS', '// ============================================================\r\n// 4-SLOT') , context);
    vm.runInContext(section('async function collectReferenceImages(', '// IMAGE GENERATION: OpenAI'), context);
    return context.collectReferenceImages.bind(context);
}

const names = refs => Array.from(refs, ref => `${ref.type}:${ref.name}`);

test('only people mentioned in the prompt send their face, appearance and outfit', async () => {
    const collect = collector({});
    const result = await collect('Close-up of Ivan lighting a cigarette in the rain');
    assert.deepEqual(names(result.imageRefs), ['face:char', 'clothing:Иван Петров']);
    assert.match(result.textDirectives.join(' '), /\[char appearance\]/);
    assert.doesNotMatch(result.textDirectives.join(' '), /\[user appearance\]/);
});

test('«Всегда отправлять» still includes a person who is not mentioned', async () => {
    const result = await collector({ sendUserAvatar: true })('Close-up of Ivan');
    assert.deepEqual(names(result.imageRefs), ['face:char', 'face:user', 'clothing:Иван Петров', 'clothing:Ева Гринёва']);
});

test('profile names are used for detection', async () => {
    const collect = collector({}, { profileNames: { char: ['Vanya'], user: ['Evie'] } });
    const result = await collect('Vanya hands Evie a thermos');
    assert.deepEqual(names(result.imageRefs).slice(0, 2), ['face:char', 'face:user']);
});

test('NPCs are found by aliases and transliteration; disabled NPCs are skipped', async () => {
    const npcReferences = [
        { name: 'Орехов', aliases: ['Миша'], imageData: 'OREKHOV', enabled: true, appearance: 'red curls' },
        { name: 'Novak', aliases: [], imageData: 'NOVAK', enabled: false },
    ];
    const result = await collector({ npcReferences })('Orekhov and Novak stand over the body');
    assert.deepEqual(names(result.imageRefs), ['face:Орехов']);
    assert.match(result.textDirectives.join(' '), /red curls/);
});

test('NovelAI ignores «Всегда отправлять»: an unmentioned bot does not leak into the picture', async () => {
    const result = await collector({ apiType: 'novelai', sendCharAvatar: true, sendUserAvatar: true })('2girls, Marta and Eva at a cafe');
    assert.deepEqual(Array.from(result.people, p => p.name), ['Ева Гринёва']);
    assert.doesNotMatch(result.textDirectives.join(' '), /char appearance/);
});
