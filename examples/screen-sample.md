---
id: SCR-POLL-DETAIL
name: 투표 상세 화면
type: web-only
flow_type:
  - Interaction
requested_userType:
  - Guest
  - Fan
  - Creator
domains:
  - poll
  - wallet
platforms:
  ios: "-"
  android: "-"
  web: /poll/{pollId}
status: active
doc_status: active
---

# 투표 상세 화면

투표 이벤트 페이지. 어드민에서 생성한 모든 투표가 별도 웹 개발 없이 이 화면으로 열리며,
어드민 운영 옵션(후보 검색 노출·후보 프로필 이동·유의 사항·테마 컬러)을 읽어 동작한다.

## 진입 경로

| 경로 | 설명 |
|------|------|
| `/poll/{pollId}` | 투표 상세 |
| `/poll/{pollId}/result` | 결과 |

- 비로그인 사용자도 조회는 가능하다.
- 투표 행위는 로그인 후에만 가능하다.
