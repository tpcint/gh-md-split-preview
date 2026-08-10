const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(
  new URL('../github-md-split-preview.user.js', `file://${__filename}`),
  'utf8',
);
const start = source.indexOf('  function findFileElements(');
const end = source.indexOf('  function scan()', start);
assert.notEqual(start, -1, 'file discovery helper start');
assert.notEqual(end, -1, 'file discovery helper end');

const sandbox = {};
vm.runInNewContext(
  `${source.slice(start, end)}\nthis.helpers = { findFileElements, isSplitDiff };`,
  sandbox,
);
const { findFileElements, isSplitDiff } = sandbox.helpers;

test('discovers current anonymous React diff regions from their rows', () => {
  const legacy = { kind: 'legacy' };
  const modern = { kind: 'modern' };
  const row = {
    closest(selector) {
      assert.equal(selector, 'div[role="region"][aria-labelledby]');
      return modern;
    },
  };
  const root = {
    querySelectorAll(selector) {
      return selector === 'tr.diff-line-row' ? [row] : [legacy];
    },
  };

  assert.deepEqual(
    Array.from(findFileElements(root), (item) => item.kind),
    ['legacy', 'modern'],
  );
});

test('deduplicates rows that belong to the same file region', () => {
  const modern = { kind: 'modern' };
  const row = { closest: () => modern };
  const root = {
    querySelectorAll(selector) {
      return selector === 'tr.diff-line-row' ? [row, row] : [];
    },
  };

  assert.deepEqual(
    Array.from(findFileElements(root), (item) => item.kind),
    ['modern'],
  );
});

function cell() {
  return { classList: { contains: () => false } };
}

test('does not call a unified deletion row a split diff', () => {
  const rows = [
    { querySelectorAll: () => [cell()] },
    { querySelectorAll: () => [cell()] },
  ];
  const root = { querySelectorAll: () => rows };

  assert.equal(isSplitDiff(root), false);
});

test('detects two text cells in the same split row', () => {
  const row = { querySelectorAll: () => [cell(), cell()] };
  const root = { querySelectorAll: () => [row] };

  assert.equal(isSplitDiff(root), true);
});
