// ==UserScript==
// @name         GitHub MD Split Preview
// @namespace    https://github.com/lucidash
// @version      2.9.0
// @description  GitHub PR/commit/compare의 변경 파일 화면에서 마크다운 diff와 렌더링 결과를 좌우 2단으로 동시에 보여주고 스크롤을 동기화합니다.
// @author       muzi
// @homepageURL  https://github.com/tpcint/gh-md-split-preview
// @supportURL   https://github.com/tpcint/gh-md-split-preview/issues
// @updateURL    https://raw.githubusercontent.com/tpcint/gh-md-split-preview/main/github-md-split-preview.user.js
// @downloadURL  https://raw.githubusercontent.com/tpcint/gh-md-split-preview/main/github-md-split-preview.user.js
// @match        https://github.com/*/*/pull/*
// @match        https://github.com/*/*/commit/*
// @match        https://github.com/*/*/commits/*
// @match        https://github.com/*/*/compare/*
// @require      https://cdn.jsdelivr.net/npm/marked@15/marked.min.js
// @require      https://cdn.jsdelivr.net/gh/tpcint/gh-md-split-preview@main/vendor/mermaid.min.js
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 동작 원리
 * ---------
 * 1. diff DOM 에 이미 들어있는 "변경 후(after)" 라인을 긁어 마크다운 원문을 복원한다.
 *    네트워크 요청이 전혀 없으므로 private repo / GHE / rate limit 문제가 없다.
 * 2. marked 의 lexer 로 블록 토큰을 뽑고, 각 토큰의 raw 길이로 시작/끝 라인을 계산해
 *    렌더링된 블록마다 data-line 을 심는다.
 * 3. 좌(diff)/우(rendered) 양쪽에 [라인번호 → 스크롤 오프셋] 앵커를 만들고 선형 보간으로 동기화한다.
 * 4. 추가(+)된 라인을 포함하는 렌더링 블록은 왼쪽에 초록 바로 강조한다.
 * 5. ```mermaid 코드블록은 렌더 후 mermaid 로 SVG 를 그려 끼워 넣는다(실패하면 코드블록 그대로).
 *
 * mermaid 는 왜 vendor/ 사본인가
 * ----------------------------
 * 업스트림 브라우저 번들(dist/mermaid.min.js)은 최상위에 var 를 두고 마지막 줄에서 그걸
 * globalThis 경유로 되읽어 전역 mermaid 를 만든다. Tampermonkey 는 @require 내용을 함수
 * 스코프에서 실행하므로 그 var 가 지역변수가 되고, 마지막 줄이 undefined 를 읽어 로드
 * 시점에 TypeError 를 던진다 — 그 위치가 본문보다 앞이라 2단 보기 자체가 뜨지 않는다.
 * 11.x 전 릴리스가 같은 형태이고 "use strict" 라 @resource + 간접 eval 로도 못 피한다.
 * vendor/mermaid.min.js 는 그 한 줄만 고친 사본이다 (tools/vendor-mermaid.mjs 로 갱신).
 *
 * 지원 DOM
 * --------
 * - 현행 React diff  : tr.diff-line-row / td.diff-text-cell / .diff-text-inner / data-diff-line-key
 * - 구형 Rails diff  : [data-code-marker] / td.blob-num[data-line-number]  (GHE 등 폴백)
 *
 * 한계
 * ----
 * - GitHub 이 접어둔 구간은 diff DOM 에 없으므로 렌더링에서도 빠진다(Expand 하면 자동 반영).
 * - 펜스가 diff 밖이라 조각만 남은 mermaid 는 문법이 온전하지 않으므로 그리지 않고 코드로 둔다.
 * - math 등 나머지 GitHub 전용 위젯은 그리지 않는다 — ```math 펜스는 코드블록으로, $$…$$ 는 원문 텍스트로 나온다.
 */

