// ==UserScript==
// @name         GitHub MD Split Preview
// @namespace    https://github.com/lucidash
// @version      2.3.1
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
 *
 * 지원 DOM
 * --------
 * - 현행 React diff  : tr.diff-line-row / td.diff-text-cell / .diff-text-inner / data-diff-line-key
 * - 구형 Rails diff  : [data-code-marker] / td.blob-num[data-line-number]  (GHE 등 폴백)
 *
 * 한계
 * ----
 * - GitHub 이 접어둔 구간은 diff DOM 에 없으므로 렌더링에서도 빠진다(Expand 하면 자동 반영).
 * - mermaid 등 GitHub 전용 위젯은 코드블록 그대로 표시된다.
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
    .mdsp-right .markdown-body .mdsp-fm tr[data-changed="1"] {
      background: var(--bgColor-success-muted, rgba(46,160,67,.10));
    }
    .mdsp-right .markdown-body .mdsp-fm tr[data-changed="1"] td:first-child {
      box-shadow: inset 3px 0 0 var(--bgColor-success-emphasis, #238636);
    }

    .mdsp-gap {
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

  /**
   * 파일 맨 앞의 YAML frontmatter 구간을 떼어낸다.
   * marked 는 `---` 를 setext heading 으로 읽어 frontmatter 를 거대한 제목으로 만들기 때문에,
   * GitHub 처럼 표로 따로 렌더링한다.
   */
  function extractFrontmatter(lines) {
    // 파일 1번 줄부터 시작하는 `---` 만 frontmatter 로 인정한다
    if (!lines.length || lines[0].n !== 1 || lines[0].text.trim() !== '---') return null;

    let close = -1;
    for (let i = 1; i < lines.length; i++) {
      // 접힌 구간이 끼어 있으면 닫는 줄을 신뢰할 수 없다
      if (lines[i].n !== lines[i - 1].n + 1) return null;
      if (lines[i].text.trim() === '---') { close = i; break; }
    }
    if (close === -1) return null;

    return { body: lines.slice(1, close), rest: lines.slice(close + 1), endLine: lines[close].n };
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

  function renderFrontmatter(fm) {
    const rows = parseFrontmatterRows(fm.body);
    if (!rows.length) return '';
    const body = rows
      .map((r) => {
        const changed = r.lines.some((l) => l.added);
        return `<tr${changed ? ' data-changed="1"' : ''}>` +
          `<td>${escapeHtml(r.key)}</td><td>${escapeHtml(r.value)}</td></tr>`;
      })
      .join('');
    return `<div class="mdsp-block mdsp-fm" data-line="1"><table><tbody>${body}</tbody></table></div>`;
  }

  /** 복원된 라인들을 렌더링한다. 각 블록에 원본 라인번호(data-line)가 붙는다. */
  function renderBlocks(lines) {
    if (!lines.length) return '<div class="mdsp-empty">렌더링할 마크다운 내용이 없습니다.</div>';

    const out = [];

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

    let prev = null;
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

      let html = '';
      try {
        const sub = [token];
        sub.links = tokens.links || {};
        html = applyAlerts(MD.parser(sub));
      } catch {
        html = `<pre>${escapeHtml(raw)}</pre>`;
      }
      if (!html.trim()) continue;

      out.push(
        `<div class="mdsp-block"${startLine != null ? ` data-line="${startLine}"` : ''}` +
          `${changed ? ' data-changed="1"' : ''}>${html}</div>`
      );

      if (endLine != null && gapAfter.has(endLine)) {
        out.push('<div class="mdsp-gap">⋯ 접힌 구간 (왼쪽 diff에서 펼치면 반영됩니다) ⋯</div>');
        gapAfter.delete(endLine);
      }
    }

    return `<div class="markdown-body">${out.join('\n')}</div>`;
  }

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
    view.right.innerHTML = renderBlocks(lines);
    view.invalidateAnchors?.();
    if (view.note) {
      const changed = lines.filter((l) => l.added).length;
      // split diff 위에 2단을 얹으면 사실상 4단이 되어 너무 좁아진다
      const isSplit = !!view.left.querySelector('td.diff-text-cell + td.diff-text-cell, td.left-side-diff-cell');
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

  function scan() {
    const files = document.querySelectorAll(
      'div[id^="diff-"][class*="Diff-module__diffTargetable"], div.file[data-tagsearch-path], div.js-file'
    );
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
