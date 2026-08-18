# 렌더링 파이프라인

이 문서의 다이어그램은 우측 패널에서 GitHub 본문과 같이 그림으로 나온다.
가운데 몇 줄만 고친 커밋을 열면 펜스가 diff 밖으로 밀려 코드블록으로 남는 것도 볼 수 있다.

## 파일 하나가 2단으로 바뀌기까지

```mermaid
flowchart TD
    A[변경 파일 화면 열기] --> B{md 파일인가?}
    B -->|아니오| Z[그대로 둔다]
    B -->|예| C[diff DOM 에서 변경 후 라인 수집]
    C --> D[펜스 짝 맞추기]
    D --> E[marked 로 블록 렌더]
    E --> F{mermaid 블록?}
    F -->|예| G[SVG 로 교체 후 앵커 재계산]
    F -->|아니오| H[그대로 표시]
    G --> I[스크롤 동기화]
    H --> I
```

## 좌우 스크롤이 맞춰지는 순서

```mermaid
sequenceDiagram
    participant U as 사용자
    participant L as 좌 diff 패널
    participant R as 우 렌더 패널
    U->>L: 스크롤
    L->>L: 오프셋 → 라인번호 보간
    L->>R: 같은 라인번호 요청
    R-->>U: 해당 블록으로 이동
```

## 파일 블록의 상태

```mermaid
stateDiagram-v2
    [*] --> 미처리
    미처리 --> 렌더됨: diff 도착
    렌더됨 --> 재렌더: Expand / React 재그리기
    재렌더 --> 렌더됨
    렌더됨 --> 해제: 버튼 끄기
    해제 --> [*]
```

> 다이어그램 문법이 틀리면 그 자리는 코드블록으로 남고 실패 이유가 한 줄 붙는다.