(function () {
  'use strict';

  const MD = typeof marked !== 'undefined' ? marked : (typeof window !== 'undefined' ? window.marked : null);
  if (!MD) {
    console.error('[md-split] marked 로드 실패 — @require 를 확인하세요.');
    return;
  }
  MD.setOptions({ gfm: true, breaks: false });

  const MD_EXT = /\.(md|markdown|mdx)$/i;
  const STORAGE_KEY = 'mdsp:enabled';
  const RATIO_KEY = 'mdsp:ratio';
  const DEBUG = false;
  const log = (...a) => DEBUG && console.debug('[md-split]', ...a);

  const cfg = {
    get enabled() { return localStorage.getItem(STORAGE_KEY) !== '0'; },
    set enabled(v) { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); },
    get ratio() {
      const r = parseFloat(localStorage.getItem(RATIO_KEY));
      return Number.isFinite(r) && r > 0.15 && r < 0.85 ? r : 0.5;
    },
    set ratio(v) { localStorage.setItem(RATIO_KEY, String(v)); },
  };

  // ────────────────────────────────────────────────────────────────── 스타일

  GM_addStyle(`
    .mdsp-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 12px; font-size: 12px;
      border: 1px solid var(--borderColor-default, #30363d); border-bottom: 0;
      background: var(--bgColor-muted, #161b22);
      color: var(--fgColor-muted, #8b949e);
    }
    .mdsp-btn {
      cursor: pointer; border: 1px solid var(--borderColor-default, #30363d);
      background: var(--bgColor-default, #0d1117); color: inherit;
      border-radius: 6px; padding: 2px 8px; font: inherit; line-height: 18px;
    }
    .mdsp-btn:hover { background: var(--bgColor-neutral-muted, rgba(110,118,129,.2)); }
    .mdsp-btn[aria-pressed="true"] {
      background: var(--bgColor-accent-emphasis, #1f6feb); color: #fff;
      border-color: var(--bgColor-accent-emphasis, #1f6feb);
    }
    .mdsp-note { margin-left: auto; font-size: 11px; opacity: .85; }

    .mdsp-wrap { display: flex; align-items: stretch; width: 100%; }
    .mdsp-left, .mdsp-right { overflow: auto; min-width: 0; max-height: 82vh; }
    .mdsp-left  { flex: 0 0 auto; }
    .mdsp-right {
      flex: 1 1 auto; padding: 16px 20px;
      border: 1px solid var(--borderColor-default, #30363d); border-left: 0;
      border-radius: 0 0 6px 0;
      background: var(--bgColor-default, #0d1117);
    }
    .mdsp-resizer { flex: 0 0 5px; cursor: col-resize; background: var(--borderColor-default, #30363d); }
    .mdsp-resizer:hover, .mdsp-resizing .mdsp-resizer { background: var(--bgColor-accent-emphasis, #1f6feb); }
    .mdsp-resizing { user-select: none; }

    .mdsp-block { position: relative; }
    .mdsp-block > :first-child { margin-top: 0; }
    .mdsp-block > :last-child  { margin-bottom: 0; }
    .mdsp-block + .mdsp-block { margin-top: 12px; }
    .mdsp-block[data-changed="1"] {
      padding-left: 10px; margin-left: -13px;
      border-left: 3px solid var(--bgColor-success-emphasis, #238636);
      background: var(--bgColor-success-muted, rgba(46,160,67,.10));
      border-radius: 0 4px 4px 0;
    }
    /* YAML frontmatter 표 (GitHub 과 동일하게 표로 보여준다) */
    .mdsp-right .markdown-body .mdsp-fm { margin-bottom: 16px; }
    .mdsp-right .markdown-body .mdsp-fm table {
      display: table; width: 100%; border-collapse: collapse; font-size: 12px;
      border: 1px solid var(--borderColor-default, #30363d); border-radius: 6px;
    }
    .mdsp-right .markdown-body .mdsp-fm td {
      padding: 4px 10px; vertical-align: top;
      border: 0; border-bottom: 1px solid var(--borderColor-muted, #21262d);
    }
    .mdsp-right .markdown-body .mdsp-fm tr:last-child td { border-bottom: 0; }
    .mdsp-right .markdown-body .mdsp-fm td:first-child {
      width: 1%; white-space: nowrap; font-weight: 600;
      color: var(--fgColor-muted, #8b949e);
      border-right: 1px solid var(--borderColor-muted, #21262d);
    }
    /* 배열·중첩 객체는 셀 안에서 다시 표로 편다 */
    .mdsp-right .markdown-body .mdsp-fm .mdsp-fm-sub {
      display: table; width: auto; margin: 0; border-radius: 0;
      border: 0; border-collapse: collapse;
    }
    .mdsp-right .markdown-body .mdsp-fm .mdsp-fm-sub td,
    .mdsp-right .markdown-body .mdsp-fm .mdsp-fm-sub th,
    .mdsp-right .markdown-body .mdsp-fm .mdsp-fm-sub td:first-child,
    .mdsp-right .markdown-body .mdsp-fm .mdsp-fm-sub th:first-child {
      width: auto; white-space: normal; padding: 3px 8px;
      color: inherit; font-weight: 400; text-align: left;
      border: 1px solid var(--borderColor-muted, #21262d);
      box-shadow: none;
    }
    .mdsp-right .markdown-body .mdsp-fm .mdsp-fm-sub th,
    .mdsp-right .markdown-body .mdsp-fm .mdsp-fm-sub th:first-child {
      font-weight: 600; color: var(--fgColor-muted, #8b949e);
    }
    .mdsp-right .markdown-body .mdsp-fm tr[data-changed="1"] {
      background: var(--bgColor-success-muted, rgba(46,160,67,.10));
    }
    .mdsp-right .markdown-body .mdsp-fm tr[data-changed="1"] td:first-child {
      box-shadow: inset 3px 0 0 var(--bgColor-success-emphasis, #238636);
    }
    /* 앞뒤 구분선이 diff 밖이라 일부만 살린 frontmatter — 점선으로 "잘린 표"임을 알린다 */
    .mdsp-right .markdown-body .mdsp-fm caption {
      caption-side: top; text-align: left; padding: 0 0 4px;
      font-size: 11px; color: var(--fgColor-muted, #8b949e);
    }
    .mdsp-right .markdown-body .mdsp-fm-part table { border-style: dashed; }
    /* 접힌 구간 안내 행 — 키 칸 스타일(좁은 폭·굵게)을 물려받지 않게 되돌린다 */
    .mdsp-right .markdown-body .mdsp-fm .mdsp-fm-gap td,
    .mdsp-right .markdown-body .mdsp-fm .mdsp-fm-gap td:first-child {
      width: auto; white-space: normal; font-weight: 400; text-align: center;
      font-size: 11px; color: var(--fgColor-muted, #8b949e); border-right: 0;
    }
    /* 부모 키가 diff 밖이라 값만 남은 앞머리 */
    .mdsp-right .markdown-body .mdsp-fm .mdsp-fm-cut td:first-child { font-weight: 400; }

    /* 헤더 줄이 diff 밖이라 표로 파싱되지 않은 구간 — 점선으로 "잘린 표"임을 알린다 */
    .mdsp-right .markdown-body .mdsp-table-part { border-collapse: collapse; }
    .mdsp-right .markdown-body .mdsp-table-part caption {
      caption-side: top; text-align: left; padding: 0 0 4px;
      font-size: 11px; color: var(--fgColor-muted, #8b949e);
    }
    .mdsp-right .markdown-body .mdsp-table-part td {
      border: 1px dashed var(--borderColor-default, #30363d);
      padding: 5px 12px; vertical-align: top;
      /* 열이 좁아져도 "단순" 같은 짧은 말이 글자 단위로 쪼개지지 않게 한다 */
      word-break: keep-all;
    }

    /* 여는(또는 닫는) 펜스 줄이 diff 밖이라 채워 넣은 코드블록 — 점선으로 "잘린 구간"임을 알린다 */
    .mdsp-right .markdown-body .mdsp-code-part .mdsp-part-note {
      padding: 0 0 4px; font-size: 11px; color: var(--fgColor-muted, #8b949e);
    }
    .mdsp-right .markdown-body .mdsp-code-part pre {
      border: 1px dashed var(--borderColor-default, #30363d);
    }

    /* mermaid 로 그려낸 다이어그램 — 패널이 좁아도 넘치지 않게 가로 스크롤만 준다 */
    .mdsp-right .markdown-body .mdsp-mermaid { overflow-x: auto; padding: 4px 0; }
    .mdsp-right .markdown-body .mdsp-mermaid svg { max-width: 100%; height: auto; }
    /* 문법 오류로 그리지 못해 코드블록으로 되돌린 자리 */
    .mdsp-right .markdown-body .mdsp-mermaid-note {
      padding: 0 0 4px; font-size: 11px; color: var(--fgColor-danger, #f85149);
    }

    .mdsp-gap {
      display: block;
      margin: 14px 0; padding: 3px 0; text-align: center; font-size: 11px;
      color: var(--fgColor-muted, #8b949e);
      border-top: 1px dashed var(--borderColor-muted, #21262d);
      border-bottom: 1px dashed var(--borderColor-muted, #21262d);
    }
    .mdsp-empty { color: var(--fgColor-muted, #8b949e); font-size: 12px; padding: 8px 0; }

    /* markdown-body CSS 가 없는 화면을 위한 최소 폴백 */
    .mdsp-right .markdown-body { font-size: 14px; line-height: 1.6; word-wrap: break-word; }
    .mdsp-right .markdown-body h1, .mdsp-right .markdown-body h2 {
      padding-bottom: .3em; border-bottom: 1px solid var(--borderColor-muted, #21262d);
    }
    .mdsp-right .markdown-body table { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; }
    .mdsp-right .markdown-body th, .mdsp-right .markdown-body td {
      border: 1px solid var(--borderColor-default, #30363d); padding: 5px 12px;
    }
    .mdsp-right .markdown-body img { max-width: 100%; }
    .mdsp-right .markdown-body pre {
      overflow-x: auto; padding: 12px; border-radius: 6px;
      background: var(--bgColor-muted, #161b22);
    }
    .mdsp-right .markdown-body code { font-size: 85%; }
    .mdsp-right .markdown-body blockquote {
      padding: 0 1em; color: var(--fgColor-muted, #8b949e);
      border-left: .25em solid var(--borderColor-default, #30363d);
    }
  `);

  // ─────────────────────────────────────────────── diff DOM → 마크다운 원문 복원

  /** 텍스트 셀에서 "변경 후" 라인번호를 얻는다. 여러 GitHub DOM 세대를 순서대로 시도한다. */
  function newLineNumber(cell, tr) {
    // 1) data-diff-line-key="b:20-l:20-r:20" — r 이 변경 후 라인번호 (현행 React diff)
    const key = cell.getAttribute('data-diff-line-key');
    if (key) {
      const m = /r:(\d+)/.exec(key);
      if (m) return parseInt(m[1], 10);
    }
    // 2) data-line-anchor="diff-<hash>R20" — R = 변경 후
    const anchor = cell.getAttribute('data-line-anchor');
    if (anchor) {
      const m = /R(\d+)$/.exec(anchor);
      if (m) return parseInt(m[1], 10);
    }
    // 3) 같은 행의 right-side 라인번호 셀
    const rightNum = tr.querySelector('td[data-diff-side="right"][data-line-number]');
    if (rightNum) {
      const n = parseInt(rightNum.getAttribute('data-line-number'), 10);
      if (Number.isFinite(n)) return n;
    }
    // 4) data-grid-cell-id="diff-<hash>-<old>-<new>-<col>"
    const gid = cell.getAttribute('data-grid-cell-id');
    if (gid) {
      const p = gid.split('-');
      const n = parseInt(p[p.length - 2], 10);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  /** 현행 React diff 에서 변경 후 라인을 추출한다. */
  function extractFromReactDiff(scope) {
    const rows = scope.querySelectorAll('tr.diff-line-row');
    if (!rows.length) return null;

    const byLine = new Map();
    for (const tr of rows) {
      const cells = [...tr.querySelectorAll('td.diff-text-cell')].filter(
        (c) => !c.classList.contains('hunk')
      );
      if (!cells.length) continue;

      // unified 는 텍스트 셀이 1개, split 은 2개(좌 old / 우 new) → 항상 마지막이 new 쪽
      const cell = cells[cells.length - 1];
      const markerEl = cell.querySelector('.diff-text-marker');
      const marker = markerEl ? markerEl.textContent.trim() : '';
      if (marker === '-') continue; // 삭제 라인은 "변경 후" 에 존재하지 않음

      const inner = cell.querySelector('.diff-text-inner');
      let text;
      if (inner) {
        text = inner.textContent;
      } else {
        const raw = cell.textContent ?? '';
        // split 뷰의 빈 자리(placeholder) 셀은 버린다
        if (!marker && !raw) continue;
        text = marker && raw.startsWith(marker) ? raw.slice(marker.length) : raw;
      }

      const n = newLineNumber(cell, tr);
      if (!Number.isFinite(n)) continue;

      const prev = byLine.get(n);
      if (prev && !(marker === '+' && !prev.added)) continue;
      byLine.set(n, { n, text: text.replace(/\r?\n$/, ''), added: marker === '+' });
    }
    return [...byLine.values()].sort((a, b) => a.n - b.n);
  }

  /** 구형 Rails diff(GHE 등) 폴백. */
  function extractFromLegacyDiff(scope) {
    const markers = scope.querySelectorAll('[data-code-marker]');
    if (!markers.length) return null;

    const byLine = new Map();
    for (const tr of scope.querySelectorAll('tr')) {
      const codeTds = [...tr.children].filter(
        (td) => td.tagName === 'TD' && td.classList.contains('blob-code')
      );
      if (!codeTds.length) continue;
      const codeTd = codeTds[codeTds.length - 1];
      if (codeTd.classList.contains('blob-code-empty') || codeTd.classList.contains('blob-code-hunk')) continue;

      const inner = codeTd.querySelector('[data-code-marker]');
      if (!inner) continue;
      const marker = inner.getAttribute('data-code-marker');
      if (marker === '-') continue;

      const n = parseInt(codeTd.previousElementSibling?.getAttribute('data-line-number') ?? '', 10);
      if (!Number.isFinite(n)) continue;

      const prev = byLine.get(n);
      if (prev && !(marker === '+' && !prev.added)) continue;
      byLine.set(n, { n, text: inner.textContent.replace(/\r?\n$/, ''), added: marker === '+' });
    }
    return [...byLine.values()].sort((a, b) => a.n - b.n);
  }

  const extractAfterLines = (scope) =>
    extractFromReactDiff(scope) || extractFromLegacyDiff(scope) || [];

  // ────────────────────────────────────────────────── 마크다운 렌더링 + 라인 매핑

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** GitHub Alert(> [!NOTE] 등)를 GitHub 과 같은 클래스로 바꿔준다. */
  function applyAlerts(html) {
    return html.replace(
      /<blockquote>\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>)?\s*/gi,
      (_m, kind) => {
        const k = kind.toLowerCase();
        return `<blockquote class="markdown-alert markdown-alert-${k}">` +
          `<p class="markdown-alert-title">${k.charAt(0).toUpperCase()}${k.slice(1)}</p><p>`;
      }
    );
  }

  /** frontmatter 조각으로 인정할 최대 시작 라인. 이보다 아래에서 시작하면 본문으로 본다. */
  const FM_PARTIAL_MAX_LINE = 40;

  /** 조각을 frontmatter 로 인정할 최상위 키 꼴. 본문의 `- 항목`·`| 셀` 을 키로 읽지 않게 좁혀 둔다. */
  const FM_KEY = /^[A-Za-z0-9_.$-]+$/;

  /** 라인들을 접힌 구간 경계로 잘라 "번호가 이어지는 구간" 배열로 만든다. */
  function splitSegments(lines) {
    const segs = [];
    for (const l of lines) {
      const cur = segs[segs.length - 1];
      if (cur && l.n === cur[cur.length - 1].n + 1) cur.push(l);
      else segs.push([l]);
    }
    return segs;
  }

  /** 조각 앞머리의 "부모 키가 diff 밖인" 들여쓴 줄·시퀀스 항목을 떼어낸다. */
  function splitOrphanHead(seg) {
    let i = 0;
    while (i < seg.length && (fmIndent(seg[i].text) > 0 || /^-(\s|$)/.test(seg[i].text.trim()))) i++;
    return { orphan: seg.slice(0, i), body: seg.slice(i) };
  }

  /** 조각이 YAML 매핑으로 읽히는가. */
  const fmParsable = (seg) => !!parseFrontmatterTree(splitOrphanHead(seg).body);

  /**
   * 첫 조각 뒤의 조각을 frontmatter 로 이어 볼 수 있는가.
   * `looksLikeFrontmatter` 와 같은 근거(빈 줄 없음·키가 YAML 식별자 꼴)를 요구한다.
   * 단 부모 키가 diff 밖이라 값만 남은 조각은 읽을 키가 없으므로 그대로 통과시킨다.
   */
  function fmSegmentOk(seg) {
    if (seg.some((l) => !l.text.trim())) return false;
    const body = splitOrphanHead(seg).body;
    const rows = parseFrontmatterTree(body);
    return rows ? rows.every((r) => FM_KEY.test(r.key)) : !body.length;
  }

  /** 앞머리 줄들이 YAML 조각처럼 생겼는가(시퀀스 항목이거나 `key: value`). */
  const fmOrphanish = (lines) =>
    lines.every((l) => {
      const t = l.text.trim();
      return /^-(\s|$)/.test(t) || !!fmSplitKey(t);
    });

  /**
   * 여는 `---` 가 diff 밖인 조각을 frontmatter 로 인정할지 본다.
   * 걸러야 할 것은 `제목: 부제` 뒤에 `---` 가 오는 setext heading 과, 콜론이 섞인 본문이다.
   * 빈 줄이 없어야 하고, 키가 모두 YAML 식별자 꼴이어야 하며,
   * 그 하나로 끝나지 않는다는 근거(키가 여럿·중첩 값·YAML 앞머리)가 있어야 한다.
   */
  function looksLikeFrontmatter(segments) {
    if (segments.some((seg) => seg.some((l) => !l.text.trim()))) return false;

    const { orphan, body } = splitOrphanHead(segments[0]);
    const rows = parseFrontmatterTree(body);
    if (!rows || !rows.length) return false;
    // 표 조각(`| 항목`)·불릿 목록(`- 생년`)·산문도 `fmSplitKey` 는 키로 통과시킨다.
    // 여는 `---` 가 없는 조각은 근거가 이것뿐이므로 키 꼴을 YAML 식별자로 좁힌다
    if (!rows.every((r) => FM_KEY.test(r.key))) return false;

    return rows.length >= 2 ||
      rows.some((r) => r.node && r.node.type !== 'scalar') ||
      (orphan.length > 0 && fmOrphanish(orphan));
  }

  /**
   * 파일 맨 앞의 YAML frontmatter 구간을 떼어낸다.
   * marked 는 `---` 를 setext heading 으로 읽어 frontmatter 를 거대한 제목으로 만들기 때문에,
   * GitHub 처럼 표로 따로 렌더링한다.
   *
   * frontmatter 를 몇 줄만 고친 PR 은 여는/닫는 `---` 가 diff 밖으로 밀려나므로
   * 남은 조각만이라도 표로 살린다. 사이에 접힌 구간이 있으면 조각마다 따로 읽는다.
   */
  function extractFrontmatter(lines) {
    if (!lines.length) return null;

    const opened = lines[0].n === 1 && lines[0].text.trim() === '---';
    // 1번 줄이 diff 에 있는데 `---` 가 아니면 이 파일엔 frontmatter 자체가 없다
    if (!opened && lines[0].n === 1) return null;
    // 여는 `---` 가 없다면 파일 앞부분일 때만 frontmatter 조각으로 본다
    if (!opened && lines[0].n > FM_PARTIAL_MAX_LINE) return null;

    const segs = splitSegments(opened ? lines.slice(1) : lines);
    const segments = [];
    let rest = [];
    let closed = false;

    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      const at = seg.findIndex((l) => l.text.trim() === '---');
      // 닫는 `---` 를 아직 못 봤다면, YAML 로 읽히는 조각까지만 frontmatter 로 본다
      if (at === -1 && !fmParsable(seg)) { rest = segs.slice(s).flat(); break; }

      const head = at === -1 ? seg : seg.slice(0, at);
      // 첫 조각 뒤는 접힌 구간 너머의 본문 hunk 일 수 있다 — 같은 근거를 다시 요구한다
      if (s > 0 && head.length && !fmSegmentOk(head)) { rest = segs.slice(s).flat(); break; }
      if (head.length) segments.push(head);
      if (at !== -1) {
        closed = true;
        rest = seg.slice(at + 1).concat(segs.slice(s + 1).flat());
        break;
      }
    }

    if (!segments.length) return null;
    if (!opened && !looksLikeFrontmatter(segments)) return null;

    return {
      segments,
      rest,
      startLine: opened ? 1 : segments[0][0].n,
      cutHead: !opened,
      cutTail: !closed,
    };
  }

  /** frontmatter 본문을 key/value 행으로 만든다. 들여쓴 줄은 직전 키의 값에 이어 붙인다. */
  function parseFrontmatterRows(bodyLines) {
    const rows = [];
    for (const l of bodyLines) {
      if (!l.text.trim()) continue;
      const m = /^([A-Za-z0-9_.$-]+)\s*:\s*(.*)$/.exec(l.text);
      if (m && !/^\s/.test(l.text)) {
        rows.push({ key: m[1], value: m[2].trim(), lines: [l] });
      } else if (rows.length) {
        const last = rows[rows.length - 1];
        last.value = last.value ? `${last.value} ${l.text.trim()}` : l.text.trim();
        last.lines.push(l);
      } else {
        rows.push({ key: '', value: l.text.trim(), lines: [l] });
      }
    }
    return rows;
  }

  // ── frontmatter YAML 파서 ─ 시작 (배열·중첩 객체를 GitHub 처럼 중첩 표로 편다)

  const FM_MAX_DEPTH = 8;

  /** 선행 공백 폭. 탭이 섞이면 -1 (들여쓰기 폭을 신뢰할 수 없어 파싱을 포기한다). */
  function fmIndent(text) {
    let i = 0;
    while (text[i] === ' ') i++;
    return text[i] === '\t' ? -1 : i;
  }

  /** 따옴표 밖의 ` #` 부터를 주석으로 잘라낸다. */
  function fmStripComment(text) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\' && quote === '"') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
    }
    return text;
  }

  /** 따옴표를 벗겨 표시용 문자열로 만든다. */
  function fmScalar(raw) {
    const t = raw.trim();
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
      return t.slice(1, -1).replace(/\\(.)/g, (_m, c) => ({ n: '\n', t: '\t', r: '\r' }[c] ?? c));
    }
    if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
    return t;
  }

  /** `key: value` 를 분해한다. 키 꼴이 아니면 null. */
  function fmSplitKey(text) {
    let end = -1;
    const q = text[0];
    if (q === '"' || q === "'") {
      for (let i = 1; i < text.length; i++) {
        if (text[i] === '\\' && q === '"') { i++; continue; }
        if (text[i] === q) { end = i + 1; break; }
      }
      if (end === -1 || text[end] !== ':') return null;
    } else {
      // `url: https://x` 처럼 값에 콜론이 있어도 되도록, 뒤가 공백/줄끝인 첫 콜론만 키 구분자로 본다
      for (let i = 0; i < text.length; i++) {
        if (text[i] === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) { end = i; break; }
      }
      if (end <= 0 || /[[\]{},"']/.test(text.slice(0, end))) return null;
    }
    return { key: fmScalar(text.slice(0, end)), value: text.slice(end + 1).trim() };
  }

  /** `[a, b]` / `{k: v}` 같은 flow 표기를 노드로 만든다. 형식이 아니면 null. */
  function fmParseFlow(src) {
    if (src[0] !== '[' && src[0] !== '{') return null;
    let p = 0;
    const ws = () => { while (p < src.length && /\s/.test(src[p])) p++; };

    const token = (stopColon) => {
      const start = p;
      let quote = null;
      while (p < src.length) {
        const c = src[p];
        if (quote) {
          if (c === '\\' && quote === '"') p++;
          else if (c === quote) quote = null;
        } else if ('[]{},'.includes(c) || (stopColon && c === ':')) break;
        else if (c === '"' || c === "'") quote = c;
        p++;
      }
      if (p === start) throw new Error('flow');
      return src.slice(start, p);
    };

    const value = (depth) => {
      if (depth > FM_MAX_DEPTH) throw new Error('deep');
      ws();
      if (src[p] === '[') { p++; return collection(depth, ']'); }
      if (src[p] === '{') { p++; return collection(depth, '}'); }
      return { type: 'scalar', text: fmScalar(token(false)) };
    };

    const collection = (depth, close) => {
      const isMap = close === '}';
      const items = [];
      const entries = [];
      const done = () => (isMap ? { type: 'map', entries } : { type: 'seq', items });
      ws();
      if (src[p] === close) { p++; return done(); }
      for (;;) {
        if (isMap) {
          ws();
          const key = token(true);
          ws();
          if (src[p] !== ':') throw new Error('flow');
          p++;
          entries.push({ key: fmScalar(key), node: value(depth + 1) });
        } else {
          items.push(value(depth + 1));
        }
        ws();
        if (src[p] === ',') { p++; ws(); if (src[p] !== close) continue; }
        if (src[p] !== close) throw new Error('flow');
        p++;
        return done();
      }
    };

    try {
      const node = value(0);
      ws();
      return p === src.length ? node : null;
    } catch { return null; }
  }

  /**
   * frontmatter 본문을 트리로 파싱한다. 최상위 키마다 { key, node, lines } 를 돌려준다.
   * 지원: 블록 매핑/시퀀스, flow 표기, 따옴표·블록(`|` `>`) 스칼라, 주석.
   * 지원 밖 문법을 만나면 null 을 돌려 호출부가 예전의 단순 key/value 표로 폴백하게 한다.
   */
  function parseFrontmatterTree(bodyLines) {
    const src = bodyLines.map((l) => ({
      indent: fmIndent(l.text), text: fmStripComment(l.text).trim(), raw: l.text,
    }));
    if (src.some((s) => s.indent < 0)) return null;
    let i = 0;

    const skipBlank = () => { while (i < src.length && !src[i].text) i++; };

    function parseValue(indent, depth) {
      if (depth > FM_MAX_DEPTH) throw new Error('deep');
      skipBlank();
      if (i >= src.length || src[i].indent < indent) return { type: 'scalar', text: '' };
      return /^-(\s|$)/.test(src[i].text) ? parseSeq(src[i].indent, depth) : parseMap(src[i].indent, depth);
    }

    function parseMap(indent, depth) {
      const entries = [];
      for (;;) {
        skipBlank();
        if (i >= src.length || src[i].indent < indent) break;
        if (src[i].indent > indent) throw new Error('indent');
        const kv = fmSplitKey(src[i].text);
        if (!kv) throw new Error('key');
        const from = i;
        i++;
        const node = parseAfterKey(kv.value, indent, depth);
        entries.push({ key: kv.key, node, from, to: i });
      }
      if (!entries.length) throw new Error('empty');
      return { type: 'map', entries };
    }

    function parseAfterKey(value, indent, depth) {
      if (/^[|>][+-]?\d*$/.test(value)) return parseBlockScalar(value[0] === '>', indent);
      if (value) return fmParseFlow(value) || { type: 'scalar', text: fmScalar(value) };

      // 값이 다음 줄부터인 경우
      skipBlank();
      if (i >= src.length) return { type: 'scalar', text: '' };
      if (src[i].indent > indent) return parseValue(src[i].indent, depth + 1);
      // 시퀀스는 부모 키와 같은 깊이로 쓰는 표기도 흔하다
      if (src[i].indent === indent && /^-(\s|$)/.test(src[i].text)) return parseSeq(indent, depth + 1);
      return { type: 'scalar', text: '' };
    }

    function parseBlockScalar(fold, indent) {
      const buf = [];
      let base = null;
      while (i < src.length) {
        const raw = src[i].raw;
        if (!raw.trim()) { buf.push(''); i++; continue; }   // 블록 스칼라 안에서는 주석도 내용이다
        if (fmIndent(raw) <= indent) break;
        if (base === null) base = fmIndent(raw);
        buf.push(raw.slice(base));
        i++;
      }
      while (buf.length && !buf[buf.length - 1]) buf.pop();
      return { type: 'scalar', text: fold ? buf.join(' ').trim() : buf.join('\n') };
    }

    function parseSeq(indent, depth) {
      const items = [];
      for (;;) {
        skipBlank();
        if (i >= src.length) break;
        const cur = src[i];
        if (cur.indent !== indent || !/^-(\s|$)/.test(cur.text)) break;

        const rest = cur.text.slice(1).trim();
        if (!rest) {
          i++;
          skipBlank();
          items.push(i < src.length && src[i].indent > indent
            ? parseValue(src[i].indent, depth + 1)
            : { type: 'scalar', text: '' });
          continue;
        }
        if (fmSplitKey(rest)) {
          // `- key: value` 컴팩트 매핑 — 대시 뒤 컬럼을 그 매핑의 들여쓰기로 삼아 다음 줄들과 이어 읽는다
          const off = cur.text.indexOf(rest, 1);
          src[i] = { indent: indent + off, text: rest, raw: cur.raw };
          items.push(parseMap(indent + off, depth + 1));
          continue;
        }
        i++;
        items.push(fmParseFlow(rest) || { type: 'scalar', text: fmScalar(rest) });
      }
      if (!items.length) throw new Error('empty');
      return { type: 'seq', items };
    }

    try {
      skipBlank();
      if (i >= src.length || src[i].indent !== 0) return null;
      const root = parseMap(0, 0);
      if (i < src.length) return null;    // 다 읽지 못했으면 해석이 어긋난 것이다
      return root.entries.map((e) => ({ key: e.key, node: e.node, lines: bodyLines.slice(e.from, e.to) }));
    } catch { return null; }
  }

  /** 값 노드를 표로 렌더링한다. 시퀀스는 한 줄로, 매핑은 키 행 + 값 행으로 편다(GitHub 과 동일). */
  function renderFmValue(node) {
    if (!node) return '';
    if (node.type === 'scalar') return escapeHtml(node.text).replace(/\n/g, '<br>');
    if (node.type === 'seq') {
      if (!node.items.length) return '';
      return '<table class="mdsp-fm-sub"><tbody><tr>' +
        node.items.map((v) => `<td>${renderFmValue(v)}</td>`).join('') +
        '</tr></tbody></table>';
    }
    if (!node.entries.length) return '';
    return '<table class="mdsp-fm-sub"><tbody>' +
      `<tr>${node.entries.map((e) => `<th>${escapeHtml(e.key)}</th>`).join('')}</tr>` +
      `<tr>${node.entries.map((e) => `<td>${renderFmValue(e.node)}</td>`).join('')}</tr>` +
      '</tbody></table>';
  }

  // ── frontmatter YAML 파서 ─ 끝

  const FM_GAP_ROW =
    '<tr class="mdsp-fm-gap"><td colspan="2">⋯ 접힌 구간 (왼쪽 diff에서 펼치면 반영됩니다) ⋯</td></tr>';

  /** 표 한 행. 추가된 줄이 섞여 있으면 초록으로 강조한다. */
  function fmRow(key, value, lines, cls) {
    const changed = lines.some((l) => l.added);
    return `<tr${cls ? ` class="${cls}"` : ''}${changed ? ' data-changed="1"' : ''}>` +
      `<td>${key}</td><td>${value}</td></tr>`;
  }

  /** 조각 하나를 표 행들로 만든다. 부모 키가 diff 밖인 앞머리는 값만 한 행에 모아 둔다. */
  function renderFmSegment(seg) {
    const { orphan, body } = splitOrphanHead(seg);
    const rows = parseFrontmatterTree(body) ||
      parseFrontmatterRows(body).map((r) => ({ key: r.key, node: { type: 'scalar', text: r.value }, lines: r.lines }));

    const out = [];
    if (orphan.length) {
      const text = orphan.map((l) => escapeHtml(l.text.trim())).join('<br>');
      out.push(fmRow('⋯', text, orphan, 'mdsp-fm-cut'));
    }
    for (const r of rows) out.push(fmRow(escapeHtml(r.key), renderFmValue(r.node), r.lines));
    return out.join('');
  }

  function renderFrontmatter(fm) {
    const body = fm.segments.map(renderFmSegment).filter(Boolean).join(FM_GAP_ROW);
    if (!body) return '';

    const where = fm.cutHead && fm.cutTail ? '앞뒤' : (fm.cutHead ? '시작' : '끝');
    const partial = fm.cutHead || fm.cutTail;
    const caption = partial
      ? `<caption>frontmatter 일부 · ${where} 부분이 diff 밖에 있습니다 (왼쪽에서 펼치면 전체로 보입니다)</caption>`
      : '';

    return `<div class="mdsp-block mdsp-fm${partial ? ' mdsp-fm-part' : ''}" data-line="${fm.startLine}">` +
      `<table>${caption}<tbody>${body}</tbody></table></div>`;
  }

  // ── 표 조각 렌더 ─ 시작

  /** `| a | b |` 처럼 파이프로 감싼 표 행. */
  const TABLE_ROW = /^\s*\|.*\|\s*$/;
  /** `|---|:--:|` 같은 헤더 구분선. */
  const TABLE_DELIM = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;

  /** 표 행 한 줄을 셀로 나눈다. `\|` 는 셀 안의 리터럴 파이프다. */
  function splitTableRow(line) {
    const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = [];
    let cur = '';
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '|') { cells.push(cur); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur);
    return cells.map((s) => s.trim());
  }

  /**
   * 표 한가운데 몇 줄만 diff 에 들어오면 헤더 줄과 구분선이 빠져 있어
   * marked 가 문단으로 읽고 `| 셀 | 셀 |` 이 그대로 노출된다.
   * 그런 구간을 찾아 셀로 되돌린다. 표 조각이 아니면 null.
   */
  function parseTableFragment(raw) {
    const lines = raw.replace(/\s+$/, '').split('\n').filter((l) => l.trim());
    if (!lines.length || !lines.every((l) => TABLE_ROW.test(l))) return null;

    const rows = [];
    for (const l of lines) {
      if (TABLE_DELIM.test(l)) continue;   // 헤더는 접히고 구분선만 남은 경우
      const cells = splitTableRow(l);
      if (cells.length < 2) return null;   // 셀이 하나뿐이면 표로 보기 어렵다
      rows.push(cells);
    }
    return rows.length ? rows : null;
  }

  /** 표 조각을 헤더 없는 표로 렌더링한다. 잘린 구간임을 캡션과 점선으로 알린다. */
  function renderTableFragment(rows) {
    const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
    const body = rows
      .map((cells) => {
        let tds = '';
        for (let i = 0; i < width; i++) {
          const src = cells[i] ?? '';
          let cell;
          try { cell = MD.parseInline(src); } catch { cell = escapeHtml(src); }
          tds += `<td>${cell}</td>`;
        }
        return `<tr>${tds}</tr>`;
      })
      .join('');
    return '<table class="mdsp-table-part">' +
      '<caption>표 일부 · 헤더 줄이 diff 밖에 있습니다 (왼쪽에서 펼치면 표 전체로 보입니다)</caption>' +
      `<tbody>${body}</tbody></table>`;
  }

  // ── 표 조각 렌더 ─ 끝

  // ── 잘린 코드펜스 보정 ─ 시작

  /** 코드펜스 한 줄이면 marker 와 컨테이너 prefix 를, 아니면 null 을 돌려준다. */
  function fenceLine(text) {
    let rest = text;
    let quotePrefix = '';
    let quoteDepth = 0;
    for (;;) {
      const q = /^ {0,3}>[ \t]?/.exec(rest);
      if (!q) break;
      quotePrefix += q[0];
      rest = rest.slice(q[0].length);
      quoteDepth++;
    }

    const m = /^( *)((?:`{3,})|(?:~{3,}))(.*)$/.exec(rest);
    if (!m) return null;
    const info = m[3].trim();
    // 백틱 펜스의 info string 에는 백틱이 들어갈 수 없다 (CommonMark)
    if (m[2][0] === '`' && info.includes('`')) return null;
    return {
      marker: m[2], info, quoteDepth, indent: m[1].length,
      prefix: quotePrefix + m[1],
    };
  }

  /** blockquote marker 를 걷어낸 뒤의 내용과 깊이. */
  function quoteLine(text) {
    let rest = text;
    let depth = 0;
    for (;;) {
      const q = /^ {0,3}>[ \t]?/.exec(rest);
      if (!q) break;
      rest = rest.slice(q[0].length);
      depth++;
    }
    return { depth, rest };
  }

  const GAP_LABEL = '⋯ 접힌 구간 (왼쪽 diff에서 펼치면 반영됩니다) ⋯';

  /** fence 가 속한 blockquote/list gap만 raw span으로 바꿔 컨테이너를 보존한다. */
  function preserveQuoteGaps(srcLines, lineNoOf, eligible) {
    const inlineGapAfter = new Set();
    for (const i of eligible) {
      if (i < 1 || i >= srcLines.length - 1) continue;
      if (lineNoOf[i] != null || lineNoOf[i - 1] == null || lineNoOf[i + 1] == null) continue;
      const before = quoteLine(srcLines[i - 1]);
      const after = quoteLine(srcLines[i + 1]);
      if (!before.depth || before.depth !== after.depth) continue;
      const quotePrefix = `${Array(before.depth).fill('>').join(' ')} `;
      const indent = /^ */.exec(after.rest)[0];
      srcLines[i] = quotePrefix + indent + `<span class="mdsp-gap">${GAP_LABEL}</span>`;
      inlineGapAfter.add(lineNoOf[i - 1]);
    }
    return inlineGapAfter;
  }

  /** fence 를 감싸는 가장 가까운 목록 marker 와 content 들여쓰기를 찾는다. */
  function findListContext(srcLines, lineNoOf, at, fence) {
    if (!fence.indent) return null;
    for (let i = at - 1; i >= 0; i--) {
      if (lineNoOf[i] == null) continue;
      const line = quoteLine(srcLines[i]);
      if (line.depth !== fence.quoteDepth) return null;
      if (!line.rest.trim()) continue;
      const indent = /^ */.exec(line.rest)[0].length;
      const list = /^( *)([-+*]|\d{1,9}[.)])( {1,4})/.exec(line.rest);
      if (list) {
        const contentIndent = list[1].length + list[2].length + list[3].length;
        const relative = fence.indent - contentIndent;
        if (relative >= 0 && relative <= 3) return { at: i, contentIndent };
      }
      if (indent === 0) return null;
    }
    return null;
  }

  function closesFence(open, fence) {
    return fence && !fence.info &&
      fence.context === open.context &&
      fence.marker[0] === open.marker[0] &&
      fence.marker.length >= open.marker.length;
  }

  /** 주어진 시작 상태로 scope 를 읽고 changed line 이 코드 안에 드는 정도를 센다. */
  function scoreFenceRun(scope, fences, lineNoOf, changedLines, initial) {
    const fenceAt = new Map(fences.map((f) => [f.i, f]));
    let open = initial ? { ...initial } : null;
    let inside = 0;
    let outside = 0;
    const codeLines = new Set();

    for (let i = scope.start; i <= scope.end; i++) {
      const fence = fenceAt.get(i);
      const changed = changedLines.has(lineNoOf[i]);
      if (open) {
        codeLines.add(i);
        if (changed) inside++;
        if (closesFence(open, fence)) open = null;
      } else if (fence) {
        open = { ...fence };
        codeLines.add(i);
        if (changed) inside++;
      } else if (changed) {
        outside++;
      }
    }

    return { initial, open, score: inside * 2 - outside, codeLines };
  }

  /**
   * diff 조각에는 코드펜스의 한쪽만 들어오는 일이 잦다.
   * 닫는 ``` 만 들어오면 marked 가 그걸 여는 펜스로 읽어 뒤따르는 문서 전체를
   * 코드블록으로 삼켜버린다 (인용문·목록이 원문 그대로 노출된다).
   *
   * 접힌 구간을 경계로 조각마다 실제 CommonMark marker 쌍을 추적하고, 변경 줄이
   * 코드 안에 놓이는 방향을 택해 모자란 펜스를 채운다. srcLines / lineNoOf 를 바꾸고,
   * 채워 넣은 자리를 `{ head, tail }`(인덱스 → 펜스 문자열)로 돌려준다.
   */
  function balanceFences(
    srcLines,
    lineNoOf,
    changedLines = new Set(),
    startsAtFileBeginning = lineNoOf[0] === 1,
  ) {
    const head = new Map();   // 여는 펜스를 채운 자리 — 코드블록의 시작이 diff 밖
    const tail = new Map();   // 닫는 펜스를 채운 자리 — 코드블록의 끝이 diff 밖
    const quoteGaps = new Set();

    // 접힌 구간(lineNoOf 가 null 인 자리)을 경계로 조각을 나눈다
    const segments = [];
    let seg = null;
    for (let i = 0; i < srcLines.length; i++) {
      if (lineNoOf[i] == null) { seg = null; continue; }
      if (seg) seg.end = i;
      else segments.push((seg = { start: i, end: i }));
    }

    // 채워 넣을 자리를 먼저 모은다 (삽입하면서 세면 뒤 조각의 인덱스가 밀린다).
    const plans = [];
    for (const { start, end } of segments) {
      const fences = [];
      for (let i = start; i <= end; i++) {
        const f = fenceLine(srcLines[i]);
        if (!f) continue;
        const list = findListContext(srcLines, lineNoOf, i, f);
        if (f.indent > 3 && !list) continue;
        if (list && f.quoteDepth) {
          for (let j = list.at + 1; j < i; j++) {
            if (lineNoOf[j] == null) quoteGaps.add(j);
          }
        }
        const context = list
          ? `${f.quoteDepth}:list:${list.at}`
          : `${f.quoteDepth}:root`;
        fences.push({ i, ...f, list, context });
      }
      if (!fences.length) continue;

      // 최상위 / blockquote / list continuation 별로 독립된 fence run 을 만든다.
      const scopes = new Map();
      for (const fence of fences) {
        let scopeStart = start;
        let scopeEnd = end;
        if (fence.quoteDepth) {
          scopeStart = fence.i;
          while (scopeStart > start && quoteLine(srcLines[scopeStart - 1]).depth >= fence.quoteDepth) scopeStart--;
          scopeEnd = fence.i;
          while (scopeEnd < end && quoteLine(srcLines[scopeEnd + 1]).depth >= fence.quoteDepth) scopeEnd++;
        }
        const key = `${fence.context}:${scopeStart}:${scopeEnd}`;
        const scope = scopes.get(key) || {
          start: scopeStart, end: scopeEnd, fences: [],
          rank: fence.quoteDepth * 100 + (fence.list ? 1 : 0),
        };
        scope.fences.push(fence);
        scopes.set(key, scope);
      }

      const protectedLines = new Set();
      const orderedScopes = [...scopes.values()].sort((a, b) =>
        a.start - b.start || a.rank - b.rank || b.end - a.end);
      for (const scope of orderedScopes) {
        scope.fences = scope.fences.filter((fence) => !protectedLines.has(fence.i));
        if (!scope.fences.length) continue;
        const natural = scoreFenceRun(scope, scope.fences, lineNoOf, changedLines, null);
        const candidates = [natural];
        for (const fence of scope.fences) {
          if (fence.info) continue;
          candidates.push(scoreFenceRun(scope, scope.fences, lineNoOf, changedLines, {
            marker: fence.marker, prefix: fence.prefix, context: fence.context,
          }));
        }

        const first = scope.fences[0];
        const fallbackHead = !first.info && first.i > scope.start &&
          srcLines[first.i - 1].trim() &&
          srcLines.slice(scope.start, first.i).some((line) => line.trim());
        const previous = first.i > scope.start ? quoteLine(srcLines[first.i - 1]) : null;
        const next = first.i < scope.end ? quoteLine(srcLines[first.i + 1]) : null;
        const blankBefore = previous && previous.depth === first.quoteDepth && !previous.rest.trim();
        const contentAfter = scope.fences.length === 1 && !first.list && first.quoteDepth === 0 &&
          next && next.depth === first.quoteDepth && next.rest.trim();
        const visibleOpener = first.info || blankBefore || contentAfter;
        if (natural.open && !visibleOpener) {
          candidates.sort((a, b) => {
            if (a.score !== b.score) return b.score - a.score;
            const aBias = (!a.initial && first.info) || (a.initial && fallbackHead) ? 1 : 0;
            const bBias = (!b.initial && first.info) || (b.initial && fallbackHead) ? 1 : 0;
            if (aBias !== bBias) return bBias - aBias;
            const aSynthetic = (a.initial ? 1 : 0) + (a.open ? 1 : 0);
            const bSynthetic = (b.initial ? 1 : 0) + (b.open ? 1 : 0);
            if (aSynthetic !== bSynthetic) return aSynthetic - bSynthetic;
            if (!!a.initial !== !!b.initial) return a.initial ? 1 : -1;
            return 0;   // 애매하면 앞 문서를 코드로 뒤집지 않는다
          });
        }

        // 파일 1번 줄 앞에는 숨은 opener 가 있을 수 없다. 그 밖의 잘린 조각만
        // 변경 줄 점수로 방향을 고르고, 완전한 문서를 부분 블록으로 뒤집지 않는다.
        const canHaveHiddenOpener = lineNoOf[scope.start] !== 1 &&
          !(startsAtFileBeginning && start === 0);
        const chosen = natural.open && !visibleOpener && canHaveHiddenOpener
          ? candidates[0]
          : natural;
        for (const i of chosen.codeLines) protectedLines.add(i);
        if (chosen.initial) {
          plans.push({
            at: scope.start,
            line: chosen.initial.prefix + chosen.initial.marker,
            marker: chosen.initial.marker,
            map: head,
          });
        }
        if (chosen.open) {
          plans.push({
            at: scope.end + 1,
            line: chosen.open.prefix + chosen.open.marker,
            marker: chosen.open.marker,
            map: tail,
          });
        }
      }
    }

    const inlineGapAfter = preserveQuoteGaps(srcLines, lineNoOf, quoteGaps);

    // 앞에서부터 넣으면서 그만큼 뒤 자리를 민다
    plans.sort((a, b) => a.at - b.at);
    let shift = 0;
    for (const p of plans) {
      const at = p.at + shift;
      srcLines.splice(at, 0, p.line);
      lineNoOf.splice(at, 0, null);
      p.map.set(at, p.marker);
      shift++;
    }
    return { head, tail, inlineGapAfter };
  }

  /** 중첩 blockquote/list token 안에 들어간 합성 fence 도 찾는다. */
  function cutInRange(map, start, end) {
    for (const [at, marker] of map) {
      if (at >= start && at <= end) return { at, marker };
    }
    return null;
  }

  function cutMarkerInRange(map, start, end) {
    return cutInRange(map, start, end)?.marker ?? null;
  }

  /**
   * 토큰 범위에 걸친 cut 을 원문 순서대로 **전부** 모은다.
   * 인용문·목록 하나가 조각을 둘 이상 품을 수 있어, 한 건만 보면 나머지 조각은
   * `코드블록 일부` 안내도 없이 온전한 블록처럼 지나간다 (mermaid 는 그걸 그려버린다).
   */
  function partCutsInRange(head, tail, start, end) {
    const out = [];
    for (const [at, marker] of head) {
      if (at >= start && at <= end) out.push({ at, marker, where: '여는' });
    }
    for (const [at, marker] of tail) {
      if (at >= start && at <= end) out.push({ at, marker, where: '닫는' });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  function countCodeTokens(tokens) {
    let count = 0;
    const visit = (token) => {
      if (token.type === 'code') count++;
      for (const child of token.tokens || []) visit(child);
      for (const item of token.items || []) {
        for (const child of item.tokens || []) visit(child);
      }
    };
    for (const token of tokens || []) visit(token);
    return count;
  }

  function findCodeToken(tokens, ordinal) {
    let seen = 0;
    let found = null;
    const visit = (token) => {
      if (found) return;
      if (token.type === 'code' && ++seen === ordinal) { found = token; return; }
      for (const child of token.tokens || []) visit(child);
      for (const item of token.items || []) {
        for (const child of item.tokens || []) visit(child);
      }
    };
    for (const token of tokens || []) visit(token);
    return found;
  }

  /** marked 가 방금 렌더한 fenced-code HTML 하나에 안내와 점선을 붙인다. */
  function renderCodePart(html, marker, where) {
    const note =
      `<div class="mdsp-part-note">코드블록 일부 · ${where} <code>${marker}</code> 줄이 diff 밖에 있습니다 ` +
      '(왼쪽에서 펼치면 전체로 보입니다)</div>';
    return '<div class="mdsp-code-part">' + note + html + '</div>';
  }

  // ── 잘린 코드펜스 보정 ─ 끝

  /** 복원된 라인들을 렌더링한다. 각 블록에 원본 라인번호(data-line)가 붙는다. */
  function renderBlocks(lines) {
    if (!lines.length) return '<div class="mdsp-empty">렌더링할 마크다운 내용이 없습니다.</div>';

    const out = [];
    const startsAtFileBeginning = lines[0].n === 1;

    // frontmatter 를 먼저 표로 뽑아내고, 나머지 본문만 마크다운으로 렌더링한다
    const fm = extractFrontmatter(lines);
    if (fm) {
      const html = renderFrontmatter(fm);
      if (html) out.push(html);
      lines = fm.rest;
      if (!lines.length) return `<div class="markdown-body">${out.join('\n')}</div>`;
    }

    const srcLines = [];   // 렌더러에 넘길 줄
    const lineNoOf = [];   // srcLines[i] 의 원본 라인번호(접힌 구간 자리는 null)
    const gapAfter = new Set();

    // frontmatter 뒤 첫 body hunk가 연속이 아니면 선행 gap도 펜스 방향 판단에 남긴다.
    let prev = fm?.endLine ?? null;
    for (const l of lines) {
      if (prev !== null && l.n > prev + 1) {
        gapAfter.add(prev);
        srcLines.push('');
        lineNoOf.push(null);
      }
      srcLines.push(l.text);
      lineNoOf.push(l.n);
      prev = l.n;
    }

    const addedSet = new Set(lines.filter((l) => l.added).map((l) => l.n));

    // 한쪽 펜스가 diff 밖인 코드블록을 먼저 닫아둔다 (안 그러면 뒤 문서를 통째로 삼킨다)
    const cut = balanceFences(srcLines, lineNoOf, addedSet, startsAtFileBeginning);
    for (const n of cut.inlineGapAfter) gapAfter.delete(n);

    let tokens;
    try {
      tokens = MD.lexer(srcLines.join('\n'));
    } catch (e) {
      return `<pre class="mdsp-empty">렌더링 실패: ${escapeHtml(e.message)}</pre>`;
    }

    let offset = 0;

    for (const token of tokens) {
      const raw = token.raw ?? '';
      const nlCount = (raw.match(/\n/g) || []).length;
      // 블록이 실제로 차지하는 범위는 뒤따르는 빈 줄을 뺀 부분이다.
      // (빈 줄까지 포함하면 "블록 뒤에 빈 줄만 추가된" 경우가 변경으로 잘못 강조된다)
      const innerNl = (raw.replace(/\s*$/, '').match(/\n/g) || []).length;
      const start = offset;
      const end = start + innerNl;
      offset += nlCount;

      if (token.type === 'space') continue;

      let startLine = null;
      let endLine = null;
      let changed = false;
      for (let i = start; i <= Math.min(end, lineNoOf.length - 1); i++) {
        const n = lineNoOf[i];
        if (n == null) continue;
        if (startLine == null) startLine = n;
        endLine = n;
        if (addedSet.has(n)) changed = true;
      }

      // 조각마다 해당 code token 을 찾아둔다. 같은 token 에 두 cut 이 걸리면 앞선 쪽을 남긴다.
      const partOf = new Map();
      for (const partCut of partCutsInRange(cut.head, cut.tail, start, end)) {
        try {
          const prefix = MD.lexer(srcLines.slice(start, partCut.at + 1).join('\n'));
          const codeToken = findCodeToken([token], countCodeTokens(prefix));
          if (codeToken && !partOf.has(codeToken)) partOf.set(codeToken, partCut);
        } catch { /* 본문 렌더는 유지하고 부분 안내만 생략한다 */ }
      }

      let html = '';
      const fragment = token.type === 'paragraph' || token.type === 'text'
        ? parseTableFragment(raw)
        : null;
      if (fragment) {
        html = renderTableFragment(fragment);
      } else {
        try {
          const sub = [token];
          sub.links = tokens.links || {};
          if (partOf.size) {
            const renderer = new MD.Renderer();
            const renderCode = renderer.code;
            renderer.code = function (codeToken) {
              const rendered = renderCode.call(this, codeToken);
              const partCut = partOf.get(codeToken);
              return partCut
                ? renderCodePart(rendered, partCut.marker, partCut.where)
                : rendered;
            };
            html = applyAlerts(MD.parser(sub, { renderer }));
          } else {
            html = applyAlerts(MD.parser(sub));
          }
        } catch {
          html = `<pre>${escapeHtml(raw)}</pre>`;
        }
      }
      if (!html.trim()) continue;

      out.push(
        `<div class="mdsp-block"${startLine != null ? ` data-line="${startLine}"` : ''}` +
          `${changed ? ' data-changed="1"' : ''}>${html}</div>`
      );

      if (endLine != null && gapAfter.has(endLine)) {
        out.push(`<div class="mdsp-gap">${GAP_LABEL}</div>`);
        gapAfter.delete(endLine);
      }
    }

    return `<div class="markdown-body">${out.join('\n')}</div>`;
  }

  // ── mermaid 다이어그램 ─ 시작

  /**
   * 아직 다이어그램으로 바꾸지 않은 mermaid 코드블록을 모은다.
   * 펜스가 diff 밖이라 조각만 남은 블록(.mdsp-code-part)은 문법이 온전하지 않아,
   * 그려봤자 실제 문서와 다른 그림이 되므로 코드블록 그대로 둔다.
   */
  function mermaidTargets(root) {
    const out = [];
    for (const code of root.querySelectorAll('pre > code.language-mermaid')) {
      const pre = code.parentElement;
      if (!pre || pre.dataset.mdspMermaid) continue;
      if (pre.closest('.mdsp-code-part')) continue;
      const src = (code.textContent || '').trim();
      if (!src) continue;
      out.push({ pre, src });
    }
    return out;
  }

  /** GitHub 의 현재 색상 모드를 mermaid 테마 이름으로 옮긴다. */
  function mermaidThemeName(rootEl, prefersDark) {
    const mode = rootEl?.getAttribute('data-color-mode') || 'auto';
    const dark = mode === 'dark' || (mode !== 'light' && !!prefersDark);
    const named = rootEl?.getAttribute(dark ? 'data-dark-theme' : 'data-light-theme') || '';
    // GitHub 테마 이름은 dark_dimmed / light_high_contrast 처럼 밝기가 앞에 온다
    return (named ? /^dark/.test(named) : dark) ? 'dark' : 'default';
  }

  /** mermaid 파싱 오류 메시지는 여러 줄이라 배지에 넣을 첫 줄만 남긴다. */
  function mermaidErrorText(err) {
    const first = String(err?.message || err || '')
      .split('\n').map((s) => s.trim()).find(Boolean) || '';
    return first.length > 100 ? `${first.slice(0, 99)}…` : first;
  }

  const MERMAID = typeof mermaid !== 'undefined'
    ? mermaid
    : (typeof window !== 'undefined' ? window.mermaid : null);
  let mermaidSeq = 0;
  let mermaidTheme = '';
  let mermaidWarned = false;

  /**
   * 그려낸 SVG 를 `테마\n소스` 로 기억한다.
   * rerender 는 우측 innerHTML 을 통째로 새로 채우므로 pre 의 완료 표시도 함께 사라져,
   * 캐시가 없으면 Expand 마다 같은 다이어그램을 처음부터 다시 그린다.
   * 같은 소스가 한 문서에 두 번 나오면 SVG 내부 id 도 같아지지만, 정의가 바이트 단위로
   * 같아 `url(#…)` 이 어느 쪽을 잡아도 결과가 같다.
   */
  const mermaidCache = new Map();
  const MERMAID_CACHE_MAX = 64;

  /** 그려낸 SVG 를 코드블록 자리에 끼운다. */
  function placeMermaid(pre, svg) {
    const box = document.createElement('div');
    box.className = 'mdsp-mermaid';
    box.innerHTML = svg;
    pre.replaceWith(box);
  }

  /** 현재 색상 모드에 맞춰 mermaid 를 준비한다. 없으면 null — 호출부는 코드블록 그대로 둔다. */
  function ensureMermaid() {
    if (!MERMAID) {
      if (!mermaidWarned) {
        mermaidWarned = true;
        console.warn('[md-split] mermaid 로드 실패 — 다이어그램은 코드블록으로 표시됩니다.');
      }
      return null;
    }
    const theme = mermaidThemeName(
      document.documentElement,
      window.matchMedia?.('(prefers-color-scheme: dark)').matches
    );
    if (theme !== mermaidTheme) {
      mermaidTheme = theme;
      MERMAID.initialize({
        startOnLoad: false,
        theme,
        securityLevel: 'strict',
        // 실패한 자리는 우리가 코드블록으로 되돌리므로 mermaid 쪽 에러 그림은 끈다
        suppressErrorRendering: true,
      });
    }
    return MERMAID;
  }

  /**
   * 우측 패널의 mermaid 코드블록을 SVG 로 바꾼다.
   * 다이어그램만큼 높이가 늘어나므로 하나라도 그렸으면 스크롤 앵커를 다시 잡는다.
   */
  async function renderMermaid(view) {
    if (!view.right) return; // 그리기 직전에 2단이 꺼진 경우
    const targets = mermaidTargets(view.right);
    if (!targets.length) return;

    const theme = mermaidThemeName(
      document.documentElement,
      window.matchMedia?.('(prefers-color-scheme: dark)').matches
    );

    // 이미 그려본 것은 첫 await 전에 끼운다 — 그러지 않으면 rerender 뒤 한 프레임 동안
    // 그 자리가 mermaid 소스 코드블록으로 보인다.
    const pending = [];
    let cached = false;
    for (const { pre, src } of targets) {
      const svg = mermaidCache.get(`${theme}\n${src}`);
      if (svg === undefined) { pending.push({ pre, src }); continue; }
      pre.dataset.mdspMermaid = 'done';
      placeMermaid(pre, svg);
      cached = true;
    }
    if (cached) view.invalidateAnchors?.();
    if (!pending.length) return;

    const lib = ensureMermaid();
    if (!lib) return;

    const gen = view.renderGen;
    let drawn = false;
    for (const { pre, src } of pending) {
      // 그리는 사이에 diff 가 바뀌어 다시 렌더링됐으면 낡은 결과를 붙이지 않는다
      if (view.renderGen !== gen || !pre.isConnected) break;
      pre.dataset.mdspMermaid = 'done';
      const id = `mdsp-mermaid-${++mermaidSeq}`;
      try {
        const { svg } = await lib.render(id, src);
        if (mermaidCache.size >= MERMAID_CACHE_MAX) {
          mermaidCache.delete(mermaidCache.keys().next().value);
        }
        mermaidCache.set(`${theme}\n${src}`, svg);
        if (view.renderGen !== gen || !pre.isConnected) break;
        placeMermaid(pre, svg);
        drawn = true;
      } catch (e) {
        if (view.renderGen !== gen || !pre.isConnected) break;
        const why = mermaidErrorText(e);
        const note = document.createElement('div');
        note.className = 'mdsp-mermaid-note';
        note.textContent = `mermaid 문법 오류로 그리지 못했습니다${why ? ` · ${why}` : ''}`;
        pre.before(note);
        drawn = true;
      } finally {
        // 실패했을 때 mermaid 가 body 에 남기는 측정용 임시 노드를 치운다
        document.getElementById(`d${id}`)?.remove();
      }
    }
    if (drawn) view.invalidateAnchors?.();
  }

  // ── mermaid 다이어그램 ─ 끝

  // ────────────────────────────────────────────────────────────── 스크롤 동기화

  /** 패널 안 요소들의 [라인번호, 패널 내부 오프셋] 앵커를 만든다. */
  function buildAnchors(panel, selector, getLine) {
    const anchors = [];
    const panelTop = panel.getBoundingClientRect().top - panel.scrollTop;
    for (const el of panel.querySelectorAll(selector)) {
      const line = getLine(el);
      if (!Number.isFinite(line)) continue;
      const top = el.getBoundingClientRect().top - panelTop;
      const last = anchors[anchors.length - 1];
      if (last && last[0] === line) continue;
      anchors.push([line, top]);
    }
    return anchors.sort((a, b) => a[0] - b[0]);
  }

  /** xi=0 이면 라인→오프셋, xi=1 이면 오프셋→라인 으로 선형 보간한다. */
  function interpolate(anchors, x, xi) {
    if (!anchors.length) return null;
    const yi = xi === 0 ? 1 : 0;
    if (x <= anchors[0][xi]) return anchors[0][yi];
    if (x >= anchors[anchors.length - 1][xi]) return anchors[anchors.length - 1][yi];

    let lo = 0;
    let hi = anchors.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid][xi] <= x) lo = mid;
      else hi = mid;
    }
    const ax = anchors[lo][xi], ay = anchors[lo][yi];
    const bx = anchors[hi][xi], by = anchors[hi][yi];
    return bx === ax ? ay : ay + ((x - ax) / (bx - ax)) * (by - ay);
  }

  function attachSync(view) {
    const { left, right } = view;
    let leftAnchors = null;
    let rightAnchors = null;
    let syncing = false;
    let rafId = 0;

    view.invalidateAnchors = () => { leftAnchors = null; rightAnchors = null; };

    const ensure = () => {
      if (!leftAnchors) {
        leftAnchors = buildAnchors(left, 'tr.diff-line-row, tr[class*=diff-line]', (tr) => {
          const cells = [...tr.querySelectorAll('td.diff-text-cell, td.blob-code')].filter(
            (c) => !c.classList.contains('hunk') && !c.classList.contains('blob-code-hunk')
          );
          if (!cells.length) return NaN;
          const cell = cells[cells.length - 1];
          const mk = cell.querySelector('.diff-text-marker');
          if (mk && mk.textContent.trim() === '-') return NaN;
          const n = newLineNumber(cell, tr);
          if (Number.isFinite(n)) return n;
          return parseInt(cell.previousElementSibling?.getAttribute('data-line-number') ?? '', 10);
        });
      }
      if (!rightAnchors) {
        rightAnchors = buildAnchors(right, '.mdsp-block[data-line]', (el) =>
          parseInt(el.getAttribute('data-line'), 10)
        );
      }
    };

    const sync = (from, to, getFrom, getTo) => {
      if (syncing) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        ensure();
        const a = getFrom();
        const b = getTo();
        if (!a?.length || !b?.length) return;
        const line = interpolate(a, from.scrollTop, 1);
        if (line == null) return;
        const top = interpolate(b, line, 0);
        if (top == null) return;
        syncing = true;
        to.scrollTop = Math.max(0, top);
        requestAnimationFrame(() => { syncing = false; });
      });
    };

    left.addEventListener('scroll', () => sync(left, right, () => leftAnchors, () => rightAnchors), { passive: true });
    right.addEventListener('scroll', () => sync(right, left, () => rightAnchors, () => leftAnchors), { passive: true });
    window.addEventListener('resize', view.invalidateAnchors, { passive: true });
  }

  // ──────────────────────────────────────────────────────────── 파일 블록 처리

  const views = new WeakMap();

  // GitHub 은 파일명을 U+200E(LTR mark) 등 방향 제어문자로 감싸서 내려준다.
  // 이 문자들을 정규식에 리터럴로 적으면 소스 파일 자체에 bidi 제어문자가 섞여
  // GitHub 이 "hidden Unicode text"(Trojan Source) 경고를 띄우므로, 코드포인트로만 비교한다.
  const isInvisibleCp = (cp) =>
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space ~ RLM
    (cp >= 0x202a && cp <= 0x202e) || // bidi embedding / override
    (cp >= 0x2066 && cp <= 0x2069) || // bidi isolate
    cp === 0xfeff;                    // BOM
  const cleanPath = (s) =>
    [...String(s || '')].filter((ch) => !isInvisibleCp(ch.codePointAt(0))).join('').trim();

  function getFilePath(fileEl) {
    const candidates = [
      fileEl.querySelector('[class*="DiffFileHeader-module__file-name"]')?.textContent,
      fileEl.getAttribute('data-tagsearch-path'),
      fileEl.getAttribute('data-path'),
      fileEl.querySelector('[data-testid="file-name"]')?.textContent,
      fileEl.querySelector('a[title]')?.getAttribute('title'),
      fileEl.querySelector('.file-info a')?.textContent,
      // 마지막 수단: 헤더 영역의 텍스트에서 경로처럼 보이는 토큰을 찾는다
      fileEl.querySelector('[class*="DiffFileHeader"]')?.textContent,
    ];
    for (const c of candidates) {
      const v = cleanPath(c);
      if (v && MD_EXT.test(v)) return v;
    }
    return cleanPath(candidates.find(Boolean));
  }

  /** 2단으로 감쌀 대상(= diff 표를 담은 컨테이너)을 찾는다. */
  function findContentEl(fileEl) {
    const table = fileEl.querySelector('table');
    if (table) {
      // 표를 직접 감싸는 박스가 있으면 그것을, 없으면 표 자체를 옮긴다
      const box = table.parentElement;
      if (box && box !== fileEl && box.children.length === 1) return box;
      return table;
    }
    return fileEl.querySelector('.js-file-content');
  }

  function rerender(view) {
    const lines = extractAfterLines(view.left);
    view.renderGen = (view.renderGen || 0) + 1;
    view.right.innerHTML = renderBlocks(lines);
    view.invalidateAnchors?.();
    // 다이어그램은 비동기라 본문보다 늦게 들어온다. 실패해도 본문 렌더는 그대로 둔다.
    renderMermaid(view).catch((e) => console.warn('[md-split] mermaid 렌더 실패', e));
    if (view.note) {
      const changed = lines.filter((l) => l.added).length;
      // split diff 위에 2단을 얹으면 사실상 4단이 되어 너무 좁아진다
      const isSplit = isSplitDiff(view.left);
      view.note.textContent =
        (lines.length ? `${lines.length}줄 · 추가 ${changed}줄` : '') +
        (isSplit ? '  ⚠︎ Unified diff 에서 보는 걸 권합니다' : '');
    }
  }

  const applyRatio = (view) => {
    view.left.style.flexBasis = `calc(${(cfg.ratio * 100).toFixed(2)}% - 2.5px)`;
  };

  function enableSplit(view) {
    if (view.wrap?.isConnected) return;
    const { contentEl } = view;
    if (!contentEl?.isConnected) return;

    const wrap = document.createElement('div');
    wrap.className = 'mdsp-wrap';
    const left = document.createElement('div');
    left.className = 'mdsp-left';
    const resizer = document.createElement('div');
    resizer.className = 'mdsp-resizer';
    const right = document.createElement('div');
    right.className = 'mdsp-right';

    contentEl.parentNode.insertBefore(wrap, contentEl);
    left.appendChild(contentEl);
    wrap.append(left, resizer, right);

    Object.assign(view, { wrap, left, right, resizer });
    applyRatio(view);
    rerender(view);
    attachSync(view);

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.classList.add('mdsp-resizing');
      const onMove = (ev) => {
        const rect = wrap.getBoundingClientRect();
        cfg.ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width));
        applyRatio(view);
        view.invalidateAnchors?.();
      };
      const onUp = () => {
        document.body.classList.remove('mdsp-resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // Expand 등으로 diff 내용이 바뀌면 다시 렌더링
    const obs = new MutationObserver(() => {
      clearTimeout(view.reTimer);
      view.reTimer = setTimeout(() => view.wrap?.isConnected && rerender(view), 200);
    });
    obs.observe(left, { childList: true, subtree: true });
    view.diffObserver = obs;
  }

  function disableSplit(view) {
    if (!view.wrap) return;
    view.diffObserver?.disconnect();
    view.diffObserver = null;
    if (view.wrap.isConnected && view.contentEl) {
      view.wrap.parentNode.insertBefore(view.contentEl, view.wrap);
    }
    view.wrap.remove();
    view.wrap = view.left = view.right = view.resizer = null;
  }

  function setupFile(fileEl) {
    const existing = views.get(fileEl);
    if (existing) {
      // React 가 다시 그려 우리 DOM 이 떨어져 나갔으면 복구한다
      if (existing.on && !existing.wrap?.isConnected) {
        existing.contentEl = findContentEl(fileEl);
        enableSplit(existing);
      }
      return 'already';
    }

    const path = getFilePath(fileEl);
    if (!MD_EXT.test(path)) return 'not-md';
    if (!fileEl.querySelector('tr.diff-line-row, [data-code-marker]')) return 'not-rendered-yet';

    const contentEl = findContentEl(fileEl);
    if (!contentEl) {
      log('표를 찾지 못함', path);
      return 'no-table';
    }

    const bar = document.createElement('div');
    bar.className = 'mdsp-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mdsp-btn';
    btn.textContent = '⇄ 렌더링 나란히 보기';
    const note = document.createElement('span');
    note.className = 'mdsp-note';
    bar.append(btn, note);
    contentEl.parentNode.insertBefore(bar, contentEl);

    const view = { fileEl, contentEl, path, bar, btn, note, on: false };
    views.set(fileEl, view);

    const applyState = (on) => {
      view.on = on;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) enableSplit(view);
      else { disableSplit(view); note.textContent = ''; }
    };

    btn.addEventListener('click', () => {
      const next = btn.getAttribute('aria-pressed') !== 'true';
      cfg.enabled = next;
      applyState(next);
    });

    applyState(cfg.enabled);
    return 'attached';
  }

  // ───────────────────────────────────────────────────────────────── 스캔 루프

  let lastReport = '';

  function findFileElements(root = document) {
    const files = new Set(root.querySelectorAll(
      'div[id^="diff-"][class*="Diff-module__diffTargetable"], div.file[data-tagsearch-path], div.js-file'
    ));

    // 최신 React diff 는 파일 wrapper 에 id/data-path 없이 role=region 만 둔다.
    // 실제 diff row 에서 aria-labelledby region 으로 올라가 파일 단위를 복원한다.
    for (const row of root.querySelectorAll('tr.diff-line-row')) {
      const region = row.closest('div[role="region"][aria-labelledby]');
      if (region) files.add(region);
    }
    return [...files];
  }

  function isSplitDiff(root) {
    for (const row of root.querySelectorAll('tr.diff-line-row, tr[class*=diff-line]')) {
      const cells = [...row.querySelectorAll('td.diff-text-cell, td.blob-code')].filter(
        (cell) => !cell.classList.contains('hunk') && !cell.classList.contains('blob-code-hunk')
      );
      if (cells.length > 1) return true;
    }
    return false;
  }

  function scan() {
    const files = findFileElements();
    const tally = {};
    for (const el of files) {
      try {
        const r = setupFile(el) ?? 'attached';
        tally[r] = (tally[r] || 0) + 1;
      } catch (e) {
        tally.error = (tally.error || 0) + 1;
        console.warn('[md-split] 처리 실패', e);
      }
    }
    // 상태가 바뀔 때만 한 줄 남긴다 (안 뜰 때 원인을 콘솔에서 바로 볼 수 있도록)
    const report = `파일 ${files.length} · ${Object.entries(tally).map(([k, v]) => `${k}:${v}`).join(' ') || '없음'}`;
    if (report !== lastReport) {
      lastReport = report;
      console.info('[md-split]', report);
    }
  }

  let scanTimer = 0;
  const scheduleScan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  };

  scheduleScan();

  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.closest?.('.mdsp-right, .mdsp-bar')) continue; // 우리가 만든 DOM 은 무시
        scheduleScan();
        return;
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener('turbo:render', scheduleScan);
  document.addEventListener('pjax:end', scheduleScan);
})();
