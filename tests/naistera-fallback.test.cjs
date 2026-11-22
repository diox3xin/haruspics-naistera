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
let calls;
let answers;
const toasts = [];
const context = vm.createContext({
    getSettings: () => settings,
    iigLog: () => {},
    toastr: { info: () => {}, warning: text => toasts.push(text) },
    RANDOM_ASPECT_RATIO: 'random',
    fetchNaisteraModels: async () => {},
    fetch: async (url, init = {}) => {
        calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
        const [status, body] = answers.shift();
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
    },
});
vm.runInContext([
    'const naisteraModelCatalog = new Map([["nano-banana-2-lite", { id: "nano-banana-2-lite", references: true, negativePrompt: false }], ["novelai-v5", { id: "novelai-v5", references: false, negativePrompt: true }]]);',
    grab('normalizeNaisteraEndpoint'), grab('normalizeNaisteraModel'), grab('getNaisteraModelInfo'), grab('isNaisteraNovelAIModel'),
    grab('normalizeNaisteraCharacterDescriptionsMode'), grab('formatNaisteraDescription'), grab('normalizeReturnedImage'), grab('extractNaisteraDataUrl'),
    grabConst('NAISTERA_ASPECT_RATIOS'), grab('nearestAspectRatio'), grab('describeNaisteraRequest'),
    grab('isModelSafeImageBase64'), grab('normalizeReferenceImages', 'async function'),
    'globalThis.reencodeImageAsJpeg = async () => null;',
    'const naisteraNoRefModels = new Set(); globalThis.naisteraNoRefModels = naisteraNoRefModels;',
    grab('generateImageNaistera', 'async function'),
].join('\n'), context);

const ok = () => [200, { data_url: `data:image/png;base64,${PNG}` }];
const fail503 = () => [503, { error: true, status_code: 503, detail: 'Произошла неизвестная ошибка. Попробуйте повторить запрос позже.' }];
const refs = [
    { type: 'face', name: 'Hero', data: PNG, mimeType: 'image/png' },
    { type: 'clothing', name: 'Hero', outfitName: 'Shirt', description: 'white striped shirt', data: PNG, mimeType: 'image/png' },
];
function reset(extra = {}) {
    settings = { endpoint: 'https://naistera.org/api/generate', apiKey: 'k', naisteraModel: 'nano-banana-2-lite', naisteraAspectRatio: '1:1', naisteraCharacterDescriptionsMode: 'as-is', negativeGalleryItems: [], ...extra };
    calls = [];
    toasts.length = 0;
    context.naisteraNoRefModels.clear();
}

test('only the formats Naistera takes are sent', () => {
    const near = r => context.nearestAspectRatio(r, context.NAISTERA_ASPECT_RATIOS ?? vm.runInContext('NAISTERA_ASPECT_RATIOS', context));
    assert.equal(near('4:5'), '3:4');
    assert.equal(near('5:4'), '4:3');
    assert.equal(near('21:9'), '16:9');
    assert.equal(near('2:3'), '2:3');
    assert.equal(near('random'), '1:1');
});

test('an old 21:9 setting goes out as 16:9 instead of a 400', async () => {
    reset({ naisteraAspectRatio: '21:9' });
    answers = [ok()];
    await context.generateImageNaistera('a cat', '', {}, {});
    assert.equal(calls[0].url, 'https://naistera.org/api/generate');
    assert.equal(calls[0].body.aspect_ratio, '16:9');
});

test('503 with references: one try without them; success → remembered, descriptions go as text', async () => {
    reset();
    answers = [fail503(), ok()];
    const image = await context.generateImageNaistera('Hero in a park', '', { imageRefs: refs, textDirectives: [], textOnlyClothing: [] }, {});
    assert.match(image, /^data:image\/png;base64,/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.reference_objects.length, 2);
    assert.equal(calls[1].body.reference_objects, undefined);
    assert.match(calls[1].body.prompt, /\[CLOTHING for Hero: white striped shirt\]/);
    assert.match(toasts[0], /С картинками-референсами Naistera вернула 503/);

    answers = [ok()];
    await context.generateImageNaistera('Hero again', '', { imageRefs: refs, textDirectives: [], textOnlyClothing: [] }, {});
    assert.equal(calls[2].body.reference_objects, undefined, 'no second failing request with refs');
    assert.match(calls[2].body.prompt, /white striped shirt/);
    assert.equal(toasts.length, 1, 'warned once');
});

test('503 that also fails without references: error shown, references not switched off', async () => {
    reset();
    answers = [fail503(), fail503()];
    await assert.rejects(context.generateImageNaistera('x', '', { imageRefs: refs }, {}), error =>
        /Naistera API error \(503\)/.test(error.message) && /model nano-banana-2-lite \| format 1:1 \| prompt \d+ chars \| no refs/.test(error.message));
    assert.equal(context.naisteraNoRefModels.size, 0);
    assert.equal(toasts.length, 0);
});

