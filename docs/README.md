# Cluevia 문서

Fumadocs·Next.js·MDX로 만든 별도 문서 사이트입니다. Node.js 22.12 이상을 사용하며, 아래 명령은 저장소 루트에서 실행합니다.

## 문서 구성

문서의 시작점은 `/docs`이며 메인 알고리즘은 **Why-not Tree → Gap Find → Gap Fill**입니다. [메인 알고리즘 지침서](content/docs/main-algorithm/overview.mdx)에서 시작해 데이터 계약 → Gap Find → 출처 계보·신뢰도 → Gap Fill → 전체 예제 → 구현·검수 기준 순으로 읽습니다.

`content/docs/main-algorithm/`은 앞으로 구현할 설계 지침입니다. 사용자 확정 요구, 구체화 규칙, 제안 정책을 구분하며 NOT는 부정 입증 근거의 AND 결합으로 확정했습니다. 신뢰도 수치·임계값·등급표·탐색 예산은 명시적으로 상태를 표시합니다. 예제 숫자를 운영 기본값이나 검증된 확률로 승격하지 않습니다.

`content/docs/algorithms/`는 현재 앱 구현을 설명합니다. 온톨로지 기반 추출·검증·그래프 배치·관계선·시간축·검색을 코드와 연결합니다. 목표 알고리즘과 현재 코드의 구현 여부를 섞지 않습니다.

문서 변경 시 **입력·출력 → 판정·분기 → 실패와 미상 처리 → 예제 → 검수 기준**을 유지하세요. 공백 타입 여섯 개와 단계 번호를 다른 페이지에서도 일치시키고, 같은 근거를 여러 번 세거나 AND 필수 요구를 삭제해 통과시키는 예제를 만들지 않습니다.

기존 `docs/analysis-case.md`, `docs/large-data.md`, `docs/analysis-improvements.md` 등 서버 설계·평가 자료는 그대로 유지합니다. 사이트의 MDX 문서는 이 자료와 현재 구현을 연결해 설명합니다.

## 설치와 실행

```bash
npm run docs:install
npm run docs:dev
```

문서 주소는 `http://127.0.0.1:3001`입니다. Cluevia 앱은 별도 터미널에서 `npm run dev`로 실행하며 기본 주소는 `http://127.0.0.1:5173`입니다.

`docs:dev`, `docs:build`, `docs:typecheck`는 필요한 실행 파일과 현재 운영체제의 네이티브 의존성을 먼저 확인합니다. 설치가 없거나 Windows와 WSL 사이에서 실행 환경을 바꿨으면 문서 의존성을 자동으로 다시 설치합니다. 첫 실행이나 환경 전환 시에는 인터넷 연결이 필요하며 설치 시간이 걸릴 수 있습니다. 정상 설치 상태에서는 바로 실행합니다.

PowerShell에서 `'next' is not recognized`가 나오는 이전 실행 명령을 사용했다면, 같은 PowerShell에서 위 두 명령을 차례로 실행하세요. 루트 앱과 문서 사이트의 의존성은 별도입니다. Windows와 WSL 서버가 같은 `docs/node_modules`를 동시에 사용하지 않도록 실행 중인 문서 서버를 먼저 종료하세요.

## 편집과 검증

- `content/docs/**/*.mdx`: 문서 본문과 `title`·`description` frontmatter
- `content/docs/**/meta.json`: 사이드바 이름과 문서 순서
- `components/home.tsx`, `app/global.css`: 랜딩 페이지와 시각 스타일
- `lib/layout.shared.tsx`: 공통 내비게이션

```bash
npm run docs:typecheck
npm run docs:build
npm run test:docs
```

`test:docs`는 루트의 Playwright 의존성과 `docs/playwright.config.ts`를 사용합니다. 처음에는 루트에서 `npm ci --include=dev`, `npx playwright install chromium`으로 준비하세요. 기본적으로 문서 개발 서버를 실행하며, `DOCS_BASE_URL`을 지정하면 이미 실행 중인 서버를 검사합니다. 이 변수에 `docs/out/`을 제공하는 정적 서버 주소를 지정하면 프로덕션 빌드도 같은 테스트로 확인할 수 있습니다.

개발·빌드 시작 시 `scripts/prepare-assets.mjs`가 상위 앱의 `public/brand`, `public/fonts`, `public/examples`를 문서의 `public/`으로 복사합니다. 이 공통 자산은 앱 원본에서 수정하세요.

## 수식과 연구 그림

- `components/research.tsx`: `Equation`의 `tex`에 LaTeX를 전달하면 서버에서 KaTeX HTML·MathML로 조판합니다. 수식 오류는 빌드에서 검사합니다.
- `components/research-figures.tsx`: 논리 트리, binding, 사건 구간, 공백 관문, 출처 계보 등의 SVG 도식과 그림 캡션입니다.
- `components/research-explorers.tsx`: 자료 존재와 결합 가정을 바꾸어 볼 수 있는 두 설명용 예제입니다.
- `evaluations/illustrative-figures.json`: 실측 평가와 분리한 그림의 입력 가정입니다.
- `public/figures/`: Matplotlib으로 생성한 여섯 그래프의 밝은·어두운 SVG, PNG, PDF입니다. 그림 아래에서 원본을 내려받을 수 있습니다.

그림을 재생성할 때만 Python이 필요합니다. 정적 자산을 저장소에 포함하므로 문서 빌드와 열람에는 필요하지 않습니다.

```bash
python3 -m pip install -r docs/scripts/requirements-figures.txt
python3 docs/scripts/render-research-figures.py
```

