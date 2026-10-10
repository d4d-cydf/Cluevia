# Cluevia · Evidence Graph

React + TypeScript + Vite로 만든 자료 분석·관계 그래프 웹 프로젝트입니다. 완성된 그래프 JSON을 가져와 탐색하거나, Palantir AIP에 자료를 보내 같은 형식의 그래프를 생성할 수 있습니다.

## 실행

Node.js 22.12 이상을 사용합니다. Windows PowerShell에서는 프로젝트 폴더에서 실행하세요.

```powershell
npm ci --include=dev
npm run dev
```

기본 주소는 `http://localhost:5173`입니다. Windows와 WSL은 서로 다른 실행 파일을 설치하므로 의존성 설치와 실행은 같은 환경에서 진행하세요. `'vite' is not recognized` 오류가 나면 위 설치 명령을 먼저 실행합니다.

```bash
npm run build    # TypeScript 검사 + dist 생성
npm run preview  # 빌드 결과 + 로컬 AIP API 미리보기
```

## 먼저 완성된 그래프 보기

홈의 **GFW 공개 사례**를 누르거나 `/case/gfw-galapagos/board`를 엽니다. AIP 설정 없이 작동합니다.

Global Fishing Watch의 공식 공개 문헌에 나온 **2017년 갈라파고스 Fu Yuan Yu Leng 999 사례**를 선박·장소·해상 조우·단속 사건 등 **12개 객체, 15개 관계, 2개 날짜 있는 사건, 3개 출처**로 정리했습니다.

- **Board:** 관계를 기준으로 자동 배치한 그래프. 노드·연결선을 선택하면 상세 정보와 근거 표시
- **Lanes:** 데이터의 그룹별로 정렬
- **Timeline:** 자료에 명시된 실제 날짜와 기간으로 배치
- 객체 검색, 주요 관계 강조, 확대·축소·Fit, 키보드 선택
- 출처 번호를 누르면 문헌 정보를 열고 공식 원문으로 이동
- **EXPORT:** 완성된 JSON 다운로드. 홈의 **그래프 JSON 불러오기** 또는 화면의 **IMPORT**로 다시 열기

지도 소개 페이지에는 개별 선박 기록이 담겨 있지 않아, 같은 기관의 공식 사건 분석과 후속 보고서를 함께 사용했습니다. 예제는 공개 문헌을 구조화한 역사적 사례이며 실시간 AIS 지도나 현재 선박 위치가 아닙니다. 화면 좌표는 관계를 보여 주기 위한 배치입니다.

`reported`는 출처에서 보고한 관계, `inferred`는 해석을 포함한 관계입니다. 해상 근접·조우가 실제 화물 이전을 입증하지는 않습니다. 추론 관계에는 점선과 설명이 표시됩니다.

**출처**