test('503 without references is passed on as before (the retry loop handles it)', async () => {
    reset();
    answers = [fail503()];
    await assert.rejects(context.generateImageNaistera('x', '', {}, {}), /Naistera API error \(503\)/);
    assert.equal(calls.length, 1);
});

test('description mode «none» adds no descriptions when references are dropped', async () => {
    reset({ naisteraCharacterDescriptionsMode: 'none' });
    answers = [fail503(), ok()];
    await context.generateImageNaistera('Hero', '', { imageRefs: refs }, {});
    assert.doesNotMatch(calls[1].body.prompt, /white striped shirt/);
});

test('the error says what was sent (formats and sizes, never the pictures)', async () => {
    reset({ naisteraPreset: 'realism' });
    const JPG = '/9j/' + 'B'.repeat(4000);
    answers = [[500, { error: true, status_code: 500, detail: 'boom' }]];
    await assert.rejects(context.generateImageNaistera('x', '', { imageRefs: [{ type: 'clothing', name: 'Hero', data: JPG, mimeType: 'image/jpeg', description: 'a\n\n  b' }] }, {}), error => {
        assert.match(error.message, /refs 1: jpeg 3KB/);
        assert.match(error.message, /preset realism/);
        assert.doesNotMatch(error.message, /BBBB/);
        return true;
    });
    assert.equal(calls[0].body.reference_objects[0].description, 'a b', 'one line, like sillyimages');
});

test('references in formats image models do not take are converted; non-pictures are dropped', async () => {
    const AVIF = 'AAAAIGZ0eXBhdmlm' + 'C'.repeat(200);
    const HTML = 'PCFET0NUWVBFIGh0bWw+' + 'D'.repeat(50);
    const GIF = 'R0lGODlh' + 'E'.repeat(100);
    vm.runInContext(`reencodeImageAsJpeg = async data => data.startsWith('PCFET0') ? null : '/9j/converted-' + data.slice(0, 4);`, context);
    const out = await context.normalizeReferenceImages({
        imageRefs: [
            { type: 'face', name: 'Hero', data: PNG, mimeType: 'image/png' },
            { type: 'clothing', name: 'Hero', outfitName: 'Coat', data: AVIF, mimeType: 'image/png' },
            { type: 'face', name: 'User', data: HTML, mimeType: 'image/png' },
            { type: 'hairstyle', name: 'Hero', data: GIF, mimeType: 'image/gif' },
        ],
        warnings: ['old'],
    });
    assert.deepEqual(Array.from(out.imageRefs, ref => ref.name + ':' + ref.mimeType), ['Hero:image/png', 'Hero:image/jpeg', 'Hero:image/jpeg']);
    assert.equal(out.imageRefs[0].data, PNG, 'PNG / JPEG / WebP are sent byte for byte');
    assert.match(out.imageRefs[1].data, /^\/9j\/converted-AAAA/);
    assert.equal(out.warnings.length, 2);
    assert.match(out.warnings[1], /User не открывается как картинка/);

    const same = { imageRefs: [{ data: PNG }], warnings: [] };
    assert.equal(await context.normalizeReferenceImages(same), same, 'nothing to do → the same object');
});

test('a missing avatar (404 page) is not turned into a picture', async () => {
    const ctx = vm.createContext({
        iigLog: () => {}, console,
        fetch: async url => url.includes('missing')
            ? { ok: false, status: 404, blob: async () => ({ type: 'text/html' }) }
            : { ok: true, status: 200, blob: async () => ({ type: 'text/html' }) },
        FileReader: class { readAsDataURL() { this.result = 'data:text/html;base64,PGh0bWw+'; this.onloadend(); } },
    });
    vm.runInContext(grab('imageUrlToBase64', 'async function'), ctx);
    assert.equal(await ctx.imageUrlToBase64('/characters/missing.png'), null);
    assert.equal(await ctx.imageUrlToBase64('/characters/page.png'), null, 'an HTML answer with 200 is not a picture either');
});

test('every picture request passes through the format check', () => {
    const start = source.indexOf('async function generateImageWithRetry(');
    const head = source.slice(start, source.indexOf('// Show warnings from ref collection', start));
    assert.match(head, /refData = await normalizeReferenceImages\(refData\);/);
    const refgen = source.slice(source.indexOf('async function generateReferenceImage('), source.indexOf('async function generateReferenceImage(') + 800);
    assert.match(refgen, /normalizeReferenceImages\(\{ imageRefs: buildRefGenImageRefs\(state\)/);
});
