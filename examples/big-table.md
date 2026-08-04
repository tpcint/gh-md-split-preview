# 플로우 목록

행이 많은 표에서 한두 줄만 고치면 헤더 줄과 `|---|` 구분선이 diff 밖으로 밀린다.
이 문서의 표에서 한 행만 바꾼 커밋을 열면 그 상황을 그대로 볼 수 있다.

| 플로우 | 설명 | 도메인 | 난이도 |
|---|---|---|---|
| [회원 가입](signup.md) | 이메일·소셜 가입 | user, auth | 단순 |
| [로그인](login.md) | 이메일·소셜 로그인 | user, auth | 단순 |
| [프로필 설정](profile.md) | 닉네임·사진·소개 | user | 단순 |
| [알림 설정](notification.md) | 푸시·메일 수신 설정 | user, push | 단순 |
| [피드 탐색](feed.md) | 추천·팔로잉 피드 | feed | 복합 |
| [게시물 작성](post-write.md) | 사진·영상·글 업로드 | post, media | 복합 |
| [게시물 조회](post-view.md) | 상세 보기 + 반응 | post | 단순 |
| [댓글](comment.md) | 작성·수정·삭제·신고 | post, comment | 단순 |
| [팔로우](follow.md) | 팔로우·언팔로우·차단 | user, relation | 단순 |
| [검색](search.md) | 통합 검색 | search | 복합 |
| [구독 결제](subscription.md) | 정기 결제 시작·해지 | payment, subscription | 복합 |
| [백넘버 구매](back-number.md) | 지난 회차 단건 구매 | back-number, payment | 단순 |
| [선물](gift.md) | 선물 보내기 | gift, payment | 단순 |
| [룰렛](roulette.md) | 룰렛 플레이 | roulette, payment | 단순 |
| [라이브](live.md) | 시청 + 방송 + 통화 | live, live-call, gift | 복합 |
| [정산](payout.md) | 수익 확인·출금 신청 | payment, payout | 복합 |
| [고객 문의](support.md) | 1:1 문의·FAQ | support | 단순 |
| [계정 삭제](withdraw.md) | 탈퇴 + 데이터 정리 | user, auth | 복합 |

표 아래 본문은 평소대로 렌더링된다.
