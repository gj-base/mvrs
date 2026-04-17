# 자재센터 불용자재 환입차량 예약시스템 — 마이그레이션 계획

## 스택
- **프론트**: 정적 HTML/JS
- **DB**: Supabase
- **파일 저장**: Cloudflare R2 (Cloudflare Worker 업로드 프록시)

---

## 1단계: Supabase 프로젝트 설계 (먼저 진행 권장)

### 1-1. 데이터베이스 테이블 `reservations`

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid (PK, default gen_random_uuid()) | 예약 고유 ID |
| created_at | timestamptz (default now()) | 신청 시각 |
| date | date | 예약일 |
| visit_time | text | 시간 (예: "08:30") |
| company | text | 업체명 |
| car1 | text | 차량번호1 |
| car2 | text | 차량번호2 (nullable) |
| material | text | 환입 자재 종류/수량 |
| contact | text | 신청자 연락처 |
| people | text | 출입 인원 정보 |
| file1_url | text | 안전수칙 동의서 1 URL |
| file2_url | text | 안전수칙 동의서 2 URL |
| file3_url | text | 안전수칙 동의서 3 URL |
| status | text | '대기' \| '승인' \| '반려' (default '대기') |

### 1-2. 파일 저장(R2)
- 버킷: `reservation-files`
- 업로드 경로: 브라우저 -> Worker -> R2
- 파일 경로 예: `{reservation_id}/file1.pdf`

### 1-3. RLS (Row Level Security)
- **사용자(비로그인)**: 예약 가능 슬롯 조회(읽기), 예약 INSERT만 허용
- **관리자**: 전체 조회, status 업데이트 (승인/반려)
- 관리자 인증: Supabase Auth(이메일 로그인) 또는 **Edge Function에서 비밀번호 검증** 후 JWT/세션 부여

---

## 2단계: 프론트 수정 순서

1. **GAS 의존성 제거**
   - `index.html`: `google.script.run` → Supabase JS 클라이언트 (`getAvailableSlots`, `submitReservation`)
   - `admin.html`: `google.script.run` → Supabase 조회 + (선택) Auth 또는 비밀번호 검증
   - `<?= ScriptApp.getService().getUrl() ?>` → 상대 경로 (`admin.html`, `index.html`)

2. **공통 설정**
   - `config.js` 또는 인라인: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (GitHub Pages에서는 anon key 노출 가능, RLS로 보호)

3. **파일 업로드**
   - 클라이언트에서 Cloudflare Worker로 업로드 -> Worker가 R2에 저장
   - Worker가 반환한 public URL을 `doc_url_1~3`에 저장

4. **관리자 로그인**
   - 옵션 A: Supabase Auth (이메일/비밀번호) + RLS로 admin만 수정
   - 옵션 B: 간단 비밀번호 한 번 입력 후 localStorage 등에 플래그 저장 (보안은 낮지만 빠름)

---

## 3단계: UI/UX 개선 (기능 마이그레이션 후)

- 날짜/시간 선택기 직관화 (예: 타임슬롯 버튼 그리드)
- 모바일 반응형 점검
- 로딩/에러 메시지 통일
- 관리자 화면: 승인/반려 버튼 추가 (현재는 조회만 가능)

---

## 4단계: 추가 기능 (요구사항 정리 후)

- 예약 취소, 수정
- 알림(이메일/SMS) 연동
- 대시보드 통계 등

---

## 체크리스트

- [x] Supabase 프로젝트 생성
- [ ] `reservations` 테이블 생성 + RLS 정책 작성 (SUPABASE_SETUP.md 참고)
- [x] R2 버킷 `reservation-files` 생성
- [x] Worker 업로드 경로 연결 (`R2_UPLOAD_WORKER_URL`)
- [ ] `config.js`에 URL / anon key / ADMIN_PASSWORD 설정
- [x] index.html: getAvailableSlots → Supabase
- [x] index.html: submitReservation → Storage 업로드 + insert
- [x] index.html: 관리자 링크를 `admin.html`로 변경
- [x] admin.html: 로그인을 비밀번호(ADMIN_PASSWORD)로 대체
- [x] admin.html: 캘린더 이벤트 소스를 Supabase로 변경
- [x] admin.html: 사용자 페이지 링크를 `index.html`로 변경
- [ ] GitHub Pages 배포 설정
- [ ] (선택) 관리자 승인/반려 버튼 + status 업데이트
