const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(
  new URL('../github-md-split-preview.user.js', `file://${__filename}`),
  'utf8',
);
const start = source.indexOf('  // ── 잘린 코드펜스 보정 ─ 시작');
const end = source.indexOf('  // ── 잘린 코드펜스 보정 ─ 끝', start);
assert.notEqual(start, -1, 'fence helper start marker');
assert.notEqual(end, -1, 'fence helper end marker');

const sandbox = {};
vm.runInNewContext(
  `${source.slice(start, end)}\nthis.helpers = {\n` +
    `  balanceFences,\n` +
    `  cutMarkerInRange: typeof cutMarkerInRange === 'function' ? cutMarkerInRange : () => undefined,\n` +
    `  renderCodePart: typeof renderCodePart === 'function' ? renderCodePart : (html) => html,\n` +
    `  findCodeToken: typeof findCodeToken === 'function' ? findCodeToken : () => null,\n` +
    `  partCutsInRange: typeof partCutsInRange === 'function' ? partCutsInRange : () => [],\n` +
    `};`,
  sandbox,
);
const {
  balanceFences, cutMarkerInRange, renderCodePart, findCodeToken, partCutsInRange,
} = sandbox.helpers;

function balance(srcLines, lineNoOf, changedLines, startsAtFileBeginning) {
  const cut = balanceFences(srcLines, lineNoOf, new Set(changedLines), startsAtFileBeginning);
  return {
    srcLines,
    lineNoOf,
    head: [...cut.head].map(([at, marker]) => [Number(at), String(marker)]),
    tail: [...cut.tail].map(([at, marker]) => [Number(at), String(marker)]),
    inlineGapAfter: [...(cut.inlineGapAfter || [])].map(Number),
  };
}

test('changed code before a lone closer gets a synthetic opener', () => {
  const result = balance(
    ['changed();', '```', '', '# following document'],
    [20, 21, 22, 23],
    [20],
  );

  assert.deepEqual(result.srcLines, ['```', 'changed();', '```', '', '# following document']);
  assert.deepEqual(result.head, [[0, '```']]);
  assert.deepEqual(result.tail, []);
});

test('changed code after an info-less opener gets a synthetic closer', () => {
  const result = balance(
    ['설명 문단', '', '```', 'changed();'],
    [10, 11, 12, 13],
    [13],
  );

  assert.deepEqual(result.srcLines, ['설명 문단', '', '```', 'changed();', '```']);
  assert.deepEqual(result.head, []);
  assert.deepEqual(result.tail, [[4, '```']]);
});

test('changed prose separated by a blank does not reverse a visible opener', () => {
  const result = balance(
    ['changed prose', '', '```', 'stable code'],
    [10, 11, 12, 13],
    [10],
  );

  assert.deepEqual(result.srcLines, ['changed prose', '', '```', 'stable code', '```']);
  assert.deepEqual(result.head, []);
  assert.deepEqual(result.tail, [[4, '```']]);
});

test('a fence can interrupt changed prose without a blank', () => {
  const result = balance(
    ['changed prose', '```', 'stable code'],
    [10, 11, 12],
    [10],
  );

  assert.deepEqual(result.srcLines, ['changed prose', '```', 'stable code', '```']);
  assert.deepEqual(result.head, []);
  assert.deepEqual(result.tail, [[3, '```']]);
});

test('a fragment starting at line one cannot have a hidden opener', () => {
  const result = balance(
    ['changed intro', '```', '', 'stable code'],
    [1, 2, 3, 4],
    [1],
  );

  assert.deepEqual(result.srcLines, ['changed intro', '```', '', 'stable code', '```']);
  assert.deepEqual(result.head, []);
  assert.deepEqual(result.tail, [[4, '```']]);
});

test('a visible file prefix survives frontmatter extraction', () => {
  const result = balance(
    ['changed intro', '```', '', 'stable code'],
    [4, 5, 6, 7],
    [4],
    true,
  );

  assert.deepEqual(result.srcLines, ['changed intro', '```', '', 'stable code', '```']);
  assert.deepEqual(result.head, []);
  assert.deepEqual(result.tail, [[4, '```']]);
});

test('a gap after visible frontmatter keeps a hidden opener eligible', () => {
  const result = balance(
    ['', 'changed();', '```', '', '# following'],
    [null, 20, 21, 22, 23],
    [20],
    true,
  );

  assert.deepEqual(result.srcLines, ['', '```', 'changed();', '```', '', '# following']);
  assert.deepEqual(result.head, [[1, '```']]);
  assert.deepEqual(result.tail, []);
});

test('a shorter backtick run inside a complete longer fence stays content', () => {
  const original = ['````md', 'before', '```', 'changed();', '````', '', '# following document'];
  const result = balance([...original], [10, 11, 12, 13, 14, 15, 16], [13]);

  assert.deepEqual(result.srcLines, original);
  assert.deepEqual(result.head, []);
  assert.deepEqual(result.tail, []);
});

test('changes outside a complete fence do not turn it into two partial blocks', () => {
  const original = ['changed prose', '```', 'stable code', '```', 'following prose'];
  const result = balance([...original], [10, 11, 12, 13, 14], [10]);

  assert.deepEqual(result.srcLines, original);
  assert.deepEqual(result.head, []);
  assert.deepEqual(result.tail, []);
});

test('a different marker inside an open fence does not count as its closer', () => {
  const result = balance(
    ['앞 문단', '```js', 'changed();', '~~~', 'more code'],
    [30, 31, 32, 33, 34],
    [32],
  );

  assert.deepEqual(result.srcLines, ['앞 문단', '```js', 'changed();', '~~~', 'more code', '```']);
  assert.deepEqual(result.head, []);
  assert.deepEqual(result.tail, [[5, '```']]);
});

