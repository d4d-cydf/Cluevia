# Cluevia · OSINT Copilot

제공된 디자인을 React + TypeScript + Vite로 구현한 웹 스켈레톤입니다.

## 실행

Node.js 22.12 이상을 권장합니다.

```bash
npm install
npm run dev
```

터미널에 표시되는 주소(기본 `http://localhost:5173`)를 엽니다.

```bash
npm run build    # TypeScript 검사 + 배포용 dist 생성
npm run preview  # 빌드 결과 미리보기
```

## 화면

| 경로 | 내용 |
| --- | --- |
| `/` | 폴더 열기 애니메이션, 질문 입력, 파일 첨부 |
| `/case/0143/board` | 대화와 자유 배치 증거 그래프 |
| `/case/0143/lanes` | Lead → Infrastructure → Content → Money 레인 |
| `/case/0143/timeline` | 사건 타임라인과 입금 건수 차트 |

Besley / Courier Prime 서체, 종이색 배경, 사건철, 붉은 강조색과 원본 그래프 위치를 적용했습니다. 서체 파일과 OFL 라이선스를 `public/fonts`에 포함해 외부 Google Fonts 연결 없이 동일한 서체로 표시합니다. 작은 화면에서는 대화와 그래프를 세로로 배치하고 그래프 영역만 가로로 스크롤합니다. 동작 줄이기 설정을 지원합니다.

## 구현 범위

- 질문 또는 파일을 추가한 뒤 작업 화면 열기
- 파일 선택·드래그 앤 드롭·첨부 삭제
- Board / Lanes / Timeline 전환과 직접 URL 접근
- 증거 번호 및 그래프 노드 선택, 속성·관련 동작 표시
- Answer path 켜기/끄기, 그래프 생성 애니메이션 다시 보기
- 타임라인 이벤트 선택, 입금 건수 툴팁
- 후속 질문, 선택 항목 질문, 동작의 로컬 대기 상태
- 케이스 데이터·대화·대기 동작의 JSON 내보내기

현재는 가상의 샘플 케이스 0143을 사용하는 프런트엔드 데모입니다. 임의의 질문으로 시작해도 샘플 증거를 표시합니다. 실시간 검색, AI 응답, 인증, Palantir 연결, 신고·차단·법적 요청 제출은 구현하지 않았습니다. 첨부 파일은 이름과 크기만 사용하며 업로드하거나 내용을 분석하지 않습니다. 질문과 동작 상태는 브라우저 `sessionStorage`에 저장됩니다.

## 구조와 API 연결 지점

```text
src/
  components/Icon.tsx          공통 아이콘
  mock/case-0143.ts            원본의 객체 12개, 링크 12개, 이벤트 17개
  types/case.ts                데이터 타입과 CaseRepository 인터페이스
  services/case-repository.ts  현재 로컬 목 어댑터
  screens/
    HomeScreen.tsx            홈 화면
    WorkspaceScreen.tsx       공통 헤더·대화·탭·상세 정보
    BoardView.tsx             자유 배치 그래프
    LanesView.tsx             레인 그래프
    TimelineView.tsx          타임라인·입금 차트
  styles/global.css           공통 색상·서체·접근성 스타일
```

`CaseRepository`의 `getCase`, `listObjects`, `listLinks`, `runAction`, `sendMessage`를 실제 구현으로 교체하면 UI와 데이터 연결 코드를 분리한 채 OSDK 또는 백엔드에 연결할 수 있습니다. 실제 인증과 영속 저장은 해당 단계에서 추가해야 합니다.

## 브라우저 검증

```bash
npx playwright install chromium
npm run test:e2e
```

기존 Chromium 실행 파일을 사용하려면 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 환경변수를 지정할 수 있습니다. 테스트는 개발 서버를 자동으로 실행하고 파일 첨부, 화면 전환, 증거 선택, 후속 질문, 내보내기와 모바일 레이아웃을 검사합니다.

정적 호스팅에 배포할 때는 `/case/*` 요청도 `index.html`로 전달하는 SPA fallback 설정이 필요합니다.
