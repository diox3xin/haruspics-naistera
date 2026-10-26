const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function grab(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}`);
}

const settings = {
    defaultStyle: '',
    activeStyleIds: ['nai'],
    styleGalleryItems: [
        { id: 'nai', name: 'Новелка', prompt: 'nai tags' },
        { id: 'gouache', name: 'Гуашь (milkpic_gouache)', prompt: 'STYLE: gouache' },
    ],
};
const context = vm.createContext({ getSettings: () => settings });
vm.runInContext(`${grab('resolveTagStyle')}\n${grab('buildEffectiveStyle')}\nglobalThis.build = buildEffectiveStyle;`, context);

test('a style key from the image tag expands to the matching gallery style', () => {
    settings.activeStyleIds = ['nai'];
    assert.equal(context.build('milkpic_gouache'), 'nai tags, STYLE: gouache');
});

test('an unknown tag style is passed through as written', () => {
    settings.activeStyleIds = ['nai'];
    assert.equal(context.build('watercolor'), 'nai tags, watercolor');
});

test('a style that is both switched on and named by the tag is added once', () => {
    settings.activeStyleIds = ['gouache'];
    assert.equal(context.build('milkpic_gouache'), 'STYLE: gouache');
});
