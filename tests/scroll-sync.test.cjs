const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(
  new URL('../github-md-split-preview.user.js', `file://${__filename}`),
  'utf8',
);
const start = source.indexOf('  function buildAnchors(');
const end = source.indexOf('  const views = new WeakMap();', start);
assert.notEqual(start, -1, 'scroll sync helper start');
assert.notEqual(end, -1, 'scroll sync helper end');

/**
 * 프레임을 수동으로 진행시키는 가짜 rAF 와, scrollTop 대입에서 비롯한 scroll 이벤트를
 * 두 프레임 뒤에 배달하는 패널로 Safari 의 이벤트 타이밍을 모사한다.
 */
function harness() {
  let frame = 0;
  let nextId = 1;
  let pending = [];
  const cancelled = new Set();
  const deliveries = [];

  const sandbox = {
    requestAnimationFrame(fn) {
      const id = nextId++;
      pending.push({ id, fn });
      return id;
    },
    cancelAnimationFrame(id) {
      cancelled.add(id);
    },
    window: { addEventListener() {} },
    // 좌측 앵커 수집이 참조하는 스크립트 본문 밖 헬퍼
    newLineNumber(cell) {
      return cell.line;
    },
  };
  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.helpers = { attachSync };`,
    sandbox,
  );

  const tick = () => {
    frame += 1;
    const due = pending;
    pending = [];
    for (const { id, fn } of due) if (!cancelled.has(id)) fn();
    for (let i = deliveries.length - 1; i >= 0; i -= 1) {
      if (deliveries[i].at > frame) continue;
      const [{ pane }] = deliveries.splice(i, 1);
      pane.dispatch('scroll');
    }
  };

  const makePane = (rows, selector) => {
    const listeners = new Map();
    const pane = {
      scrollTop: 0,
      assigned: 0,
      getBoundingClientRect: () => ({ top: 0 }),
      querySelectorAll(sel) {
        return sel === selector ? rows.map((row) => row.el(pane)) : [];
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch(type) {
        for (const fn of listeners.get(type) ?? []) fn();
      },
      /** 사용자가 직접 조작한 스크롤: scroll 이벤트가 곧바로 도착한다. */
      userScroll(top) {
        pane.dispatch('wheel');
        pane.scrollTop = top;
        pane.dispatch('scroll');
      },
    };
    // 스크립트가 대입한 scrollTop 만 배달을 지연시켜, 사용자 스크롤과 구분한다
    let top = 0;
    Object.defineProperty(pane, 'scrollTop', {
      get: () => top,
      set(v) {
        top = v;
        pane.assigned += 1;
        deliveries.push({ at: frame + 2, pane });
      },
    });
    return pane;
  };

  // 라인 1~11 이 좌측은 20px, 우측은 40px 간격으로 놓인 문서
  const lines = Array.from({ length: 11 }, (_, i) => i + 1);
  const left = makePane(
    lines.map((line) => ({
      el: (pane) => ({
        getBoundingClientRect: () => ({ top: (line - 1) * 20 - pane.scrollTop }),
        querySelectorAll: () => [{ classList: { contains: () => false }, querySelector: () => null, line }],
      }),
    })),
    'tr.diff-line-row, tr[class*=diff-line]',
  );
  const right = makePane(
    lines.map((line) => ({
      el: (pane) => ({
        getAttribute: () => String(line),
        getBoundingClientRect: () => ({ top: (line - 1) * 40 - pane.scrollTop }),
      }),
    })),
    '.mdsp-block[data-line]',
  );

  const view = { left, right };
  sandbox.helpers.attachSync(view);
  // 사용자 스크롤이 아닌 초기 대입은 회차 계산에서 제외한다
  left.assigned = 0;
  right.assigned = 0;
  return { left, right, tick, view };
}

test('mirrors the pane the user scrolled', () => {
  const { left, right, tick } = harness();

  left.userScroll(60);
  tick();

  assert.equal(right.scrollTop, 120);
});

test('keeps the driving pane put when the mirrored scroll event arrives late', () => {
  const { left, right, tick } = harness();

  left.userScroll(60);
  for (let i = 0; i < 10; i += 1) tick();

  assert.equal(left.scrollTop, 60, 'the pane the user scrolled must not be moved back');
  assert.equal(right.scrollTop, 120);
});

test('follows the other pane once the user scrolls it instead', () => {
  const { left, right, tick } = harness();

  left.userScroll(60);
  for (let i = 0; i < 4; i += 1) tick();
  right.userScroll(320);
  for (let i = 0; i < 4; i += 1) tick();

  assert.equal(left.scrollTop, 160);
});

test('skips assignments below one pixel so momentum scrolling survives', () => {
  const { left, right, tick } = harness();

  left.userScroll(60);
  tick();
  assert.equal(right.assigned, 1);

  left.userScroll(60.2);
  for (let i = 0; i < 4; i += 1) tick();

  assert.equal(right.assigned, 1, 'a sub-pixel move must not touch the other pane');
});

test('restores the preview pane after a rerender clears its scroll position', () => {
  const { left, right, tick, view } = harness();

  left.userScroll(60);
  tick();
  assert.equal(right.scrollTop, 120);

  // 재렌더: innerHTML 대입이 스크롤 컨테이너를 비워 scrollTop 이 0 이 된다
  right.scrollTop = 0;
  view.invalidateAnchors();
  view.resync();
  for (let i = 0; i < 4; i += 1) tick();

  assert.equal(right.scrollTop, 120);
  assert.equal(left.scrollTop, 60, 'the diff pane must stay where the user left it');
});

test('resyncs before the user has scrolled either pane', () => {
  const { left, right, tick, view } = harness();

  left.scrollTop = 60;
  view.resync();
  for (let i = 0; i < 4; i += 1) tick();

  assert.equal(right.scrollTop, 120);
});

test('ignores scroll events from a pane the user never touched', () => {
  const { left, right, tick } = harness();

  right.dispatch('scroll');
  for (let i = 0; i < 4; i += 1) tick();

  assert.equal(left.assigned, 0);
});
