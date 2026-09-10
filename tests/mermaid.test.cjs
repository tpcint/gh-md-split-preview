const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(
  new URL('../github-md-split-preview.user.js', `file://${__filename}`),
  'utf8',
);
const start = source.indexOf('  // ── mermaid 다이어그램 ─ 시작');
const end = source.indexOf('  // ── mermaid 다이어그램 ─ 끝', start);
assert.notEqual(start, -1, 'mermaid helper start marker');
assert.notEqual(end, -1, 'mermaid helper end marker');

/** 이 섹션이 실제로 만지는 DOM API 만 흉내 낸 최소 노드. */
function el(tag, props = {}) {
  return {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    isConnected: true,
    parentElement: null,
    partOf: null, // closest 가 찾을 조상 클래스
    closest(selector) { return this.partOf === selector ? { selector } : null; },
    replaceWith(next) { this.replacedBy = next; this.isConnected = false; },
    before(node) { (this.inserted ||= []).push(node); },
    ...props,
  };
}

/** <pre><code class="language-mermaid">src</code></pre> 한 쌍을 만든다. */
function block(src, props = {}) {
  const pre = el('pre', props);
  const code = el('code', { textContent: src, parentElement: pre });
  pre.code = code;
  return pre;
}

const root = (pres) => ({ querySelectorAll: () => pres.map((p) => p.code) });

