#!/usr/bin/env node
/**
 * vendor/mermaid.min.js 를 새로 받아 Tampermonkey 에서 쓸 수 있게 고친다.
 *
 * 왜 vendoring 하나
 * ----------------
 * mermaid 의 브라우저 번들은 최상위에 `var __esbuild_esm_mermaid_nm` 을 두고, 마지막
 * 줄에서 그걸 `globalThis.__esbuild_esm_mermaid_nm` 으로 되읽어 전역 `mermaid` 를 만든다.
 * 일반 페이지 <script> 에서는 최상위 var 가 globalThis 프로퍼티가 되니 동작하지만,
 * Tampermonkey 는 @require 내용을 **함수 스코프**에서 실행하므로 그 var 가 지역변수가
 * 되고 마지막 줄이 undefined 를 읽어 터진다.
 *
 *   TypeError: Cannot read properties of undefined (reading 'mermaid')
 *
 * 11.x 전 릴리스가 같은 형태라 버전 핀으로는 못 피하고, 번들이 "use strict" 로 시작해
 * `@resource` + 간접 eval 로도 우회할 수 없다(strict eval 은 var 를 전역에 올리지 않는다).
 * 그래서 마지막 줄의 `globalThis.` 접두어만 떼어 지역 var 를 읽게 한 사본을 저장소에 둔다.
 *
 * 사용법
 * -----
 *   node tools/vendor-mermaid.mjs            # lock 에 적힌 버전으로 재생성
 *   node tools/vendor-mermaid.mjs 11.17.0    # 특정 버전으로 갱신
 *
 * 업스트림이 wrapper 를 또 바꾸면 아래 KNOWN_TAILS 에 걸리지 않아 **시끄럽게 실패**한다.
 * 조용히 깨진 사본을 만들지 않으려는 의도이므로, 그때는 새 형태를 확인하고 표에 추가한다.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_FILE = join(ROOT, 'vendor', 'mermaid.min.js');
const LOCK_FILE = join(ROOT, 'vendor', 'mermaid.lock.json');

/** 지금까지 관측한 전역 노출 줄. 왼쪽을 오른쪽으로 바꾸면 지역 var 를 읽는다. */
const KNOWN_TAILS = [
  {
    before: 'globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;',
    after: 'globalThis["mermaid"] = __esbuild_esm_mermaid_nm["mermaid"].default;',
    seenIn: '11.7.0 ~',
  },
  {
    before: 'globalThis.mermaid = globalThis.__esbuild_esm_mermaid.default;',
    after: 'globalThis.mermaid = __esbuild_esm_mermaid.default;',
    seenIn: '11.0.2 ~ 11.6.0',
  },
];

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

async function lockedVersion() {
  try {
    return JSON.parse(await readFile(LOCK_FILE, 'utf8')).version;
  } catch {
    return null;
  }
}

const version = process.argv[2] || (await lockedVersion());
if (!version) {
  console.error('버전을 알 수 없습니다. `node tools/vendor-mermaid.mjs <version>` 으로 지정하세요.');
  process.exit(2);
}

const url = `https://cdn.jsdelivr.net/npm/mermaid@${version}/dist/mermaid.min.js`;
console.log(`받는 중: ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`내려받기 실패: HTTP ${res.status}`);
  process.exit(1);
}
const upstream = await res.text();

const match = KNOWN_TAILS.find((t) => upstream.includes(t.before));
if (!match) {
  console.error(
    'mermaid 번들의 전역 노출 형태를 알아볼 수 없습니다.\n' +
      '업스트림이 wrapper 를 바꿨을 수 있습니다. 마지막 줄을 확인하고 KNOWN_TAILS 에 추가하세요.\n' +
      `마지막 줄: ${upstream.trimEnd().split('\n').at(-1)?.slice(0, 200)}`,
  );
  process.exit(1);
}
const hits = upstream.split(match.before).length - 1;
if (hits !== 1) {
  console.error(`전역 노출 줄이 ${hits}번 나옵니다. 1번이어야 안전하게 치환할 수 있습니다.`);
  process.exit(1);
}

const patched = upstream.replace(match.before, match.after);

await mkdir(join(ROOT, 'vendor'), { recursive: true });
await writeFile(VENDOR_FILE, patched, 'utf8');
await writeFile(
  LOCK_FILE,
  `${JSON.stringify(
    {
      version,
      upstream: url,
      upstreamSha256: sha256(upstream),
      patchedSha256: sha256(patched),
      patch: { before: match.before, after: match.after, seenIn: match.seenIn },
      note: 'Tampermonkey 는 @require 를 함수 스코프에서 실행하므로 최상위 var 가 globalThis 에 오르지 않는다. 그래서 전역 노출 줄이 지역 var 를 읽게 고친다.',
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`vendor/mermaid.min.js 갱신 · mermaid ${version} · ${patched.length.toLocaleString()} bytes`);
console.log(`치환: ${match.before}`);
console.log(`  →   ${match.after}`);
console.log('이어서 `node --test tests/*.test.cjs` 로 함수 스코프 로드를 확인하세요.');
