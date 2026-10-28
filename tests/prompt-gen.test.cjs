const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function grab(name, prefix = 'function') {
    const start = source.indexOf(`${prefix} ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    // Top-level functions end with a "}" alone on its line.
    const end = source.slice(start).search(/\r?\n\}\r?\n/);
    assert.ok(end > 0, `unterminated ${name}`);
    return source.slice(start, start + end + source.slice(start + end).indexOf('}') + 1);
}

function grabConst(name) {
    const start = source.indexOf(`const ${name} =`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.indexOf('\n', source.indexOf(');', start));
    return source.slice(start, end);
}

const chat = [
    { is_user: true, mes: 'Пойдём в бар?' },
    { name: 'Novak', mes: 'Novak smiles and opens the door.' },
    { is_user: true, mes: 'Я захожу следом.' },
    { name: 'Novak', mes: 'The bar is dark and loud. Novak orders two drinks.' },
];
const settings = { apiType: 'novelai', naisteraModel: '' };
let fixedAppearances = [];
const context = vm.createContext({
    SillyTavern: { getContext: () => ({ chat, characters: [{ name: 'Novak' }], characterId: 0, name1: 'Eva' }) },
    getExtensionPersona: () => ({ name: 'Eva', description: '' }),
    getExtensionCharacter: () => null,
    getSettings: () => settings,
    iigLog: () => {},
    checkFileExists: async () => true,
    getFixedAppearances: () => fixedAppearances,
});
vm.runInContext([
    grabConst('NOVELAI_API_TYPES'),
    grabConst('PROMPT_GEN_SYSTEM'),
    grab('decodeNumericEntities'),
    grab('normalizeNaisteraModel'),
    grab('isNaisteraNovelAIModel'),
    grab('isNovelAIPromptTarget'),
    grab('getPromptGenerationContext'),
    grab('parseImageTags', 'async function'),
    grab('cleanGeneratedImagePrompt', 'async function'),
    'globalThis.ctx = getPromptGenerationContext; globalThis.clean = cleanGeneratedImagePrompt; globalThis.SYSTEM = PROMPT_GEN_SYSTEM;',
].join('\n'), context);

test('the request says not to continue the roleplay and keeps the message apart from the history', () => {
    const text = context.ctx(chat[3], { prompt: 'COMIC MODE - every reply outputs a story and one image tag.' }, settings);
    assert.match(context.SYSTEM, /NOT a roleplay participant/);
    assert.match(text, /<message_to_illustrate>\nThe bar is dark and loud/);
    assert.match(text, /<chat_history>[\s\S]*Я захожу следом\.\n<\/chat_history>/);
    assert.doesNotMatch(text.split('<message_to_illustrate>')[0], /The bar is dark/);
    assert.match(text, /<prompt_instruction>\nCOMIC MODE/);
    assert.match(text, /Do not continue the roleplay/);
});

test('NovelAI gets a tag hint, other APIs do not', () => {
    assert.match(context.ctx(chat[3], { prompt: 'x' }, { apiType: 'novelai-direct' }), /Target image model: NovelAI/);
    assert.match(context.ctx(chat[3], { prompt: 'x' }, { apiType: 'naistera', naisteraModel: 'novelai-v4' }), /NovelAI/);
    assert.doesNotMatch(context.ctx(chat[3], { prompt: 'x' }, { apiType: 'openai' }), /NovelAI/);
});

test('a whole bot reply with an image tag is reduced to the prompt inside the tag', async () => {
    const reply = '<rp_plan>scene beats</rp_plan>\n[21:40]\nNovak leans closer.\n\n'
        + '<img data-iig-instruction=\'{"style":"","prompt":"comic page, bar, night | 1boy, Novak, smirk | 1girl, Eva, pink hair","aspect_ratio":"2:3","image_size":"1K"}\' src="[IMG:GEN]">\n\nInfoblock: mood…';
    const result = await context.clean(reply);
    assert.equal(result.prompt, 'comic page, bar, night | 1boy, Novak, smirk | 1girl, Eva, pink hair');
    assert.equal(result.fromTag, true);
});

test('a plain answer loses reasoning, code fences and the "Prompt:" label', async () => {
    const result = await context.clean('<think>let me see</think>\n```\nPrompt: 1girl, bar, night, neon\n```');
    assert.equal(result.prompt, '1girl, bar, night, neon');
    assert.equal(result.fromTag, false);
});

test('profile appearances are given to the prompt model as fixed, with an order not to invent a new look', () => {
    fixedAppearances = [{ name: 'Novak', appearance: 'short hair, blonde hair, scar on face' }, { name: 'Eva', appearance: 'pink hair, freckles' }];
    const text = context.ctx(chat[3], { prompt: 'x' }, settings);
    assert.match(text, /<fixed_appearance>\nNovak: short hair, blonde hair, scar on face\nEva: pink hair, freckles\n<\/fixed_appearance>/);
    assert.match(text, /Do NOT describe or change their hair, eyes, skin, face or body/);
    fixedAppearances = [];
    assert.doesNotMatch(context.ctx(chat[3], { prompt: 'x' }, settings), /fixed_appearance/);
});