function load({ mermaid, removed = [] } = {}) {
  const created = [];
  const context = {
    console: { warn() {}, error() {} },
    document: {
      documentElement: { getAttribute: () => null },
      createElement(tag) { const node = el(tag); created.push(node); return node; },
      getElementById(id) { return { remove() { removed.push(id); } }; },
    },
    window: { mermaid, matchMedia: () => ({ matches: false }) },
  };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\nthis.helpers = {\n` +
      '  mermaidTargets, mermaidThemeName, mermaidErrorText, ensureMermaid, renderMermaid,\n' +
      '};',
    context,
  );
  return { ...context.helpers, created };
}

test('collects only unrendered whole mermaid blocks', () => {
  const { mermaidTargets } = load();
  const plain = block('flowchart TD\n A --> B');
  const done = block('flowchart TD\n A --> B', { dataset: { mdspMermaid: 'done' } });
  const partial = block('A --> B', { partOf: '.mdsp-code-part' });
  const blank = block('   \n  ');

  const targets = mermaidTargets(root([plain, done, partial, blank]));

  // vm 컨텍스트가 만든 배열이라 호스트 쪽으로 옮겨서 비교한다
  assert.deepEqual([...targets].map((t) => t.src), ['flowchart TD\n A --> B']);
  assert.equal(targets[0].pre, plain);
});

test('maps GitHub color mode to a mermaid theme', () => {
  const { mermaidThemeName } = load();
  const html = (attrs) => ({ getAttribute: (k) => attrs[k] ?? null });

  assert.equal(mermaidThemeName(html({ 'data-color-mode': 'light' }), true), 'default');
  assert.equal(mermaidThemeName(html({ 'data-color-mode': 'dark' }), false), 'dark');
  assert.equal(mermaidThemeName(html({ 'data-color-mode': 'auto' }), true), 'dark');
  assert.equal(mermaidThemeName(html({ 'data-color-mode': 'auto' }), false), 'default');
  // auto 는 실제로 적용될 테마 이름을 따라간다 (dark_dimmed 도 어두운 테마다)
  assert.equal(
    mermaidThemeName(html({ 'data-color-mode': 'auto', 'data-dark-theme': 'dark_dimmed' }), true),
    'dark',
  );
  assert.equal(
    mermaidThemeName(html({ 'data-color-mode': 'auto', 'data-light-theme': 'light_high_contrast' }), false),
    'default',
  );
  assert.equal(mermaidThemeName(null, false), 'default');
});

test('keeps only the first line of a mermaid parse error', () => {
  const { mermaidErrorText } = load();

  assert.equal(
    mermaidErrorText(new Error('\nParse error on line 2:\n...expecting SPACE')),
    'Parse error on line 2:',
  );
  assert.equal(mermaidErrorText('그냥 문자열'), '그냥 문자열');
  assert.equal(mermaidErrorText(undefined), '');
  assert.equal(mermaidErrorText(new Error('가'.repeat(200))).length, 100);
});

test('replaces the code block with the rendered svg', async () => {
  const { renderMermaid } = load({
    mermaid: { initialize() {}, async render(id) { return { svg: `<svg id="${id}"/>` }; } },
  });
  const pre = block('flowchart TD\n A --> B');
  let invalidated = 0;
  const view = {
    right: root([pre]),
    renderGen: 1,
    invalidateAnchors: () => { invalidated++; },
  };

  await renderMermaid(view);

  assert.equal(pre.replacedBy.className, 'mdsp-mermaid');
  assert.match(pre.replacedBy.innerHTML, /^<svg id="mdsp-mermaid-\d+"\/>$/);
  assert.equal(invalidated, 1);
});

test('resyncs after placing a cached diagram', async () => {
  const { renderMermaid } = load({
    mermaid: { initialize() {}, async render(id) { return { svg: `<svg id="${id}"/>` }; } },
  });
  const src = 'flowchart TD\n A --> B';
  const counts = { invalidated: 0, resynced: 0 };
  const viewFor = (pre) => ({
    right: root([pre]),
    renderGen: 1,
    invalidateAnchors: () => { counts.invalidated++; },
    resync: () => { counts.resynced++; },
  });

  await renderMermaid(viewFor(block(src)));
  assert.deepEqual(counts, { invalidated: 1, resynced: 1 });

  // 같은 소스라 두 번째는 첫 await 전에 캐시로 교체되는 경로를 지난다
  const cachedPre = block(src);
  await renderMermaid(viewFor(cachedPre));

  assert.equal(cachedPre.replacedBy.className, 'mdsp-mermaid');
  assert.deepEqual(counts, { invalidated: 2, resynced: 2 });
});

test('leaves the code block in place and explains a syntax error', async () => {
  const { renderMermaid } = load({
    mermaid: {
      initialize() {},
      async render() { throw new Error('Parse error on line 2:\n  ...'); },
    },
  });
  const pre = block('flowchart TD\n A --? B');
  const view = { right: root([pre]), renderGen: 1, invalidateAnchors() {} };

  await renderMermaid(view);

  assert.equal(pre.replacedBy, undefined, '코드블록은 그대로 남는다');
  assert.equal(pre.inserted.length, 1);
  assert.equal(pre.inserted[0].className, 'mdsp-mermaid-note');
  assert.match(pre.inserted[0].textContent, /Parse error on line 2:/);
});

test('drops a diagram that finished after the panel was re-rendered', async () => {
  const view = { renderGen: 1, invalidateAnchors() {} };
  const { renderMermaid } = load({
    mermaid: {
      initialize() {},
      async render(id) {
        view.renderGen = 2; // 렌더 도중 Expand 등으로 diff 가 다시 그려진 상황
        return { svg: `<svg id="${id}"/>` };
      },
    },
  });
  const pre = block('flowchart TD\n A --> B');
  view.right = root([pre]);

  await renderMermaid(view);

  assert.equal(pre.replacedBy, undefined, '낡은 결과는 붙이지 않는다');
});

test('falls back to the code block when mermaid failed to load', async () => {
  const { renderMermaid, created } = load({ mermaid: undefined });
  const pre = block('flowchart TD\n A --> B');

  await renderMermaid({ right: root([pre]), renderGen: 1, invalidateAnchors() {} });

  assert.equal(pre.replacedBy, undefined);
  assert.deepEqual(created, []);
});

test('cleans up the temporary node mermaid leaves behind', async () => {
  const removed = [];
  const { renderMermaid } = load({
    mermaid: { initialize() {}, async render() { throw new Error('boom'); } },
    removed,
  });
  const pre = block('flowchart TD\n A --? B');

  await renderMermaid({ right: root([pre]), renderGen: 1, invalidateAnchors() {} });

  assert.equal(removed.length, 1);
  assert.match(removed[0], /^dmdsp-mermaid-\d+$/);
});

/** rerender 는 innerHTML 을 새로 채우므로 pre 도 표시도 새로 만들어진다. */
function counting() {
  const seen = { calls: 0 };
  const helpers = load({
    mermaid: {
      initialize() {},
      async render(id) { seen.calls++; return { svg: `<svg id="${id}"/>` }; },
    },
  });
  return { ...helpers, seen };
}

test('reuses the cached svg instead of drawing the same source again', async () => {
  const { renderMermaid, seen } = counting();
  const src = 'flowchart TD\n A --> B';
  const first = block(src);
  await renderMermaid({ right: root([first]), renderGen: 1, invalidateAnchors() {} });

  const second = block(src);
  await renderMermaid({ right: root([second]), renderGen: 1, invalidateAnchors() {} });

  assert.equal(seen.calls, 1, '두 번째 렌더는 mermaid 를 다시 부르지 않는다');
  assert.equal(second.replacedBy.className, 'mdsp-mermaid');
  assert.equal(second.replacedBy.innerHTML, first.replacedBy.innerHTML);
});

test('places a cached diagram before the first await', async () => {
  const { renderMermaid, seen } = counting();
  const src = 'sequenceDiagram\n A->>B: hi';
  await renderMermaid({ right: root([block(src)]), renderGen: 1, invalidateAnchors() {} });

  const again = block(src);
  let invalidated = 0;
  const pending = renderMermaid({
    right: root([again]),
    renderGen: 1,
    invalidateAnchors: () => { invalidated++; },
  });

  // 같은 task 안에서 끼워야 소스 코드블록이 보이는 구간이 생기지 않는다
  assert.equal(again.replacedBy?.className, 'mdsp-mermaid');
  assert.equal(invalidated, 1);
  await pending;
  assert.equal(seen.calls, 1);
});