- [Global Fishing Watch 지도 소개](https://globalfishingwatch.org/our-map/)
- [2017년 선박 조우 분석](https://globalfishingwatch.org/impacts/policy-compliance/transhippment-reefer-illegal-sharks/)
- [상어 어획 사건 후속 보고](https://globalfishingwatch.org/success-story/data-and-analysis-help-track-illegal-shark-fishing/)

완성본은 [public/examples/gfw-galapagos.json](public/examples/gfw-galapagos.json), AIP에 첨부할 수 있는 요약 자료는 [public/examples/gfw-source-notes.txt](public/examples/gfw-source-notes.txt)입니다.

## 자료에서 그래프가 만들어지는 과정

```text
질문 + 자료 본문
  → 서버가 Foundry AIP 모델에 구조화 요청
  → 객체(nodes) / 관계(edges) / 사건(events) / 출처(sources) JSON
  → 스키마·중복 ID·연결 대상·출처 참조·날짜 검증
  → 브라우저 저장
  → Board / Lanes / Timeline 자동 배치 및 렌더링
```

예를 들어 선박은 객체, 선박과 조우 사건의 연결은 관계, 날짜가 명시된 단속은 사건이 됩니다. AIP가 그래프 이미지를 만드는 방식이 아니라, 질문과 관련된 객체와 관계를 JSON으로 정리하면 프런트엔드가 배치합니다. 완성된 JSON이 이미 있다면 AIP 호출을 거치지 않습니다.

데이터 계약은 [src/types/graph.ts](src/types/graph.ts)의 `GraphDocument`, 실행 시 검증은 [src/lib/graph-document.ts](src/lib/graph-document.ts), 배치는 [src/components/graph/GraphRenderer.tsx](src/components/graph/GraphRenderer.tsx)가 담당합니다.

| 필드 | 역할 |
| --- | --- |
| `schemaVersion` | 현재 `"1.0"` |
| `id`, `title`, `question`, `summary`, `origin`, `createdAt` | 케이스 메타데이터 |
| `groups` | 그룹 ID·이름·색상 (`#RRGGBB`) |
| `nodes` | 객체 ID·이름·유형·그룹·속성·설명·출처 참조 |
| `edges` | 시작/끝 객체 ID, 관계명, 설명, `reported` 또는 `inferred`, 출처 참조 |
| `events` | ISO 날짜, 선택적 종료일, 관련 객체·출처 참조 |
| `sources` | 출처 ID·제목·선택적 원문 URL·발행일·발췌 |
| `findings`, `limitations` | 자료에서 정리한 내용과 해석의 한계 |

객체·관계·사건·분석 항목에는 유효한 `sourceIds`가 필요합니다. 날짜가 없는 자료는 사건 배열을 비우면 됩니다. 배열은 비어 있어도 필드를 포함하세요. 예제 JSON을 형식 참고용으로 사용할 수 있습니다. 최대 200개 객체, 500개 관계, 300개 사건, JSON 2MB를 지원합니다.

## Palantir AIP 연결

프로젝트 루트의 **`.env.local`**에 값을 입력합니다. 새 환경에서는 `.env.example`을 `.env.local`로 복사합니다. 이미 설정한 파일은 덮어쓰지 마세요.

```dotenv
FOUNDRY_DOMAIN=https://your-enrollment.palantirfoundry.com
FOUNDRY_TOKEN=your-token
FOUNDRY_MODEL_RID=ri.language-model-service..language-model.your-model
```

`FOUNDRY_MODEL_RID`에는 Foundry Model Catalog에서 복사한 실제 전체 **모델 RID**를 넣으세요. 예시 문자열은 작동하는 모델 이름이 아닙니다. 해당 환경에서 OpenAI Chat Completions 호환 API와 JSON 출력을 지원하는 모델 및 모델 접근 권한이 필요합니다.

환경 변수를 바꾼 뒤 `npm run dev`를 재시작합니다. 홈의 **AIP 설정됨** 표시는 설정 형식 확인을 뜻합니다. 실제 모델 접근·권한은 생성 요청 시 확인됩니다.

1. 질문을 입력합니다.
2. **Source text**에 본문을 붙여 넣거나 TXT·MD·CSV·JSON 파일을 첨부합니다. GFW 요약 TXT를 테스트 자료로 사용할 수 있습니다.
3. **START INVESTIGATION**을 누릅니다.
4. 생성 결과를 검증한 뒤 그래프 화면이 열립니다. 모델 결과도 원문과 대조해서 검토하세요.

자료는 최대 10개, 각 5만 자, 전체 15만 자입니다. PDF·사진은 텍스트 변환 후 사용하세요. URL만 입력하면 웹을 자동 수집하는 기능은 없습니다. 생성 요청 시 첨부 본문과 질문을 설정한 Foundry 모델로 전송합니다. 생성 중 **취소**하면 서버에서 진행 중인 Foundry HTTP 요청도 중단합니다. 모델 서비스 내부의 처리·과금 중단 여부는 해당 서비스 동작에 따릅니다.

**구현된 API**

- `GET /api/aip/status`: 설정 여부와 누락/잘못된 변수 이름만 반환
- `POST /api/graphs/generate`: `{ question, documents: [{ id, name, text, url? }] }`를 받아 `{ graph }` 반환
- 서버에서 `POST /api/v2/llm/proxy/openai/v1/chat/completions` 호출

토큰은 서버에서만 읽습니다. `VITE_` 접두사를 붙이지 마세요. `.env.local`은 Git에서 제외되어 있으며 브라우저 저장소·JSON 내보내기에 토큰을 넣지 않습니다. 잘못된 모델 응답, 끊어진 참조, 제한 초과, 인증 실패, 시간 초과는 오류로 표시합니다.

[Palantir 공식 호환 API 문서](https://www.palantir.com/docs/foundry/aip/llm-provider-compatible-apis) · [Chat Completions API](https://www.palantir.com/docs/foundry/api/llm-apis/models/openai-chat-completions-proxy)

현재 자격증명 없이 요청 형식과 오류·취소 처리를 모의 응답으로 검증했습니다. 실제 Foundry 연결은 환경 설정 후 확인해야 합니다. Foundry Ontology 객체 생성·OSDK 쓰기 연동은 포함하지 않습니다.

## 저장과 배포 범위

- 가져오거나 생성한 그래프는 해당 브라우저의 `localStorage`에 저장됩니다. 원본 첨부 파일 자체는 별도 보관하지 않지만 결과 JSON에는 출처 발췌와 추출된 내용이 포함됩니다.
- **MY CASES**에서 최근 그래프를 열 수 있습니다. 다른 브라우저로 옮기거나 백업하려면 JSON을 내보내세요.
- 기존 디자인 데모는 `/case/0143/board`, `/lanes`, `/timeline`에 유지되어 있습니다. 해당 데모의 후속 대화·작업은 실제 외부 작업을 수행하지 않습니다.
- AIP 서버 API는 로컬 Vite 개발·미리보기 서버에 연결했습니다. `dist`만 정적으로 배포하면 예제·가져오기는 가능하지만 AIP 생성에는 별도 서버 배포가 필요합니다. 다중 사용자 배포 시 인증과 사용자별 저장소를 추가해야 합니다.
- 정적 호스팅에서 `/case/*` 요청은 `index.html`로 연결하는 SPA fallback이 필요합니다.

로고·Besley / Courier Prime 서체는 프로젝트 안에 포함되어 있습니다.

## 검증

```bash
npm test                       # 그래프 검증 + AIP 서버 테스트 (Node.js 22.6+)
npx playwright install chromium
npm run test:e2e                # 실제 Chromium 화면 테스트
npm run build
```

Playwright는 기본적으로 개발 서버를 자동 실행합니다. 이미 실행 중인 서버를 검사하려면 `PLAYWRIGHT_BASE_URL`, 기존 Chromium을 사용하려면 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`를 지정할 수 있습니다.
