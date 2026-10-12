const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from);
    return source.slice(from, to);
}
const browser = [process.env.IIG_TEST_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(candidate => candidate && fs.existsSync(candidate));

test('real browser: sanitized/rerendered images, cloned buttons and single regeneration', { skip: !browser }, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'haruspics-regen-'));
    const script = `
        const processingMessages = new Set();
        const activeAbortControllers = new Map();
        const notices = [];
        const toastr = Object.fromEntries(['info', 'success', 'error', 'warning'].map(key => [key, text => notices.push(text)]));
        const iigLog = () => {};
        const getSettings = () => ({});
        const buildEffectiveStyle = style => style;
        const collectReferenceImages = async () => ({});
        let fail = false, calls = 0, saves = 0;
        const generateImageWithRetry = async prompt => { calls++; if (fail) throw new Error('test failure'); return prompt; };
        const saveImageToFile = async () => '/images/new-' + calls + '.png';
        const context = { chat: [], saveChat: async () => { saves++; } };
        const SillyTavern = { getContext: () => context };
        ${section('function escapeHtml(', '// SETTINGS')}
        ${section('const ERROR_IMAGE_PATH', '// DOM HELPERS')}
        ${section('function createLoadingPlaceholder(', '// MESSAGE PROCESSING')}
        ${section('async function regenerateSingleImage(', '// MESSAGE REGENERATION (ALL IMAGES)')}
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const pause = () => new Promise(resolve => setTimeout(resolve, 150));
        (async () => {
            const message = document.querySelector('.mes');
            const text = message.querySelector('.mes_text');
            const original = buildGeneratedImageTag({ prompt: 'first', style: 'anime' }, '/images/first.png') +
                buildGeneratedImageTag({ prompt: 'second', style: 'anime' }, '/images/second.png');
            context.chat[0] = { mes: original };
            // Model sanitization: no data-iig-instruction or generated-image classes remain.
            const sanitized = '<img src="/images/unrelated.png"><img src="/images/first.png"><img src="/images/second.png">';
            text.innerHTML = sanitized;
            observeImageRegenButtons();
            await restoreImageRegenButtons(message, 0);
            check(text.querySelectorAll('.iig-image-regen').length === 2, 'buttons missing after sanitization');
            check(!text.querySelector('img').closest('.iig-image-wrapper'), 'unrelated image wrapped');
            await restoreImageRegenButtons(message, 0);
            check(text.querySelectorAll('.iig-image-wrapper').length === 2, 'duplicate wrappers');

            // ST/another extension replaces message HTML after the render event.
            text.innerHTML = sanitized;
            await pause();
            check(text.querySelectorAll('.iig-image-regen').length === 2, 'observer did not restore buttons');

            // A DOM clone has no direct click listeners. Delegated capture must still work.
            const old = text.querySelectorAll('.iig-image-regen')[1];
            const clone = old.cloneNode(true);
            old.replaceWith(clone);
            clone.click();
            await pause();
            check(calls === 1 && saves === 1, 'click did not generate exactly once');
            check(context.chat[0].mes.includes('/images/new-1.png'), 'new image not saved');
            check(context.chat[0].mes.includes('/images/first.png'), 'wrong image replaced');
            check(text.querySelector('img[src="/images/new-1.png"]'), 'new image not rendered');
            check(!processingMessages.size && !activeAbortControllers.size, 'generation lock leaked');

            fail = true;
            text.querySelectorAll('.iig-image-regen')[1].click();
            await pause();
            check(calls === 2 && saves === 1, 'failed generation saved changes');
            check(text.querySelector('img[src="/images/new-1.png"]'), 'failure removed previous image');
            check(!processingMessages.size && !activeAbortControllers.size, 'failure lock leaked');

            processingMessages.add(0);
            text.querySelectorAll('.iig-image-regen')[1].click();
            await pause();
            check(calls === 2 && notices.some(text => text.includes('уже идёт')), 'busy click silently ignored');
            processingMessages.clear();
            document.getElementById('result').textContent = 'PASS';
        })().catch(error => { document.getElementById('result').textContent = 'FAIL: ' + error.stack; });
    `;
    const html = '<!doctype html><meta charset="utf-8"><base href="http://localhost:1/">' +
        '<div id="chat"><div class="mes" mesid="0"><div class="mes_text"></div></div></div>' +
        '<pre id="result">PENDING</pre><script>' + script.replace(/<\/script/gi, '<\\/script') + '</script>';
    try {
        const file = path.join(directory, 'test.html');
        fs.writeFileSync(file, html);
        const output = execFileSync(browser, [
            '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
            '--disable-background-networking', '--disable-extensions',
            '--user-data-dir=' + path.join(directory, 'profile'),
            '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(file).href,
        ], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        const result = output.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
        assert.equal(result, 'PASS', result || output.slice(0, 1000));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});