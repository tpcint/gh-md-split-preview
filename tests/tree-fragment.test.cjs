const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(
  new URL('../github-md-split-preview.user.js', `file://${__filename}`),
  'utf8',
);

function slice(startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start);
  assert.notEqual(start, -1, `${startMark} marker`);
  assert.notEqual(end, -1, `${endMark} marker`);
  return source.slice(start, end);
}

const sandbox = {};
vm.runInNewContext(
  `${slice('  // ── 트리 조각 렌더 ─ 시작', '  // ── 트리 조각 렌더 ─ 끝')}\n` +
    `${slice('  // ── 잘린 코드펜스 보정 ─ 시작', '  // ── 잘린 코드펜스 보정 ─ 끝')}\n` +
    'this.helpers = { parseTreeFragment, fencelessSegments };',
  sandbox,
);
const { parseTreeFragment } = sandbox.helpers;

// vm 컨텍스트가 만든 객체는 realm 이 달라 그대로 비교되지 않는다 — 숫자쌍으로 옮긴다
const segments = (srcLines, lineNoOf, startsAtFileBeginning) =>
  Array.from(
    sandbox.helpers.fencelessSegments(srcLines, lineNoOf, startsAtFileBeginning),
    (s) => [Number(s.start), Number(s.end)],
  );

const tree = (...lines) => lines.join('\n');

test('가지 문자로 시작하는 줄만 있으면 트리 조각이다', () => {
  const raw = tree(
    '├── gift.md                    # 단순: 선물',
    '│   ├── README.md',
    '└── entry.md',
  );

  assert.equal(parseTreeFragment(raw), raw);
});

test('맨 위 루트 한 줄은 가지가 아니어도 트리로 본다', () => {
  const raw = tree('flows/', '├── gift.md', '└── live/');

  assert.equal(parseTreeFragment(raw), raw);
});

test('가지 사이에 낀 산문 줄은 트리로 보지 않는다', () => {
  const raw = tree('├── gift.md', '이 흐름은 두 갈래로 나뉜다.', '└── live/');

  assert.equal(parseTreeFragment(raw), null);
});

test('가로줄이 한 줄뿐인 문단은 트리가 아니다', () => {
  const raw = tree('─────', '요약: 흐름은 두 갈래다.');

  assert.equal(parseTreeFragment(raw), null);
});

test('한 줄짜리는 문단으로 붙어도 잃는 게 없어 그대로 둔다', () => {
  assert.equal(parseTreeFragment('└── entry.md'), null);
});

test('트리 뒤 빈 줄은 떼고 원문 줄바꿈은 그대로 남긴다', () => {
  const raw = tree('├── gift.md', '└── live/', '', '');

  assert.equal(parseTreeFragment(raw), tree('├── gift.md', '└── live/'));
});

test('펜스가 한 줄도 없는 조각만 코드블록 후보로 남긴다', () => {
  const srcLines = ['├── gift.md', '└── live/'];

  assert.deepEqual(segments(srcLines, [40, 41]), [[0, 1]]);
  assert.deepEqual(segments(['```', ...srcLines], [39, 40, 41]), []);
});

test('파일 1번 줄부터 보이는 조각은 앞에 여는 펜스가 있을 수 없다', () => {
  assert.deepEqual(segments(['├── gift.md', '└── live/'], [1, 2]), []);
});

test('frontmatter 를 떼어낸 본문 첫 조각도 후보에서 뺀다', () => {
  const srcLines = ['├── gift.md', '└── live/'];

  assert.deepEqual(segments(srcLines, [8, 9], true), []);
});

test('접힌 구간 건너편 조각은 따로 판단한다', () => {
  const srcLines = ['```', 'sync();', '', '├── gift.md', '└── live/'];
  const lineNoOf = [12, 13, null, 40, 41];

  assert.deepEqual(segments(srcLines, lineNoOf), [[3, 4]]);
});
