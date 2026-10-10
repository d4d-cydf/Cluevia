# Cluevia · Evidence Graph

자료에서 객체와 관계를 찾고 근거를 검증해 그래프로 보여 주는 웹 앱입니다. 홈에서 요청하면 **확인 질문·범위 확정 → Codex 온톨로지 설계 → 표 데이터 변환 / Codex 문서 분석 / 선택적 Jev 판정 → 스키마·근거 검증 → SQLite 저장 → 그래프 렌더링**까지 실행합니다. Palantir 계정이나 Foundry 데이터가 없어도 사용할 수 있습니다.

## 실행

Node.js **22.17 이상**을 사용하세요. Windows PowerShell에서:

```powershell
npm ci --include=dev
npm run dev
```

`http://localhost:5173`을 엽니다. 새 분석은 자료에 맞는 온톨로지를 먼저 설계하므로 Codex 로그인이 필요합니다. 저장된 그래프와 온톨로지는 모델 연결 없이 열 수 있습니다.

**Jev 연결:** `.env.local`의 `TYPESAFE_API_KEY=` 뒤에 TypeSafe API 키를 입력하고 서버를 재시작하세요. 파일이 없다면 `.env.example`을 복사합니다. 기존 `.env.local`은 덮어쓰지 마세요. 모델과 동시 요청 수는 기본값으로 시작할 수 있습니다.

```dotenv
TYPESAFE_API_KEY=여기에_TypeSafe_API_키
```

온톨로지 설계와 문서 분석을 위해 같은 컴퓨터·OS·사용자 계정에서 아래 명령으로 로그인합니다. CLI는 프로젝트에 고정 버전으로 설치되므로 별도 전역 설치가 필요 없습니다.

```powershell
npm run codex:login
npm run codex:status
```

Jev는 선택 사항입니다. 키가 없어도 Codex로 온톨로지 설계와 문서 분석을 진행합니다. 키가 있더라도 모든 문서를 Jev에 보내지 않으며, 제한된 선택지로 안전하게 표현할 수 있는 판정에만 사용합니다.

- `'vite' is not recognized`라면 `npm ci --include=dev`부터 실행하세요.
- Windows와 WSL의 실행 파일·로그인은 별개입니다. 설치와 실행은 같은 환경에서 진행하세요. 환경을 바꿨다면 해당 환경에서 `npm ci`를 다시 실행합니다.
- 홈의 **Jev 선택 판정 준비됨**은 키가 서버에 설정되었다는 뜻입니다. 키 유효성·모델 접근 권한·사용량·네트워크 오류는 실제 분석 요청 시 확인합니다. 표 데이터도 최초 온톨로지 설계에는 Codex를 사용하고, 검증된 컬럼 매핑으로 각 행을 변환합니다.
- Codex는 사용자 `config.toml`의 MCP·플러그인·모델 제공자 설정을 읽지 않습니다. 모델 선택은 `.env.local`의 `CODEX_MODEL`로 지정할 수 있습니다.

## 사용 순서

1. 홈에서 질문을 입력하고 JSONL·NDJSON·CSV·TSV·JSON·XML·YAML·로그 등 UTF-8 텍스트 자료를 첨부하거나 본문을 붙여 넣습니다. 원본 자료는 확장자 제한이 없습니다.
2. **START INVESTIGATION**을 누르면 분석 목적·대상·범위를 확인하는 질문을 먼저 보여줍니다. 선택지 또는 **기타 · 직접 입력**으로 답하고, 정리된 요청을 수정한 뒤 **이 범위로 분석 시작**을 누릅니다. 이때 자료를 전송하고 작업을 등록한 후 `/analysis/:jobId` 그래프 작업 화면으로 이동합니다. 왼쪽 AI 에이전트 패널에서 실제 서버의 온톨로지 설계 → 자료 준비 → 분석 → 근거 검증 → 저장 단계와 현재 작업을 확인합니다.
3. 검증·저장이 끝난 부분 그래프부터 같은 화면에 표시됩니다. 전체 분석이 끝날 때까지 왼쪽 진행 패널을 유지하며 **Board / Lanes / Timeline**에서 객체·관계·출처를 탐색할 수 있습니다.
4. **ONTOLOGY**에서 분석별 객체 유형·속성·관계·제약을 확인하고, 해당 온톨로지에 저장된 객체와 원문 근거를 검색합니다.
5. 로고 왼쪽 토글로 **케이스 사이드바**를 열어 저장한 그래프를 다시 엽니다. 브라우저를 바꿔도 같은 서버의 그래프를 사용할 수 있습니다.