test('blockquote closer keeps its container prefix and marks the nested token', () => {
  const result = balance(
    ['> changed code', '> ```', '>', '> following explanation'],
    [40, 41, 42, 43],
    [40],
  );

  assert.deepEqual(result.srcLines, ['> ```', '> changed code', '> ```', '>', '> following explanation']);
  assert.deepEqual(result.head, [[0, '```']]);
  assert.equal(cutMarkerInRange(new Map(result.head), 0, 4), '```');
});

test('a blockquote synthetic opener starts at the current quote run', () => {
  const result = balance(
    ['> previous quote', 'plain paragraph', '> changed code', '> ```', '> explanation'],
    [35, 36, 37, 38, 39],
    [37],
  );

  assert.deepEqual(result.srcLines, [
    '> previous quote', 'plain paragraph', '> ```', '> changed code', '> ```', '> explanation',
  ]);
  assert.deepEqual(result.head, [[2, '```']]);
});

test('container-looking fences inside a complete outer fence stay code content', () => {
  const original = ['```md', '> ```', 'changed code', '```'];
  const result = balance([...original], [50, 51, 52, 53], [52]);

  assert.deepEqual(result.srcLines, original);
  assert.deepEqual(result.head, []);
  assert.deepEqual(result.tail, []);
});

test('list continuation closer keeps its indentation after a hidden opener', () => {
  const result = balance(
    ['- item', '', '    changed code', '    ```', '    following explanation'],
    [1, null, 20, 21, 22],
    [20],
  );

  assert.deepEqual(result.srcLines, [
    '- item', '', '    ```', '    changed code', '    ```', '    following explanation',
  ]);
  assert.deepEqual(result.head, [[2, '```']]);
  assert.equal(cutMarkerInRange(new Map(result.head), 0, 5), '```');
});

test('list context survives an indented paragraph before the hidden opener', () => {
  const result = balance(
    ['- item', '', '  explanation', '', '    changed code', '    ```', '    after'],
    [1, 2, 3, null, 20, 21, 22],
    [20],
  );

  assert.deepEqual(result.srcLines, [
    '- item', '', '  explanation', '', '    ```', '    changed code', '    ```', '    after',
  ]);
  assert.deepEqual(result.head, [[4, '```']]);
});

test('a quote gap preserves the outer list container for a partial fence', () => {
  const result = balance(
    ['> - item', '', '>     changed', '>     ```', '>     after'],
    [1, null, 20, 21, 22],
    [20],
  );

  assert.match(result.srcLines[1], /^> +<span class="mdsp-gap">/);
  assert.deepEqual(result.head, [[2, '```']]);
  assert.deepEqual(result.inlineGapAfter, [1]);
});

test('a quote gap without a nested fence stays a separate render boundary', () => {
  const original = ['> first', '', '> second'];
  const result = balance([...original], [1, null, 20], [20]);

  assert.deepEqual(result.srcLines, original);
  assert.deepEqual(result.inlineGapAfter, []);
});

test('list fences pair after independently valid relative indentation', () => {
  const original = ['- item', '', '    ```js', '    changed', '     ```', '    following'];
  const result = balance([...original], [1, 2, 3, 4, 5, 6], [4]);

  assert.deepEqual(result.srcLines, original);
  assert.deepEqual(result.head, []);
  assert.deepEqual(result.tail, []);
});

test('the partial marker wraps only its matching nested code block', () => {
  const html = '<pre><code>partial</code></pre>';
  const rendered = renderCodePart(html, '```', '여는');

  assert.equal((rendered.match(/class="mdsp-code-part"/g) || []).length, 1);
  assert.match(rendered, /^<div class="mdsp-code-part">.*<pre><code>partial<\/code><\/pre><\/div>$/);
});

test('raw HTML pre does not consume the fenced-code partial marker', () => {
  const raw = { type: 'html', raw: '<pre>literal</pre>' };
  const code = { type: 'code', raw: '```\npartial\n```' };
  const tokens = [{ type: 'list', items: [{ tokens: [raw, code] }] }];

  assert.equal(findCodeToken(tokens, 1), code);
});

// vm 컨텍스트가 만든 객체라 호스트 쪽 평범한 객체로 옮겨서 비교한다
function partCuts(head, tail, start, end) {
  return [...partCutsInRange(new Map(head), new Map(tail), start, end)]
    .map((cut) => ({ at: Number(cut.at), marker: String(cut.marker), where: String(cut.where) }));
}

test('one container token reports every cut it holds, in source order', () => {
  // 인용문 하나가 여는 조각과 닫는 조각을 함께 품는 모양. 한 건만 집으면 나머지 조각이
  // 안내 없이 온전한 블록처럼 지나가고, mermaid 는 그걸 그려버린다.
  const result = balance(
    ['> A --> B', '> ```', '> ```mermaid', '> flowchart TD', '>   X --> Y'],
    [40, 41, 42, 43, 44],
    [40],
  );

  assert.deepEqual(result.head, [[0, '```']]);
  assert.deepEqual(result.tail, [[6, '```']]);
  assert.deepEqual(partCuts(result.head, result.tail, 0, 6), [
    { at: 0, marker: '```', where: '여는' },
    { at: 6, marker: '```', where: '닫는' },
  ]);
});

test('cuts outside the token range are left to their own token', () => {
  const head = [[0, '```'], [9, '~~~']];
  const tail = [[4, '```'], [12, '~~~']];

  assert.deepEqual(partCuts(head, tail, 0, 4), [
    { at: 0, marker: '```', where: '여는' },
    { at: 4, marker: '```', where: '닫는' },
  ]);
  assert.deepEqual(partCuts(head, tail, 5, 8), []);
});
