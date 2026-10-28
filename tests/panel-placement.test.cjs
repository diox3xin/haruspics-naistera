const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function grab(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.slice(start).search(/\r?\n\}\r?\n/);
    return source.slice(start, start + end + source.slice(start + end).indexOf('}') + 1);
}

// A tiny DOM: just what placePromptPanel needs.
class El {
    constructor(tagName, text = '', className = '') {
        this.tagName = tagName;
        this.ownText = text;
        this.children = [];
        this.parentElement = null;
        const classes = new Set(className.split(' ').filter(Boolean));
        this.classList = { contains: name => classes.has(name) };
    }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get previousElementSibling() {
        const siblings = this.parentElement?.children || [];
        const index = siblings.indexOf(this);
        return index > 0 ? siblings[index - 1] : null;
    }
    detach() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
    appendChild(child) { child.detach(); child.parentElement = this; this.children.push(child); return child; }
    after(node) { node.detach(); const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this) + 1, 0, node); node.parentElement = this.parentElement; }
    querySelector(selector) { return selector === '.mes_text' ? this.children.find(child => child.classList.contains('mes_text')) || null : null; }
    remove() { this.detach(); }
}

let streaming = null;
const context = vm.createContext({
    getSettings: () => ({ promptPanelPosition: 'middle', imageDisplayMode: 'inline' }),
    normalizeImageDisplayMode: mode => mode,
    SillyTavern: { getContext: () => ({ streamingProcessor: streaming }) },
});
vm.runInContext(`${grab('isMessageStreaming')}\n${grab('placePromptPanel')}\n${grab('promptPanelBlocks')}`, context);

function message(paragraphs, wrap = false) {
    const mes = new El('DIV', '', 'mes');
    const text = mes.appendChild(new El('DIV', '', 'mes_text'));
    const host = wrap ? text.appendChild(new El('DIV')) : text;
    for (const p of paragraphs) host.appendChild(new El(p === '<hr>' ? 'HR' : 'P', p === '<hr>' ? '' : p));
    return { mes, text, host };
}

const panel = () => new El('DIV', '', 'iig-prompt-panel iig-pp');
const position = (host, block) => host.children.indexOf(block);

test('the block goes after the paragraph where the middle of the text is, not after the first one', () => {
    const { mes, host } = message(['Short.', 'x'.repeat(50), 'y'.repeat(300), 'z'.repeat(300), 'End.']);
    const p = panel();
    const entry = { anchor: null };
    context.placePromptPanel(mes, p, entry);
    // text middle ≈ 350 chars → inside the 3rd paragraph → block after it
    assert.equal(position(host, p), 3);
});

test('the chosen spot is kept when the text is re-rendered', () => {
    const { mes, host } = message(['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100), 'd'.repeat(100)]);
    const p = panel();
    const entry = { anchor: null };
    context.placePromptPanel(mes, p, entry);
    const before = position(host, p);
    p.remove();
    context.placePromptPanel(mes, p, entry);
    assert.equal(position(host, p), before);
    assert.ok(before > 0 && before < host.children.length - 1, 'in the middle, not at the edges');
});

test('never after the last paragraph and never right after a line', () => {
    const { mes, host } = message(['a'.repeat(20), '<hr>', 'b'.repeat(900)]);
    const p = panel();
    context.placePromptPanel(mes, p, { anchor: null });
    assert.equal(host.children[position(host, p) - 1].ownText, 'a'.repeat(20));
});

test('paragraphs inside one wrapper div are used', () => {
    const { mes, host } = message(['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)], true);
    const p = panel();
    context.placePromptPanel(mes, p, { anchor: null });
    assert.equal(p.parentElement, host);
    assert.equal(position(host, p), 2);
});

test('a reply that is still streaming counts as streaming only for its own message', () => {
    streaming = { messageId: 5, isFinished: false };
    assert.equal(context.isMessageStreaming(5), true);
    assert.equal(context.isMessageStreaming(4), false);
    streaming.isFinished = true;
    assert.equal(context.isMessageStreaming(5), false);
    streaming = null;
    assert.equal(context.isMessageStreaming(5), false);
});

test('the block is not inserted while the reply streams', () => {
    const ensure = source.slice(source.indexOf('function ensurePromptPanelForMessage('), source.indexOf('function placePromptPanel('));
    assert.match(ensure, /if \(isMessageStreaming\(messageId\)\)/);
    assert.match(source, /!entry\.mesEl\.contains\(entry\.panel\) && !isMessageStreaming\(messageId\)/);
});