**질문만 입력하면** 온톨로지 구조를 설계해 저장하고 분석 화면에 **온톨로지 열기** 링크를 표시합니다. 사실을 뒷받침할 자료가 없으므로 실제 객체·관계나 그래프를 만들어 내지 않습니다. 그래프를 생성하려면 근거 자료를 첨부하거나 본문을 붙여 넣으세요.

질문 없이 자료만 첨부해도 시작할 수 있습니다. 이 경우 자료의 객체와 관계를 정리하는 기본 요청을 사용합니다.

질문만으로 구조를 설계하는 예:

> 고객·주문·상품을 관리할 온톨로지를 만들어줘. 고객 ID와 주문 번호로 식별하고 주문 금액과 주문일을 속성으로 두어줘.

CSV를 첨부하면 그 파일의 컬럼과 자료 예시를 참고해 유형·속성·관계를 설계한 다음 실제 행을 그래프로 변환합니다. GFW의 공개된 2017년 갈라파고스 사례는 기존 예제로 계속 열 수 있습니다.

생성 중 분석 화면을 새로고침하거나 홈의 **분석 화면 열기**를 눌러도 서버 작업을 다시 조회합니다. 기존 `/?job=작업ID` 링크도 새 분석 화면으로 연결됩니다. 취소하면 진행 중인 모델 요청과 Codex 프로세스를 중단합니다. 실패·취소·서버 재시작 후에는 **남은 구간 이어서 분석**으로 완료하지 않은 구간을 재개합니다. 이미 저장한 부분 그래프는 유지됩니다. 작업은 한 번에 하나씩 실행하고 실행·대기 합계 최대 5개를 받습니다.

## 분석 전 확인 질문

- 요청이 넓거나 모호하면 Codex가 1–3개의 선택형 질문을 제안합니다. 각 질문에는 2–4개의 선택지와 **기타 · 직접 입력**이 있으며, 확인 질문은 최대 두 차례 진행합니다. 요청이 충분히 구체적이면 바로 범위 확인 화면으로 이동할 수 있습니다.
- 이 단계는 파일을 업로드하거나 그래프 작업을 만들지 않습니다. 브라우저가 각 파일의 앞부분을 제한해서 읽고, 최대 10개 자료에서 **미리보기 총 12,000자 이하**와 원래 요청·답변만 전송합니다. 미리보기는 전체 자료를 대표한다고 가정하지 않습니다.
- 최종 화면에서 **분석 목적·분석 범위·원하는 결과**를 수정할 수 있습니다. 원래 요청과 질문·답변을 함께 확인한 뒤 명시적으로 시작합니다. **요청 수정하기**는 확인 요청을 취소하고 기존 입력·첨부 파일로 돌아갑니다. **질문 없이 현재 요청으로 분석**을 선택하면 원래 요청으로 바로 시작합니다.
- 추가 질문 생성이 실패하면 **기본 확인 질문**을 표시합니다. 답변 이후 요약이 실패하면 원래 요청과 정확한 답변을 보존한 범위 확인 화면을 제공합니다. 연결 오류는 재시도할 수 있으며, 오류만으로 그래프 분석을 시작하지 않습니다.
- 답변 제출 중에는 선택 내용을 유지하고 중복 제출을 막습니다. 요청·첨부 원본은 브라우저 IndexedDB에, 작성 상태는 탭별 초안으로 임시 보관합니다. 새로고침 시 제출한 답변부터 이어서 범위를 정리하며, 그래프 작업은 최종 시작 버튼을 누른 뒤에만 생성합니다. 시작 성공·요청 수정 시 임시 사본을 삭제하고, 24시간이 지난 초안은 다음 저장·복구 시 정리합니다. 브라우저 저장소가 차단되면 현재 화면의 분석은 가능하지만 새로고침 복구는 지원되지 않습니다.
- 확정한 `analysisBrief`는 사용자의 분석 의도입니다. 원문 출처나 사실의 증거로 사용하지 않습니다. 첨부한 원본과 모든 분석 구간은 보존하며, 관련된 객체와 관계를 중심으로 설계·추출하도록 지시합니다. 확인 질문만으로 원본을 잘라내거나 모델 정확도·전체 소요 시간의 개선을 보장하지 않습니다.
- 완성된 그래프 JSON 가져오기는 확인 질문 없이 기존 방식으로 엽니다.

