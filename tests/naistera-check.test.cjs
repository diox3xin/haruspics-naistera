const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
function grab(name, prefix = 'function') {
    const start = source.indexOf(`${prefix} ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.slice(start).search(/\r?\n\}\r?\n/);
    return source.slice(start, start + end + source.slice(start + end).indexOf('}') + 1);
}
function grabConst(name) {
    const start = source.indexOf(`const ${name} =`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.slice(start).search(/;\r?\n/);
    return source.slice(start, start + end + 1);
}

const PNG = 'iVBORw0KGgo' + 'A'.repeat(300);
let settings;
let sent;
let judge; // body → [status, json]
const context = vm.createContext({
    getSettings: () => settings,
    iigLog: () => {},
    toastr: { info() {}, warning() {} },
    RANDOM_ASPECT_RATIO: 'random',
    fetchNaisteraModels: async () => {},
    fetch: async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        sent.push({ url, body });
        const [status, json] = judge(body);
        const text = JSON.stringify(json);
        return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
    },
});
vm.runInContext([
    'const naisteraModelCatalog = new Map([["nano-banana-2-lite", { id: "nano-banana-2-lite", references: true, negativePrompt: false }]]);',
    grab('normalizeNaisteraEndpoint'), grab('normalizeNaisteraModel'), grab('getNaisteraModelInfo'), grab('isNaisteraNovelAIModel'),
    grab('normalizeNaisteraCharacterDescriptionsMode'), grab('formatNaisteraDescription'), grab('normalizeReturnedImage'), grab('extractNaisteraDataUrl'),
    grab('pollNaisteraJob', 'async function'), grab('naisteraAbortError'),
    grabConst('NAISTERA_ASPECT_RATIOS'), grabConst('NAISTERA_PRESETS'), grabConst('NAISTERA_TEST_PROMPT'), grab('nearestAspectRatio'), grab('describeNaisteraRequest'),
    'let lastNaisteraFailure = null; const naisteraNoRefModels = new Set();',
    'globalThis.getLast = () => lastNaisteraFailure; globalThis.setLast = v => { lastNaisteraFailure = v; };',
    grab('naisteraProbe', 'async function'), grab('runNaisteraDiagnostics', 'async function'),
    grab('generateImageNaistera', 'async function'),
].join('\n'), context);

const OK = [200, { data_url: `data:image/png;base64,${PNG}` }];
const E503 = [503, { error: true, status_code: 503, detail: 'Произошла неизвестная ошибка. Попробуйте повторить запрос позже.' }];
function reset(extra = {}) {
    settings = { endpoint: 'https://naistera.org', apiKey: 'tok', naisteraModel: 'nano-banana-2-lite', naisteraAspectRatio: '3:4', naisteraCharacterDescriptionsMode: 'as-is', negativeGalleryItems: [], ...extra };
    sent = [];
    context.setLast(null);
}
const failed = { scene: 'Hero walks in a park', prompt: '[CHARACTER "Hero" APPEARANCE]: tall\n\nHero walks in a park', aspect_ratio: '3:4', model: 'nano-banana-2-lite' };

test('a failed generation is remembered (text only) for the check', async () => {
    reset();
    judge = () => E503;
    await assert.rejects(context.generateImageNaistera('Hero walks in a park', '', { textDirectives: ['[CHARACTER "Hero" APPEARANCE]: tall'] }, {}));
    const last = context.getLast();
    assert.equal(last.scene, 'Hero walks in a park');
    assert.match(last.prompt, /APPEARANCE\]: tall\n\nHero walks in a park$/);
    assert.equal(last.aspect_ratio, '3:4');
    assert.equal(last.status, 503);
});

test('the plain test prompt fails → model / token / server, not the extension', async () => {
    reset();
    context.setLast(failed);
    judge = () => E503;
    const { verdict, lines } = await context.runNaisteraDiagnostics();
    assert.equal(verdict, 'model-or-server');
    assert.equal(sent.length, 1, 'stops at the first step');
    assert.equal(sent[0].body.prompt, vm.runInContext('NAISTERA_TEST_PROMPT', context));
    assert.equal(sent[0].body.aspect_ratio, '1:1');
    assert.match(lines.at(-1).text, /Текст и настройки расширения тут ни при чём/);
});

test('the same prompt works in 1:1 → the format', async () => {
    reset();
    context.setLast(failed);
    judge = body => body.aspect_ratio === '1:1' ? OK : E503;
    const { verdict } = await context.runNaisteraDiagnostics();
    assert.equal(verdict, 'format');
    assert.deepEqual(sent.map(s => s.body.aspect_ratio), ['1:1', '1:1']);
    assert.equal(sent[1].body.prompt, failed.prompt);
});

test('only the scene works → character descriptions / style', async () => {
    reset();
    context.setLast(failed);
    judge = body => body.prompt.includes('APPEARANCE') ? E503 : OK;
    const { verdict } = await context.runNaisteraDiagnostics();
    assert.equal(verdict, 'descriptions');
    assert.deepEqual(sent.map(s => [s.body.prompt.slice(0, 12), s.body.aspect_ratio]), [['A red apple ', '1:1'], ['[CHARACTER "', '1:1'], ['Hero walks i', '3:4']]);
});

test('even the scene fails → its content', async () => {
    reset();
    context.setLast(failed);
    judge = body => body.prompt.includes('Hero') ? E503 : OK;
    const { verdict } = await context.runNaisteraDiagnostics();
    assert.equal(verdict, 'scene');
    assert.equal(sent.length, 3);
});

test('nothing failed yet → only the plain test', async () => {
    reset();
    judge = () => OK;
    const { verdict } = await context.runNaisteraDiagnostics();
    assert.equal(verdict, 'plain-ok');
    assert.equal(sent.length, 1);
});

test('only digital / realism are sent as preset', async () => {
    reset({ naisteraPreset: 'Realism' });
    judge = () => OK;
    await context.generateImageNaistera('x', '', {}, {});
    assert.equal(sent[0].body.preset, 'realism');
    reset({ naisteraPreset: 'anime' });
    await context.generateImageNaistera('x', '', {}, {});
    assert.equal(sent[0].body.preset, undefined);
});
