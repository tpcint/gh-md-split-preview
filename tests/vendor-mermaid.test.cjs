const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const lock = JSON.parse(
  readFileSync(new URL('../vendor/mermaid.lock.json', `file://${__filename}`), 'utf8'),
);
const bundle = readFileSync(
  new URL('../vendor/mermaid.min.js', `file://${__filename}`),
  'utf8',
);
const userscript = readFileSync(
  new URL('../github-md-split-preview.user.js', `file://${__filename}`),
  'utf8',
);

const noop = () => {};

/** mermaid 번들이 로드 중에 만지는 DOM API 만 흉내 낸 최소 노드. */
function el() {
  return {
    style: {}, dataset: {}, textContent: '', innerHTML: '',
    classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
    appendChild: noop, insertBefore: noop, removeChild: noop, remove: noop, before: noop,
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ width: 0, height: 0, x: 0, y: 0, top: 0, left: 0 }),
  };
}

/**
 * Tampermonkey 는 @require 내용을 **함수 스코프**에서 실행한다. 그래서 최상위 `var` 가
 * globalThis 프로퍼티가 되지 않는다 — 업스트림 번들이 바로 이 지점에서 깨진다.
 * 같은 형태로 돌려, 사본이 실제로 전역 mermaid 를 노출하는지 본다.
 */
function loadInRequireScope(source) {
  const context = {
    console: { warn: noop, error: noop, info: noop, debug: noop, log: noop },
    document: {
      documentElement: el(), head: el(), body: el(),
      createElement: el, createElementNS: el, createTextNode: () => ({}),
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
      addEventListener: noop, removeEventListener: noop,
    },
    navigator: { userAgent: 'node', language: 'en' },
    location: { href: 'https://github.com/', protocol: 'https:', host: 'github.com' },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    MutationObserver: class { observe() {} disconnect() {} },
    addEventListener: noop, removeEventListener: noop,
    setTimeout, clearTimeout,
  };
  context.window = context;
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(`(function () {\n${source}\n})();`, context, { filename: 'require.js' });
  return context;
}

test('the vendored bundle exposes mermaid from a @require function scope', () => {
  // 업스트림 그대로면 여기서 TypeError 가 나고, 그 위치가 본문보다 앞이라 2단 보기가 죽는다.
  const context = loadInRequireScope(bundle);

  assert.equal(typeof context.mermaid, 'object', '전역 mermaid 가 만들어져야 한다');
  for (const api of ['initialize', 'render', 'parse']) {
    assert.equal(typeof context.mermaid[api], 'function', `mermaid.${api} 가 있어야 한다`);
  }
});

test('the upstream bundle is unusable in that scope — this is why we vendor', () => {
  const upstream = bundle.replace(lock.patch.after, lock.patch.before);
  assert.notEqual(upstream, bundle, 'lock 의 patch 가 사본과 맞아야 한다');

  assert.throws(() => loadInRequireScope(upstream), /Cannot read properties of undefined/);
});

test('the vendored bundle differs from upstream only by the recorded patch', () => {
  assert.equal(bundle.split(lock.patch.after).length - 1, 1, '치환된 줄이 정확히 1개');
  assert.equal(bundle.includes(lock.patch.before), false, '업스트림 형태가 남아 있지 않아야 한다');
  assert.equal(createHash('sha256').update(bundle, 'utf8').digest('hex'), lock.patchedSha256);

  const upstream = bundle.replace(lock.patch.after, lock.patch.before);
  assert.equal(createHash('sha256').update(upstream, 'utf8').digest('hex'), lock.upstreamSha256);
});

test('the userscript requires the vendored copy, not the upstream bundle', () => {
  const requires = userscript
    .split('\n')
    .filter((line) => /^\/\/\s*@require\s/.test(line))
    .map((line) => line.replace(/^\/\/\s*@require\s+/, '').trim());

  assert.ok(
    requires.some((url) => url.endsWith('/vendor/mermaid.min.js')),
    'vendor/mermaid.min.js 를 @require 해야 한다',
  );
  assert.equal(
    requires.some((url) => /\/npm\/mermaid@/.test(url)),
    false,
    '업스트림 mermaid 번들을 직접 @require 하면 안 된다',
  );
});