## 큰 파일 전체 분석

첨부 자료의 기존 **2MB 제한을 제거했습니다.** 기본값은 앱의 파일 크기 상한 없음입니다. 서버 저장 공간, 브라우저와 외부 프록시의 제한은 별도로 적용됩니다.

- 확장자와 관계없이 **UTF-8 텍스트**를 브라우저에서 원시 파일로 전송합니다. 큰 파일 전체를 브라우저 문자열이나 JSON 요청 하나로 만들지 않습니다.
- 지원되는 표 데이터는 서버가 레코드를 읽고 온톨로지로 변환합니다. **검증된 매핑이 있는 행마다 LLM을 호출하지 않습니다.** 매핑을 적용하기 어려운 부분은 Codex로 분석합니다. 컬럼의 의미와 관계는 이번 분석의 온톨로지 매핑에 따르며 원본 전체를 따로 보관합니다. 구조화 파일의 문법 오류는 위치와 함께 보고합니다.
- 문서는 제한된 크기로 나누어 생성된 스키마에 맞춰 Codex로 분석합니다. 표의 본문·설명 열은 Jev로 반복 분류·관계 유형 후보 판정을 하고, 독립적인 짧은 기록은 원문을 묶어 Codex에 전달합니다. 복잡하거나 불확실한 기록은 개별 분석합니다. 분석 캐시는 온톨로지와 처리 설정을 구분합니다.
- Jev에 적합하지 않거나 불확실한 구간은 Codex로 처리합니다. 새 온톨로지 기반 분석은 `CLUEVIA_JEV_FALLBACK=false`여도 불확실한 일부 결과를 완료본으로 저장하지 않습니다. 지원 형식과 이전 작업의 호환 동작은 [대용량 처리 상세](docs/large-data.md)를 확인하세요.
- 행 ID가 없는 표도 서버가 `evidenceId`를 붙여 직접 변환합니다. 본문 열은 `semanticColumns`로 별도 분석하고, 시간 초과된 구간은 더 작게 나눠 재시도합니다. 반복하는 Jev 판정은 [JSON 정책과 고정 실행기](docs/jev-decision-plan.md)를 사용합니다.
- 첨부한 자료의 **모든 구간을 처리**합니다. 전체를 처리한다는 뜻이며 모델이 모든 사실을 빠짐없이 추출한다고 보장하지는 않습니다. 서로 멀리 떨어진 문장의 관계는 별도 검토가 필요할 수 있습니다.
- 분석 화면 왼쪽에서 실제 처리 구간 수와 현재 자료, **Jev 처리** 경로·미사용 사유를 확인합니다. **처리 내역**에는 표 데이터 행·Jev 호출과 판정 건수·Jev 개별 검토 판정·Codex 호출과 묶음 분석·재사용한 결과를 표시합니다. **Jev 판정 내역**을 펼치면 자료별 선택 결과·확신도·분석 경로를 조회합니다. 전체 구간 수가 확정되기 전에는 비율을 표시하지 않습니다. 추정 비용이나 완료 시간을 실제 측정값처럼 표시하지 않습니다.
- 결과는 부분 그래프로 저장합니다. 그래프 화면의 **이전·다음 / 그래프 선택**으로 모든 결과를 열 수 있습니다. 객체는 온톨로지·유형·기본 키를 기준으로 연결하며 서로 다른 온톨로지는 구분해 보관합니다.
- 실패하거나 취소한 구간은 완료로 세지 않습니다. 저장 결과와 구간 진행 위치는 함께 확정하여 재개 시 완료 구간을 다시 분석하지 않습니다.