그래프는 알고리즘의 계산 구조를 설명하는 자료입니다. 측정된 정확도나 실행 시간으로 표기하지 않습니다. 그림과 본문의 가정을 함께 수정하고, 실행 예제의 B=0.72·C=0.78·D=0.92625를 일치시킵니다.

## 앱으로 이동하는 링크

기본 앱 URL은 `http://127.0.0.1:5173`입니다. 변경하려면 `docs/.env.example`을 참고해 `docs/.env.local`에 설정하거나 빌드 환경 변수로 제공합니다.

홈의 **Cluevia 열기**, **Cluevia 시작하기**와 문서 내 앱 링크는 모두 이 설정을 사용합니다. 로컬 빌드에서는 별도 설정이 필요하지 않습니다. 기존 `docs/.env.local`에 터널·배포 주소가 있다면 아래 값을 사용한 뒤 다시 빌드하세요.

```dotenv
NEXT_PUBLIC_CLUEVIA_URL=http://127.0.0.1:5173
```

배포할 때는 공개 앱 주소로 바꿀 수 있습니다.

```dotenv
NEXT_PUBLIC_CLUEVIA_URL=https://app.example.com
```

이 값은 공개 설정이며 **빌드 시 정적 페이지와 브라우저 코드에 반영**됩니다. 배포 후 주소를 변경하려면 다시 빌드하세요. 문서 사이트에는 모델 로그인이나 API 키가 필요하지 않습니다.

## 정적 호스팅

문서 왼쪽 아래의 언어 버튼은 **한국어 → English → 日本語 → 中文(간체)** 순서입니다. 번역본을 사이트에 직접 저장하며 언어를 바꾸면 현재 문서와 절에 대응하는 페이지로 이동합니다. 열람 중 외부 번역 서비스를 호출하지 않습니다.

- 한국어: `/docs/.../`, 영어: `/en/docs/.../`, 일본어: `/ja/docs/.../`, 중국어: `/zh/docs/.../`
- 원문 `name.mdx`에 대응하는 번역본은 `name.en.mdx`, `name.ja.mdx`, `name.zh.mdx`입니다. 사이드바는 같은 폴더의 `meta.<언어>.json`을 사용합니다.
- `lib/locales/*.json`은 공통 화면·그림 설명의 번역입니다. 수식과 API 식별자, 실행 가능한 코드 예시는 원문을 유지합니다. 정적 분석 그래프의 축·범례는 공통 영문 표기를 사용하고 캡션은 각 언어로 제공합니다.
- 일본어·중국어는 `public/cjk-fonts/`의 Noto Sans JP·SC를 사용합니다. 글꼴을 직접 제공하고 Unicode 범위별로 필요한 파일만 읽으므로 기기에 해당 글꼴이 없어도 문자가 표시됩니다. 원본 출처와 OFL 라이선스는 같은 폴더에 있습니다.
- 번역 문서의 제목 끝에 있는 `[#원문-heading-id]`를 유지하면 언어 전환 시 같은 절로 이동합니다. 본문 변경 시 세 번역본과 `content/translation-manifest.json`의 원문 해시를 함께 갱신하세요.
- 초안 번역 후 용어와 수식·예제 일치를 검토했으며, 전문 번역가의 별도 감수를 받은 문서라는 의미는 아닙니다. 판정 의미를 변경할 때는 한국어 원문과 각 번역본을 함께 검토합니다.

`npm run docs:build`는 `docs/out/`에 사이트를 생성합니다. 이 폴더를 웹 루트로 배포하며 Node 서버는 필요하지 않습니다.

빌드 후 `scripts/normalize-export.mjs`가 Windows에서 중첩 경로로 생성된 Next 문서 이동용 파일을 브라우저가 요청하는 파일명으로 복사합니다. 추가 서버 설정 없이 미리 읽기와 언어 전환이 동작하도록 하는 호환 처리이며, 다른 운영체제의 정상적인 출력은 그대로 둡니다.

로컬에서 빌드 결과를 확인하려면 저장소 루트에서 다음 명령을 실행하세요.

```sh
npm run docs:build
npm run docs:preview
```

`http://127.0.0.1:3001`에서 문서를 열 수 있습니다. 같은 포트의 개발 서버를 먼저 종료하세요. 개발 중 자동 갱신은 `npm run docs:dev`, 정적 열람 중 변경 반영은 `npm run docs:build`를 사용합니다. 정적 서버 포트는 `DOCS_PORT`로 바꿀 수 있습니다. 앱과 문서를 함께 빌드하려면 `npm run build:all`을 사용하고, 앱은 별도 터미널에서 `npm start`로 실행합니다.

- `/docs/.../` 요청에 해당 폴더의 `index.html`을 제공하도록 디렉터리 인덱스를 지원해야 합니다.
- 문서 검색은 언어별 정적 인덱스(`/search-index.json`, `/en/search-index.json`, `/ja/search-index.json`, `/zh/search-index.json`)를 읽습니다. 현재 언어의 본문만 내려받습니다. 일반 정적 JSON 파일로 제공하면 되며 별도 rewrite가 필요하지 않습니다.
- 모든 경로를 홈페이지 HTML로 돌려주는 SPA fallback은 사용하지 마세요. 검색 요청이나 문서 경로가 홈페이지로 바뀌면 정상 동작하지 않습니다.

앱의 `dist/`와 문서의 `out/`은 별도 결과물입니다. 앱과 Node API 서버의 배포 범위는 [배포 문서](content/docs/development/deployment.mdx)에 정리되어 있습니다.
