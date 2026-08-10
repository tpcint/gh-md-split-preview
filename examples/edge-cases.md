---
title: "frontmatter 엣지 케이스"
tags: [alpha, beta, gamma]
matrix: {ios: 1, android: 2, web: 3}
authors:
  - name: 김하늘
    role: PM
  - name: 이바다
    role: BE
nested:
  a:
    b:
      c: 더 깊은 값
summary: |
  첫 줄
  둘째 줄
folded: >
  접히는
  문장
url: https://example.com/a:b?q=1
empty:
comment_test: 값  # 이 뒤는 주석
color: "#fff"
same_level_seq:
- one
- two
---

# 엣지 케이스 문서

위 frontmatter는 배열·중첩 매핑·flow 표기·블록 스칼라·주석을 한 번에 담고 있다.

```js
const x = 1;
```

> 인용문도 평소대로 렌더링된다.