선택적으로 `.env.local`에 `CLUEVIA_MAX_UPLOAD_MB=100`처럼 서버 운영 한도를 설정할 수 있습니다. `0`은 용량 상한 해제입니다. 변경 후 서버를 재시작하세요. **완성된 그래프 JSON 가져오기**의 2MB 및 그래프당 객체 수 제한은 별도이며, 원본 자료 파일의 업로드 한도와는 다릅니다.

## 온톨로지 빌더

Codex는 핵심 객체·속성·관계와 매핑을 간결한 설계도로 작성합니다. 서버의 빌더가 반복되는 메타데이터와 기본값을 채우고 검증합니다. 홈에서 분석할 때 자동 사용하며, 로컬 스크립트도 제공합니다.

```powershell
python scripts/build_ontology.py --template commerce | Set-Content -Encoding utf8 blueprint.json
python scripts/build_ontology.py blueprint.json | Set-Content -Encoding utf8 ontology.json
```

스크립트는 모델 호출 없이 설계도 JSON을 검증·확장합니다. 원본의 업무 식별자와 서버가 부여하는 출처·추출 기록 ID는 `valueSource`로 구분합니다. 세부 계약과 실패 작업 재개 방법은 [대용량 처리 상세](docs/large-data.md)를 참고하세요.

## 자체 온톨로지와 그래프 생성

```text
질문 + 첨부 자료
  → 확인 질문과 답변 → 사용자가 분석 목적·범위·결과 확정
  → Codex: 객체 유형·속성·관계·식별 키·자료 매핑 설계
  → 버전이 있는 OntologyDefinition 검증·저장
  → 자료 없음: 구조만 저장하고 종료
  → 표 데이터: 검증된 매핑으로 전체 레코드 변환
  → 표의 본문·설명: Jev 반복 분류·관계 유형 후보 판정
  → 독립적인 짧은 기록은 묶어서 Codex 분석, 복잡·불확실한 기록은 개별 분석
  → 조건을 만족하는 단순 관계는 Jev 직접 추출도 사용
  → 속성 타입·관계 끝점·참조·원문 인용 검증
  → GraphDocument 생성 + SQLite에 객체·관계·근거 저장
  → Board / Lanes / Timeline 렌더링
```

| 구성 | 구현 범위 |
| --- | --- |
| Object Type / Property | 분석마다 생성되는 유형, 기본 키·표시 이름, 22개 기본 타입 이름, 속성 검증 및 표시 메타데이터 |
| Link Type | 관계별 출발·도착 객체 유형과 1:1·1:N·N:1·N:M 선언 |
| Shared Property / Interface / Value Type | 공유 속성, 속성·관계 계약, 의미와 값 제약 |
| Group | 객체 유형의 분류 |
| Action Type / Function | **실행되지 않는 설계 초안**. 동작을 설명하는 파라미터·대상 유형 메타데이터만 저장 |
| 식별·버전 | 온톨로지 ID·버전과 객체 유형·기본 키 기준. 분석 재개 시 저장된 정의 사용 |
| 근거·주장 | 원문 인용, 자료별 속성, 보고/추론 구분을 보관 |

