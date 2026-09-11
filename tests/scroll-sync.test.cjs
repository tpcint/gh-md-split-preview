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
 * `delay` 프레임 뒤에 배달하는 패널로 Safari 의 이벤트 타이밍을 모사한다.
 * `deliverFirst` 는 그 배달을 같은 프레임의 rAF 콜백보다 앞에 두어, 브라우저가 렌더링
 * 단계 전에 이벤트 태스크를 처리하는 순서를 재현한다. `leftPad`·`rightPad` 는 좌우 첫 앵커의
 * 오프셋 차이(프리뷰 패딩, diff 의 hunk 헤더 행)를, `rightMax` 는 스크롤 최대치를 준다.
 */
function harness({ deliverFirst = false, delay = 2, leftPad = 0, rightPad = 0, rightMax = Infinity } = {}) {
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

  const runPending = () => {
    const due = pending;
    pending = [];
    for (const { id, fn } of due) if (!cancelled.has(id)) fn();
  };
  const deliverDue = () => {
    for (let i = deliveries.length - 1; i >= 0; i -= 1) {
      if (deliveries[i].at > frame) continue;
      const [{ pane }] = deliveries.splice(i, 1);
      pane.dispatch('scroll');
    }
  };
  const tick = () => {
    frame += 1;
    if (deliverFirst) {
      deliverDue();
      runPending();
    } else {
      runPending();
      deliverDue();
    }
  };

  const makePane = (rows, selector, maxScroll) => {
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
        pane.assigned += 1;
        const clamped = Math.min(Math.max(0, v), maxScroll);
        // 값이 그대로면 브라우저도 scroll 을 발생시키지 않는다
        if (clamped === top) return;
        top = clamped;
        deliveries.push({ at: frame + delay, pane });
      },
    });
    return pane;
  };

  // 라인 1~11 이 좌측은 20px, 우측은 40px 간격으로 놓인 문서
  const lines = Array.from({ length: 11 }, (_, i) => i + 1);
  const left = makePane(
    lines.map((line) => ({
      el: (pane) => ({
        getBoundingClientRect: () => ({ top: leftPad + (line - 1) * 20 - pane.scrollTop }),
        querySelectorAll: () => [{ classList: { contains: () => false }, querySelector: () => null, line }],
      }),
    })),
    'tr.diff-line-row, tr[class*=diff-line]',
    Infinity,
  );
  const right = makePane(
    lines.map((line) => ({
      el: (pane) => ({
        getAttribute: () => String(line),
        getBoundingClientRect: () => ({ top: rightPad + (line - 1) * 40 - pane.scrollTop }),
      }),
    })),
    '.mdsp-block[data-line]',
    rightMax,
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

test('restores the preview pane when it was the last pane the user scrolled', () => {
  const { left, right, tick, view } = harness({ deliverFirst: true, delay: 1 });

  right.userScroll(320);
  for (let i = 0; i < 4; i += 1) tick();
  assert.equal(left.scrollTop, 160);

  // 재렌더: innerHTML 대입이 scrollTop 을 0 으로 만들고, 그 대입이 발생시킨 scroll 이 복원보다 먼저 도착한다
  right.scrollTop = 0;
  view.invalidateAnchors();
  view.resync();
  for (let i = 0; i < 6; i += 1) tick();

  assert.equal(right.scrollTop, 320, 'the restore must survive the scroll event it caused');
  assert.equal(left.scrollTop, 160, 'the diff pane must not follow the emptied preview to the top');
});

test('keeps a preview scroll that lands while a rerender restore is in flight', () => {
  const { left, right, tick, view } = harness();

  left.userScroll(60);
  for (let i = 0; i < 4; i += 1) tick();

  // 재렌더가 프리뷰를 비운 직후, 같은 프레임에 사용자가 프리뷰를 스크롤한다
  right.scrollTop = 0;
  view.invalidateAnchors();
  view.resync();
  right.userScroll(400);
  for (let i = 0; i < 6; i += 1) tick();

  assert.equal(right.scrollTop, 400, 'the user scroll must win over the restore');
  assert.equal(left.scrollTop, 200, 'the diff pane must follow the user scroll, not the restore');
});

test('leaves the diff pane alone when the restore lands on a clamped anchor', () => {
  const { left, right, tick, view } = harness({ deliverFirst: true, delay: 1, leftPad: 40, rightPad: 16 });

  right.dispatch('pointerdown');  // 프리뷰를 클릭만 해도 출발점이 넘어간다
  right.scrollTop = 0;
  view.invalidateAnchors();
  view.resync();
  for (let i = 0; i < 6; i += 1) tick();

  assert.equal(left.scrollTop, 0, 'the restore must not push the diff pane off the top');
});

test('leaves the diff pane alone when the restore hits the preview scroll limit', () => {
  const { left, right, tick, view } = harness({
    deliverFirst: true, delay: 1, leftPad: 40, rightPad: 16, rightMax: 300,
  });

  left.userScroll(240);
  for (let i = 0; i < 4; i += 1) tick();
  right.dispatch('pointerdown');

  right.scrollTop = 0;
  view.invalidateAnchors();
  view.resync();
  for (let i = 0; i < 6; i += 1) tick();

  assert.equal(left.scrollTop, 240, 'a clamped restore must not become the new source of truth');
});

test('follows a preview scroll that returns to the last synced position', () => {
  const { left, right, tick } = harness();

  left.userScroll(60);
  for (let i = 0; i < 4; i += 1) tick();
  assert.equal(right.scrollTop, 120);

  right.userScroll(320);
  for (let i = 0; i < 4; i += 1) tick();
  assert.equal(left.scrollTop, 160);

  right.userScroll(120);  // 직전에 우리가 맞춰 둔 값과 같은 위치로 되돌아온다
  for (let i = 0; i < 6; i += 1) tick();

  assert.equal(left.scrollTop, 60, 'a user scroll must never be mistaken for our own assignment');
});

test('ignores an assignment echo that arrives after a click on the same pane', () => {
  const { left, right, tick } = harness({
    deliverFirst: true, delay: 2, leftPad: 40, rightPad: 16, rightMax: 300,
  });

  left.userScroll(240);  // 프리뷰 대상값은 최대치를 넘어 클램프된다
  tick();
  right.dispatch('pointerdown');  // 대입이 발생시킨 scroll 이 도착하기 전에 클릭한다
  for (let i = 0; i < 8; i += 1) tick();

  assert.equal(left.scrollTop, 240, 'a click must not turn our own assignment into a user scroll');
});

test('ignores an assignment echo that arrives after a keypress on the same pane', () => {
  const { left, right, tick } = harness({
    deliverFirst: true, delay: 2, leftPad: 40, rightPad: 16, rightMax: 300,
  });

  left.userScroll(240);
  tick();
  right.dispatch('keydown');
  for (let i = 0; i < 8; i += 1) tick();

  assert.equal(left.scrollTop, 240);
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
