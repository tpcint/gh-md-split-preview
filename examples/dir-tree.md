# 문서 디렉터리 구조

디렉터리 트리는 보통 코드블록 안에 넣는다. 그런데 트리에서 한 줄만 고치면
여는 ` ``` ` 과 닫는 ` ``` ` 이 **둘 다** diff 밖으로 밀려난다. 조각에 펜스가
한 줄도 없으니 마크다운 문법상 그냥 문단이고, 렌더링하면 줄바꿈과 칸 맞춤이
통째로 무너져 한 줄로 이어 붙는다.

이 문서의 트리에서 한 줄만 바꾼 커밋을 열면 그 상황을 그대로 볼 수 있다.

```text
docs/
├── README.md                   # 목차
├── getting-started/
│   ├── install.md              # 설치
│   ├── configure.md
│   └── troubleshooting.md
├── guides/
│   ├── authoring.md            # 문서 작성 규칙
│   ├── review.md               # 리뷰 절차와 체크리스트
│   ├── translation.md
│   └── publishing.md
├── reference/
│   ├── cli.md
│   ├── config.md               # 설정 키 목록
│   ├── errors.md
│   └── glossary.md
└── internal/
    ├── decisions/
    │   ├── 0001-adopt-mdx.md
    │   └── 0002-split-guides.md
    ├── onboarding.md
    └── runbook.md
```

트리 아래 문단은 트리가 코드블록으로 살아났는지 확인하는 자리다. 트리가 문단으로
붙어버리면 가지가 한 줄로 이어져 이 문단과 잘 구분되지 않는다.

| 디렉터리 | 담는 것 |
| --- | --- |
| `getting-started/` | 처음 한 번 읽는 글 |
| `guides/` | 절차 |
| `reference/` | 찾아보는 표 |
| `internal/` | 팀 안에서만 보는 기록 |
