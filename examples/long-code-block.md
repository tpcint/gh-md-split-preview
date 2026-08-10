# 동기화 스크립트

줄이 긴 코드블록에서 한두 줄만 고치면 여는 ` ``` ` 줄이 diff 밖으로 밀린다.
이 문서의 코드블록에서 한 줄만 바꾼 커밋을 열면 그 상황을 그대로 볼 수 있다.

```bash
#!/usr/bin/env bash
set -euo pipefail

RULE_BASE="${1:-origin/main}"
MAIN="${2:-HEAD}"
OUT_DIR="tmp/sync"

mkdir -p "$OUT_DIR"

# 규칙을 규정하는 파일만 추려서 delta 를 만든다
git diff "$RULE_BASE" "$MAIN" -- \
  CLAUDE.md AGENTS.md README.md docs/ \
  screens/README.md screens/components/README.md flows/README.md \
  glossary.md \
  .claude/skills .claude/commands \
  scripts/lint-docs.py scripts/label-rule-sections.py \
  .github/labeler.yml .github/workflows .github/ISSUE_TEMPLATE \
  > "$OUT_DIR/delta.patch"

if [ ! -s "$OUT_DIR/delta.patch" ]; then
  echo "규칙 변경 없음 — 여기서 끝낸다"
  exit 0
fi

python3 scripts/lint-docs.py --patch "$OUT_DIR/delta.patch"
rm -f tmp/lint-baseline.txt tmp/lint-now.txt tmp/delta.patch   # 다음 실행이 깨끗하도록
```

> `.github` 는 두 디렉토리만 명시한다. 전체로 넓히면 `CODEOWNERS`·`dependabot.yml`
> 변경이 delta 에 올라와 분류에 잡음이 된다.

> `AGENTS.md` 는 `CLAUDE.md` 의 symlink 다 — 규칙 내용 변경은 `CLAUDE.md` 쪽에
> 나타나므로, delta 에 `AGENTS.md` 가 잡히면 symlink 자체가 바뀐 경우다.

## 체크리스트

- 라벨에는 **워크플로우가 관리하는 것**과 **사람이 붙이는 것**이 섞여 있다
  - `룰/가이드` — 경로 glob + 규칙 섹션 감지. **부착만** 한다
  - `리뷰완료` — 유효 approve 수 판정. **부착·제거를 모두** 한다
- **doc_status 판정 기준** — 구현 진행도가 아니라 "머지 시점 완결도"로 붙었는가
