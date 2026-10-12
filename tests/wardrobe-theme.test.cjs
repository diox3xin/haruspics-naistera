const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('const WARDROBE_THEME_DEFAULTS');
const end = source.indexOf('function getSettings()', start);
assert.ok(start >= 0 && end > start, 'wardrobe theme helpers must exist');

function setup(settingsTheme) {
    const props = {};
    const context = vm.createContext({
        getSettings: () => ({ wardrobeTheme: settingsTheme }),
        document: { documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } } },
    });
    vm.runInContext(`${source.slice(start, end)}\nthis.normalizeWardrobeTheme = normalizeWardrobeTheme; this.applyWardrobeTheme = applyWardrobeTheme; this.WARDROBE_THEME_DEFAULTS = WARDROBE_THEME_DEFAULTS;`, context);
    return { context, props };
}

test('normalize keeps valid hex, expands short hex, lowercases', () => {
    const { context } = setup();
    const result = context.normalizeWardrobeTheme({ bgColor: '#ABCDEF', textColor: '#fff', accentColor: '#123456', borderColor: '#000000' });
    assert.deepEqual({ ...result }, { bgColor: '#abcdef', textColor: '#ffffff', accentColor: '#123456', borderColor: '#000000' });
});

test('normalize replaces invalid or missing values with defaults', () => {
    const { context } = setup();
    const result = context.normalizeWardrobeTheme({ bgColor: 'rgba(0,0,0,1)', textColor: 'red', accentColor: '#12345' });
    assert.deepEqual({ ...result }, { ...context.WARDROBE_THEME_DEFAULTS });
    assert.deepEqual({ ...context.normalizeWardrobeTheme(null) }, { ...context.WARDROBE_THEME_DEFAULTS });
});

test('apply writes CSS variables, sanitizing injected values', () => {
    const { context, props } = setup();
    context.applyWardrobeTheme({ bgColor: '#101010', textColor: 'red; background:url(x)', accentColor: '#ff0000', borderColor: '#202020' });
    assert.equal(props['--iig-wr-bg'], '#101010');
    assert.equal(props['--iig-wr-text'], context.WARDROBE_THEME_DEFAULTS.textColor);
    assert.equal(props['--iig-wr-accent'], '#ff0000');
    assert.equal(props['--iig-wr-border'], '#202020');
});