Palantir의 [Ontology 유형 개념](https://www.palantir.com/docs/foundry/object-link-types/type-reference)을 참고한 자체 구현입니다. Foundry API나 조직의 Ontology를 호출하지 않습니다. 기본 타입 이름을 지원하는 것과 Foundry의 전체 기능 구현은 다릅니다. 미디어·첨부·시계열·마킹·암호화 타입은 참조 값을 담는 스키마이며, 파일 업로드 처리·시계열 엔진·접근 제어·암호화 기능을 제공하지 않습니다. 인터페이스의 검색 및 표시 힌트도 계약 메타데이터이며 별도의 전문 검색 인덱스를 생성하지 않습니다.

선박 유형은 기존 예제에만 남아 있고 새 분석의 고정 기본 유형이 아닙니다. 그래프 조립과 배치는 코드가 담당합니다. 인용문 검증은 원문에 인용이 있는지 확인하며, 모델의 의미 해석이 사실임을 보증하지 않습니다.

- 온톨로지 계약: [src/types/ontology.ts](src/types/ontology.ts)
- 추출 검증·그래프 변환: [server/ontology.ts](server/ontology.ts)
- 누적 지식·원문 저장: [server/ontology-store.ts](server/ontology-store.ts)
- 작업 관리: [server/jobs.ts](server/jobs.ts)
- Jev API 연결: [server/jev.ts](server/jev.ts), [대용량 처리 상세](docs/large-data.md)
- Codex 실행: [server/codex.ts](server/codex.ts), [상세 설명](docs/codex-wrapper.md)
- 그래프 계약·검증: [src/types/graph.ts](src/types/graph.ts), [src/lib/graph-document.ts](src/lib/graph-document.ts)
- 렌더러: [src/components/graph/GraphRenderer.tsx](src/components/graph/GraphRenderer.tsx)

## 저장과 환경 설정

설정이 필요하면 `.env.example`을 `.env.local`로 복사하세요. **기존 `.env.local`은 덮어쓰지 마세요.** 변경 후 서버를 재시작합니다. Codex 인증 파일이나 토큰을 프로젝트에 복사할 필요는 없습니다.

| 변수 | 기본값 / 용도 |
| --- | --- |
| `TYPESAFE_API_KEY` | TypeSafe API 키. 서버에서만 사용. 비우면 Jev 연결 안 함 |
| `TYPESAFE_MODEL` | `jev-1.13.0`. 사용할 Jev 모델 |
| `TYPESAFE_CONCURRENCY` | `4`. Jev 동시 요청 수, 1–16 범위 |
| `TYPESAFE_TIMEOUT_MS` | 요청당 `30000`ms. 1000–120000 범위 |
| `TYPESAFE_MIN_CONFIDENCE` | `0.85`. 판정 수용 기준, 0.5–1 범위. 실제 정확도 보장값이 아님 |
| `CLUEVIA_JEV_FALLBACK` | 이전 방식 작업의 Codex 추가 분석 설정. 새 온톨로지 기반 작업은 불확실한 Jev 판정을 항상 Codex로 넘김 |
| `CODEX_BIN` | 비우면 프로젝트에 설치된 CLI 사용. 다른 실행 파일은 경로로 지정 |
| `CODEX_MODEL` | 기본 `gpt-6.1-sol` |
| `CODEX_REASONING_EFFORT` | 기본 `xhigh`; `low`, `medium`, `high`, `xhigh`, `max` |
| `CODEX_ONTOLOGY_EFFORT` | 온톨로지 설계 기본 `high` |
| `CODEX_CLARIFICATION_EFFORT` | 사용자에게 할 범위 확인 질문 생성 기본 `medium` |
| `CODEX_JEV_PLANNING_EFFORT` | Codex의 Jev 반복 판정 규칙 설계. 기본 전역 effort(`xhigh`) |
| `CODEX_EXTRACTION_EFFORT`, `CODEX_CHAT_EFFORT` | 사실 추출·복잡한 원문 검토·케이스 대화. 기본 전역 effort(`xhigh`) |
| `CODEX_TIMEOUT_MS` | 추출 1회당 180000ms. 10000–600000 범위 |
| `CLUEVIA_DATA_DIR` | `.cluevia`. SQLite 데이터 디렉터리 |
| `CLUEVIA_SEED_EXAMPLE` | `true`. 최초 GFW 사례 등록. `false`는 새 워크스페이스를 비워 둠 |
| `CLUEVIA_MAX_UPLOAD_MB` | `0`. 원본 파일 크기 상한 없음. 양수는 파일당 MiB 제한 |
| `CLUEVIA_ACCESS_TOKEN` | 외부 접속용 공용 워크스페이스 키. 설정 시 최소 16자 |
| `CLUEVIA_HOST`, `PORT` | `npm start`의 주소와 포트. 기본 `127.0.0.1:5173` |

표 데이터의 각 행은 검증된 매핑으로 서버에서 변환합니다. 온톨로지 설계용 자료와 문서 분석에 필요한 내용은 연결한 Codex 또는 TypeSafe 모델로 전송됩니다. API 키를 `VITE_` 환경 변수나 프런트엔드 코드에 넣지 마세요. 업로드를 완료한 원문은 분석 시작 전부터 서버의 `.cluevia/ontology.sqlite`에 저장됩니다. 성공한 구간의 그래프·인용 근거와 작업 재개 위치도 함께 보관합니다. 중간에 취소해도 업로드가 완료된 파일과 이미 생성한 그래프는 남습니다. 전송 자체가 중단된 파일의 미완성 데이터는 삭제합니다. 이 디렉터리와 `.env.local`은 Git에서 제외합니다. 백업하려면 서버를 종료한 뒤 **데이터 디렉터리 전체**를 복사하세요. SQLite WAL 사용 중 DB 파일 하나만 복사하면 최신 기록이 빠질 수 있습니다.

이 앱은 **하나의 공유 워크스페이스**입니다. 접속 키를 아는 사용자는 자료와 그래프를 함께 봅니다. 개인별 계정·자료 분리·역할별 권한은 아직 없습니다. 키를 비우면 실제 loopback 연결만 API를 사용할 수 있습니다. LAN이나 다른 컴퓨터에서 사용하려면 서버에 무작위 접속 키를 설정하고 웹 화면에서 입력하세요. 키는 현재 탭의 `sessionStorage`에 보관합니다. 인터넷 운영에는 HTTPS와 인증된 접근 경로를 사용하세요. 공개 리버스 프록시는 키 없이 연결하지 마세요.

## 빌드 결과 실행

```powershell
npm run build
npm start
```

`npm start`는 빌드된 웹 화면과 API를 함께 제공하는 Node 서버입니다. 개발 서버는 `npm run dev`, 빌드 미리보기는 `npm run preview`이며 둘 다 같은 API와 저장소를 사용합니다. 같은 데이터 디렉터리에 서버를 여러 개 실행하지 마세요.

LAN 운영 시 `.env.local`의 `CLUEVIA_HOST=0.0.0.0`과 `CLUEVIA_ACCESS_TOKEN`을 설정합니다. 호스트·포트 변수는 `npm start`에 적용됩니다. Vite 개발 포트는 `npm run dev -- --port 5173 --strictPort`처럼 지정합니다. `dist`만 정적으로 호스팅하면 생성·온톨로지 저장 API가 실행되지 않으므로 Node 서버가 필요합니다.

## API

키가 설정되었다면 `Authorization: Bearer <워크스페이스 키>`를 사용합니다.

| 요청 | 기능 |
| --- | --- |
| `GET /api/system/status` | 연결·엔진·저장소 상태 |
| `POST /api/analysis/clarify` | `{question, sources:[{id,name,size,excerpt}], answers:[{question,answer}], round:0..2}` → 확인 질문 또는 수정 가능한 분석 범위. 업로드·작업 생성 없음 |
| `POST /api/documents/upload` | 원시 파일 본문, `Content-Type: application/octet-stream`, `X-File-Name: encodeURIComponent(name)` → `201 {document}` |
| `GET /api/documents/:id` | 업로드 완료된 파일의 크기·구간 수 |
| `POST /api/jobs` | `{question, documents:[{id,name,text,url?}], uploadIds?:string[], analysisBrief?:{objective,scope,output,answers}}`로 생성 요청. 큰 파일은 업로드 ID 사용. `202 {job}` 반환 |
| `GET /api/jobs`, `GET /api/jobs/:id` | 작업 목록·진행 상태 |
| `POST /api/jobs/:id/cancel` | 생성 취소. 완료된 부분 그래프 유지 |
| `POST /api/jobs/:id/resume` | 저장된 진행 위치부터 이어서 분석 |
| `GET /api/graphs`, `GET /api/graphs/:id` | 저장 그래프 목록·내용 |
| `GET /api/graphs/:id/collection` | 같은 작업의 전체 부분 그래프 목록·진행 상태 |
| `POST /api/graphs/import` | `{graph}` 완성 JSON 저장 |
| `GET /api/ontology` | 생성된 온톨로지 정의 목록·누적 통계 |
| `GET /api/ontology/definitions/:id` | 버전·유형·속성·관계·처리 정책을 포함한 정의 |
| `GET /api/ontology/entities?q=&type=&ontologyId=` | 객체 검색·온톨로지별 필터 |
| `GET /api/ontology/entities/:id` | 객체·자료별 주장·관계·근거 |

기존 Foundry 모듈 `server/aip.ts`는 남겨 두었지만 현재 홈과 서버는 Codex 온톨로지 설계·표 데이터 변환·문서 분석·선택적 Jev 경로를 사용합니다. 예전 `/api/aip/status`, `/api/graphs/generate`는 현재 앱에서 연결하지 않습니다. Foundry 환경 변수는 필요하지 않습니다.

## GFW 예제와 지원 범위

**GFW 공개 사례** 또는 `/case/gfw-galapagos/board`는 미리 작성된 역사적 예제입니다. 12개 객체·15개 관계·2개 사건·3개 출처를 담았으며 새로 생성하는 그래프의 개수는 질문과 모델 추출 결과에 따라 달라집니다.

- [Global Fishing Watch 지도 소개](https://globalfishingwatch.org/our-map/)
- [2017년 선박 조우 분석](https://globalfishingwatch.org/impacts/policy-compliance/transhippment-reefer-illegal-sharks/)
- [상어 어획 사건 후속 보고](https://globalfishingwatch.org/success-story/data-and-analysis-help-track-illegal-shark-fishing/)

예제 [JSON](public/examples/gfw-galapagos.json)과 [출처 요약 TXT](public/examples/gfw-source-notes.txt)는 공식 문헌을 정리한 자료입니다. 실시간 AIS·현재 선박 위치가 아닙니다. 해상 조우만으로 화물 이전을 입증하지 않습니다. `reported`와 `inferred` 관계는 표시를 구분합니다.

- 자료는 한 작업에 최대 10개입니다. 원본 파일 크기 상한은 기본적으로 없으며 각 모델 호출의 입력은 구간 크기로 제한합니다. PDF·사진·Office·압축 파일은 별도 내용 추출이 필요하며 아직 자동 변환하지 않습니다. 이 파일들은 내용을 추출해 UTF-8 텍스트로 첨부합니다. API의 인라인 `documents`는 기존 5만 자/전체 15만 자 한도를 사용하며, 큰 본문은 파일 업로드 API로 전송합니다.
- URL만 입력해 웹을 자동 수집하는 기능은 없습니다. 저장된 지식 검색은 문서·객체의 텍스트 관련도 기준이며 외부 DB를 조회하지 않습니다.
- 완성된 그래프 JSON은 서버에 가져오기·내보내기가 가능합니다. 서버가 없을 때만 명시적으로 선택한 브라우저 저장 대안을 제공합니다.
- 기존 `/case/0143/*`는 디자인 데모이며 후속 대화·자동 외부 작업은 실제로 실행하지 않습니다. 생성 그래프에서는 실제 구현된 탐색 기능을 제공합니다.
- 스키마 수정 UI, 사용자별 권한, 자료 삭제·보관 기간 관리, 자동 웹 수집은 현재 범위에 포함하지 않습니다.

## 검증

```powershell
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

단위·HTTP 통합 테스트는 스키마, 정확한 인용, 식별·저장, 작업 취소·재시작·수정 재시도, 인증, wrapper 처리를 검증합니다. 브라우저 테스트의 생성 API는 모의 응답이며 테스트마다 실제 모델을 호출하지 않습니다. 실제 로그인된 Codex로 별도 검증도 진행했습니다. 이전 처리 경로에서 저장된 GFW 자료에 질문하여 객체 11개·관계 10개·사건 2개가 생성됐고, 그래프 새로고침 및 온톨로지 근거 조회까지 확인했습니다. 이 결과는 해당 실행의 검증 기록이며 모델 출력 개수를 고정하지 않습니다.

Jev 연결과 하이브리드 처리의 자동 검증은 모의 모델 응답을 사용합니다. 실제 TypeSafe 키로 명시적 한 문장 관계의 API 호출·그래프 저장·캐시 재사용도 확인했습니다. 이 단일 사례는 새 도메인 전체의 정확도나 대용량 처리 성능을 보장하지 않습니다. 브라우저 테스트에는 Jev·구조화 그래프의 부분 결과 이동, 처리 수치 표시, 모바일 화면이 포함됩니다.

Playwright는 기본적으로 개발 서버를 시작합니다. 외부 테스트 서버는 `PLAYWRIGHT_BASE_URL`, 기존 Chromium은 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`로 지정합니다.

## 통합 케이스와 대화

분석 구간은 Record로 보존하고 `/analysis/:jobId`에서 하나의 통합 그래프를 보여줍니다. 같은 저장 객체 ID를 연결하며 상충하는 속성은 기록별로 남깁니다. [설계와 기존 데이터 처리](docs/analysis-case.md)를 참고하세요.

- 보관함의 휴지통으로 케이스를 영구 삭제합니다. 진행 중인 생성·대화를 종료한 뒤 결과, 기록, 대화, 전용 업로드를 지웁니다. 다른 케이스에서 함께 사용하는 자료는 유지합니다. 예전 캐시에는 소유 케이스 정보가 없어 삭제 시 추출·판정 캐시를 비웁니다. 외부 백업 파일은 삭제하지 않습니다.
- 케이스 내부 패널은 그래프 상단 버튼으로 접습니다. 전체 보관함과 독립적으로 동작합니다. 출처 목록은 기본으로 닫힙니다.
- 노드를 드래그하면 연결 화살표도 함께 이동합니다. 배치는 현재 브라우저에 케이스·보기별로 저장합니다.
- 완료된 케이스에서는 왼쪽 Codex 대화창에 질문합니다. 선택한 노드를 함께 보낼 수 있으며, 답변의 인용을 누르면 해당 Record를 엽니다. 대화는 서버에 저장됩니다. 전체 그래프에서 관련 객체와 최대 8개 기록 원문을 조회하며, 실제 참고 범위를 표시합니다. 대화는 결과를 수정하거나 인터넷을 검색하지 않습니다.
- 기본 Codex 모델은 `gpt-6.1-sol`입니다. 온톨로지 설계는 `high`, 사용자 질문 생성은 `medium`, Jev 규칙 설계·사실 추출·케이스 대화는 `xhigh`를 기본으로 사용합니다. 공식 설정 근거: [모델](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Codex 설정](https://learn.chatgpt.com/docs/config-file/config-reference). 모델 접근 권한과 실제 호출 가능 여부는 사용 중인 계정에 따라 달라집니다.

### 가벼운 온톨로지 설계

로컬 빌드 CLI는 Python 3.10 이상과 표준 라이브러리만 사용합니다. 서버는 프로세스를 추가 실행하지 않고 기존 공통 검증기로 모델의 간결한 설계도를 확장·검증합니다. 기본 모델 출력에서는 불필요한 확장 리소스와 속성의 null 필드를 제거했습니다. 분석에 필요 없는 관리용 컬럼은 `retainedColumns`로 원문에 보관하며, 사실 관계를 포함하는 서술은 `semanticColumns`로 계속 분석합니다. 식별 키·근거 검증은 유지합니다.

Python CLI는 키와 기본 참조를 검사하는 작성 도구입니다. 고급 Interface·Value Type·제약의 최종 검증은 서버 공통 검증기가 담당합니다. Python 전환만으로 전체 LLM 시간이 줄었다고 가정하지 않습니다. 스키마 설계는 `high`로 실행하고, 필요한 Jev 반복 판정 규칙은 별도 `xhigh` 호출에서 작성합니다. 두 단계 모두 간결한 스키마와 짧은 자료 프로필을 사용합니다.

## 분석 성능·근거 검증 개선

실행 한도와 단계별 설정, 원문 검색·범위 필터, 주장 검토, 온톨로지 재사용, 큰 그래프 탐색 및 실제 모델 평가 결과는 [분석 개선 문서](docs/analysis-improvements.md)를 참고하세요. `npm run eval:analysis`는 오프라인 검사, `npm run eval:analysis -- --live`는 가상 자료를 사용하는 실제 모델 평가입니다.
