# 형제 레포 벤치마크 — sv-explorer vs 3개 레포

현재 레포(`orcus07/sv-explorer`)를 같은 소유자의 3개 레포(`PRIMITIVE_WEB`, `IR-Analysis`, `Mybots`)와
6개 축으로 비교한다. 판정 기준은 **"1인 운영 소형 웹앱 규모에 맞는가"** 이며,
더 정교하다는 이유만으로 채택하지 않는다. 확신이 없으면 **보류**로 둔다.

> 조사 방법: 각 레포를 `tree -L 2` → README → 핵심 설정(매니페스트·배포·CI·에이전트 자산) →
> 대표 소스 2~3개 순으로만 탐색(전체 정독 아님). 모든 주장에 근거 파일 경로를 병기한다.
> 클론은 `/tmp/bench/` 에 `--depth 1` 로 받아 working tree 밖에서 분석했다.

---

## 0. 현재 레포(sv-explorer) 요약

유튜브 링크를 던지면 **영상 구조를 타임스탬프 목차로 요약**하고 **자막을 한글·원문 병기로 정리**하는
Node/Express(ESM) 웹앱이다(`README.md`, `package.json`). 서버(`src/server.js`)는 **자막 수집만** 하는
얇은 역할이고, 무거운 Claude 호출은 **브라우저가 사용자 본인 키로 api.anthropic.com에 직접**
한다(`public/distill.js`) — Render 무료 티어의 연결 끊김을 우회하는 설계. 프론트는 바닐라 JS
(`public/app.js`, `public/distill.js`)이고 보관함은 IndexedDB에 저장한다. 배포는 Render 블루프린트
(`render.yaml`, healthCheck `/api/health`)이며 CI·테스트·에이전트 설정 자산(CLAUDE.md/.claude/.mcp.json)은
현재 없다.

### 비교 대상 3개 레포 한 줄 요약
- **PRIMITIVE_WEB** — 영문 링크 → 한글 증류 리더. sv-explorer와 **거의 같은 템플릿**의 Node/Express 웹앱
  (`src/server.js`, `src/lib/`, `public/`, `render.yaml`). 단 Claude 호출을 **서버에서** 한다
  (`render.yaml` 의 `ANTHROPIC_API_KEY`).
- **IR-Analysis** — 실적·컨콜 분석 **Python CLI 파이프라인**(`ir_analysis/analyze.py`). config 주도
  (`config/config.yaml`), **GitHub Actions 워크플로 보유**(`.github/workflows/analyze.yml`), 결과를
  `analyses/*.md` 로 커밋하고 Render 정적 사이트로 서빙(`render.yaml`, `render/build.py`).
- **Mybots** — 잡화(grab-bag) 레포. 루트에 낱개 HTML(`csp_chip_arch.html`, `nvidia_vera_rubin.html`)과
  `images/`, `project_summary.md`, 그리고 **별개 하위 프로젝트** `meeting-minutes/`(자체 Node 웹앱:
  `meeting-minutes/package.json`, `meeting-minutes/src/server.js`)가 섞여 있다.

---

## ① 프로젝트 구조·모듈화

- **최우수: IR-Analysis** — 관심사 분리가 가장 깔끔하다. 코드는 파이썬 패키지 `ir_analysis/`
  (`analyze.py` 파이프라인, `prompts.py`, `sync_personas.py`, `__init__.py`), **설정은 `config/`**
  (`config/config.yaml`, `config/personas/`, `config/style_guide.md`), **렌더링은 `render/`**
  (`render/build.py`, `render/template.html`), **산출물은 `analyses/*.md`** 로 물리적으로 나뉘어 있다.
  튜닝 노브(persona·target·model·effort·max_tokens)가 코드 밖 `config/config.yaml` 로 빠져 있다.
- **현재 레포(sv-explorer)** — 얇은 서버(`src/server.js`) + 라이브러리(`src/lib/fetchTranscript.js`,
  `src/lib/storyboard.js`) + 프론트(`public/`)로 나뉜 **표준적인 소형 웹앱 레이아웃**. PRIMITIVE_WEB
  (`src/server.js` + `src/lib/{fetchArticle,distill}.js` + `public/`)과 사실상 동일한 템플릿으로,
  웹앱 유형에는 적절한 모듈화다. 튜닝 상수는 `public/distill.js` 상단에 하드코딩(예: `MAX_OUT`,
  `CHUNK_CHARS`, `STRUCT_MODEL`).
- **최하: Mybots** — 서로 무관한 산출물(낱개 HTML)과 별도 웹앱(`meeting-minutes/`)이 한 레포에 섞인
  monorepo-그릇. 루트 README도 없다(`project_summary.md` 만 존재).
- **차이 원인** — IR-Analysis는 "같은 파이프라인을 변수만 바꿔 반복 실행"하는 성격이라 config/code 분리가
  본질적 이득이 크다. sv-explorer는 단일 웹앱이라 노브가 적고, 파일 분리가 이미 유형에 맞게 되어 있다.
- **판정: 보류** — sv-explorer 구조는 유형(1인 소형 웹앱)에 이미 적합. IR-Analysis식 **config 파일 외부화**는
  아이디어로만 참고. 지금 노브 수(수 개 상수)로는 별도 `config.yaml` 도입 이득이 작아 보류.

## ② 에러 핸들링·로깅

- **최우수: (실질 동률) sv-explorer ≈ IR-Analysis** — 런타임 회복력 기준.
  - sv-explorer: 라우트마다 try/catch → JSON 오류 + 상태코드(`src/server.js`), 그리고 클라이언트
    호출부에 **재시도·백오프**(`MAX_ATTEMPTS`)와 **분류 헬퍼**(`describeErr`/`isTransient`/`isModelError`),
    **모델 과부하·리네임 폴백**(Sonnet→Haiku)이 있다(`public/distill.js`). 진행 상황은 화면 다크 콘솔로
    노출(`logPush`/`logReset`, `public/app.js`).
  - IR-Analysis: `ir_analysis/*.py` 에 try/except 6곳, `ImportError` 시 친절한 안내 후 `sys.exit`
    (`ir_analysis/analyze.py`), Fable→Opus 안전 폴백(README 명시), Actions에 **push 충돌 rebase 재시도
    루프**(`.github/workflows/analyze.yml`).
- **현재 레포** — 위와 같이 이미 견고. 다만 **구조적 로깅 라이브러리는 없고** `console.log/warn` 4곳
  (`src/server.js`)뿐 — PRIMITIVE_WEB(`src/server.js` 의 `console.log/warn`), meeting-minutes
  (`Mybots/meeting-minutes/src/server.js`)도 동일하게 plain console. 네 레포 모두 구조적 로깅 없음.
- **차이 원인** — 규모가 작아 plain console로 충분. sv-explorer는 오히려 이번 세션에서 재시도/폴백을
  강화해 형제들과 동급 이상.
- **판정: 부적합(구조적 로깅 도입) / 현행 유지** — winston/pino 같은 구조적 로깅은 1인 소형 웹앱엔 과잉.
  현재의 try/catch + 상태코드 + 재시도/폴백이 규모에 맞는다. 차용할 방식 없음.

## ③ 테스트·검증 (smoke test 포함)

- **최우수: 해당 없음** — **네 레포 모두 테스트가 전무**하다. 3개 레포에서 테스트 파일(`*test*`,
  `*.spec.*`, `conftest*`) 0건, `package.json` 에 `"test"` 스크립트 없음(PRIMITIVE_WEB,
  `Mybots/meeting-minutes`), IR-Analysis에 pytest·`tests/` 없음. sv-explorer도 동일(`package.json` 에
  test/lint 스크립트 없음, `.github` 없음).
- **현재 레포** — 검증은 전적으로 수동. `render.yaml` 의 `healthCheckPath: /api/health` 가 사실상
  유일한 자동 헬스 신호.
- **차이 원인** — 전부 1인 실험성 프로젝트라 테스트를 생략. 형제 중 본받을 대상이 없음(공통 결함).
- **판정: 채택(넷-뉴, 최소 스모크)** — 형제에서 빌려올 방식은 없지만, **부팅 + `/api/health` 200 확인 +
  lib 모듈 import 성공** 수준의 초경량 스모크는 비용이 매우 낮고, 이 레포가 자주 배포되는 점을 감안하면
  회귀(부팅 실패·import 깨짐) 조기 검출 가치가 크다. 무거운 유닛 테스트 스위트는 **부적합/보류**.

## ④ CI·배포 (Render 설정, 환경변수 관리)

- **최우수: IR-Analysis (CI 한정)** — 유일하게 CI가 있다: `.github/workflows/analyze.yml` 은
  `workflow_dispatch` + 타입드 입력(회사·페르소나·모델·경쟁사), `concurrency` 그룹으로 동시 실행 직렬화,
  `permissions: contents: write`, `secrets.ANTHROPIC_API_KEY`/`PERSONAS_TOKEN`, **push 충돌 시 rebase
  재시도 루프**까지 갖췄다. 다만 이는 **테스트/린트 CI가 아니라 "제품을 실행"하는 배치 러너**다. 배포는
  `render.yaml`(static, `render/build.py` 빌드, 실패 시 커밋된 `docs/` 폴백).
- **현재 레포** — CI 없음(`.github` 부재). 배포는 `render.yaml`(web, `healthCheckPath: /api/health`,
  비밀은 `envVars … sync: false`), 환경변수는 `.env.example` 에 주석과 함께 문서화(SUPADATA_API_KEY,
  YT_PROXY, JINA_API_KEY, APP_ACCESS_TOKEN, DISABLE_CSP). **환경변수 관리 자체는 형제 중 가장 촘촘**하다.
- **다른 형제** — PRIMITIVE_WEB(`render.yaml` web + `ANTHROPIC_API_KEY sync:false`, `.env.example`),
  meeting-minutes(`Mybots/meeting-minutes/render.yaml` 에 `rootDir` + 두 키 `sync:false`). 둘 다 CI 없음.
- **차이 원인** — IR-Analysis는 "버튼 눌러 분석 실행"이 제품 자체라 Actions가 본질. sv-explorer는 상시
  구동 웹앱이라 필요한 CI는 **실행 러너가 아니라 push/PR 스모크·린트**다.
- **판정: 부분 채택** — IR-Analysis의 **정교한 배치 러너 워크플로는 부적합**(자동 커밋·rebase 루프는
  sv-explorer에 불필요). 반면 **최소 CI(`npm ci` + 스모크 실행 on push/PR)** 는 **채택** 권장 — 지금
  없는 "그린 체크"를 저비용으로 확보. Render 배포·환경변수 관리는 현행이 이미 우수 → 변경 불요.

## ⑤ 의존성 관리

- **최우수: (동률) sv-explorer ≈ PRIMITIVE_WEB** — npm + **lockfile 보유**(`package-lock.json`) +
  캐럿(`^`) 핀. sv-explorer 4개(`@anthropic-ai/sdk`, `dotenv`, `express`, `undici`),
  PRIMITIVE_WEB 6개(+`node-html-parser`, `pdf-lib`, `pdf-parse`)(`package.json`).
- **현재 레포의 결함 1건** — `@anthropic-ai/sdk` 가 `package.json` 에 있으나 **소스 어디에서도 import되지
  않는 사문화(dead) 의존성**이다(브라우저 직접 fetch로 전환됨; `src/`·`public/` 전수 grep 0건). `dotenv`·
  `express`·`undici`(동적 import, `src/lib/fetchTranscript.js`)만 실제 사용.
- **다른 형제** — IR-Analysis: `requirements.txt` 가 `>=` **하한만 지정, 락파일·해시 없음**
  (`anthropic>=0.92.0`, `PyYAML>=6.0`) → 재현성이 가장 느슨. meeting-minutes: `package.json` 에 8개
  의존성(ffmpeg-static, fluent-ffmpeg, multer, openai, youtube-transcript)인데 **트리에 `package-lock.json`
  부재**(락파일 없음으로 보임 — 미확정, 보류). Mybots 루트는 매니페스트 자체가 없음.
- **차이 원인** — Node 레포는 npm 관례상 락파일이 따라옴. IR-Analysis는 pip `>=` 로만 관리해 느슨.
- **판정: 채택(사문화 의존성 제거)** — sv-explorer는 이미 형제 중 최상급(락파일+캐럿). 유일한 개선은
  **`@anthropic-ai/sdk` 제거**(무비용·즉효). 형제에서 빌려올 방식은 없고, 오히려 IR-Analysis의 `>=`
  방식은 **부적합**(재현성 저하)이라 반면교사.

## ⑥ 에이전트 설정 자산 (CLAUDE.md, .claude/, .mcp.json)

- **최우수: 해당 없음** — **네 레포 모두 부재**. `CLAUDE.md`·`.claude/`(rules/skills/hooks/agents/commands)·
  `.mcp.json` 이 sv-explorer, PRIMITIVE_WEB, IR-Analysis, Mybots 어디에도 없다(각 레포 `find` 확인;
  IR-Analysis의 `.github/` 는 CI일 뿐 에이전트 자산 아님).
- **현재 레포** — 부재. 이 레포는 실제로 Claude Code로 반복 개발되는데(커밋·PR 이력), 반복되는 불변식이
  코드 주석에만 흩어져 있다(예: "서버는 자막만", 브라우저 직접 호출, 모델 ID를 커밋/PR에 넣지 않기,
  개발 브랜치·PR 플로우).
- **차이 원인** — 전부 에이전트 규약을 문서화하지 않고 애드혹으로 진행. 형제 중 본받을 대상 없음(공통 공백).
- **판정: 채택(최소 CLAUDE.md) / 보류(그 외)** — Claude로 자주 개발되는 레포라 **얇은 `CLAUDE.md`**(핵심
  불변식·명령·커밋 규약)는 저비용·고레버리지 → 채택. 반면 `.claude/rules·skills·hooks`, `.mcp.json` 은
  1인 규모에 셋업 대비 이득이 불명확 → **보류**.

---

## 축별 판정 요약

| 축 | 형제 최우수 | 현재 레포 위치 | 판정 |
|----|------------|----------------|------|
| ① 구조·모듈화 | IR-Analysis (config/code 분리) | 유형에 적합 | **보류** (config 외부화는 규모상 이득 작음) |
| ② 에러·로깅 | 동률(sv-explorer≈IR-Analysis) | 이미 견고 | **현행 유지** (구조적 로깅은 부적합) |
| ③ 테스트·검증 | 없음(공통 결함) | 없음 | **채택** (최소 스모크, 넷-뉴) |
| ④ CI·배포 | IR-Analysis (CI 보유) | CI 없음·배포/ENV는 우수 | **부분 채택** (최소 CI 채택 / 배치러너 부적합) |
| ⑤ 의존성 | 동률(sv-explorer≈PRIMITIVE_WEB) | 최상급 + 사문화 dep 1건 | **채택** (dead dep 제거) |
| ⑥ 에이전트 자산 | 없음(공통 공백) | 없음 | **채택**(최소 CLAUDE.md) / **보류**(그 외) |

---

## 채택 후보 Top 5 (구현 비용 대비 효과 순)

> 이 문서는 분석 산출물이며, 아래는 **권고안**이다(이 태스크에서 코드 변경은 하지 않음).

1. **`@anthropic-ai/sdk` 사문화 의존성 제거** — 축 ⑤.
   근거: `package.json` 에 선언됐으나 `src/`·`public/` 어디에서도 import 안 됨(브라우저 직접 fetch).
   비용 ~0(한 줄 삭제 + `npm install`로 락파일 갱신), 효과: 설치 용량·공급망 표면·혼란 감소. **즉시 실행 가치 최고.**

2. **초경량 스모크 테스트 + `npm run smoke`** — 축 ③.
   내용: 서버 부팅 → `/api/health` 200 확인 → `src/lib/*.js` import 성공 검증(Node `--test` 한 파일).
   비용 낮음(형제 어디에도 없는 넷-뉴, 하지만 단순), 효과: 부팅/모듈 회귀를 배포 전에 잡음. 자주 배포하는 이 레포에 특히 유효.

3. **얇은 `CLAUDE.md`** — 축 ⑥.
   내용: 핵심 불변식(서버는 자막만·브라우저 직접 호출·키는 서버에 두지 않음·ESM), 커밋/PR 규약
   (개발 브랜치, 모델 ID를 산출물에 넣지 않기), 실행 방법. 비용 낮음, 효과: Claude 개발 시 반복 실수 예방·온보딩.

4. **최소 CI 워크플로(`.github/workflows/ci.yml`)** — 축 ④.
   내용: push/PR에서 `npm ci` + `npm run smoke`(2번 완료 후). IR-Analysis의 정교한 배치 러너가 아니라
   **가벼운 게이트**만. 비용 낮음(2번 선행 필요), 효과: 지금 없는 "그린 체크" 확보, 회귀 자동 차단.

5. **(선택·낮은 우선) config 상수 외부화 or SessionStart 훅** — 축 ①/③, **보류 성격**.
   `public/distill.js` 상단 튜닝 상수를 한곳(파일 상단 블록/작은 config)에 모으거나, 배포 세션에서 스모크를
   자동 실행하는 SessionStart 훅. 이득이 규모 대비 작아 **여유 있을 때만**. 무리해서 도입할 필요 없음.

### 채택하지 않는 것(명시)
- **구조적 로깅 라이브러리(winston/pino)** — 1인 소형 웹앱엔 과잉(축 ②, 부적합).
- **IR-Analysis식 자동 커밋·rebase 재시도 배치 워크플로** — sv-explorer엔 자동 산출물 커밋 수요가 없음(축 ④, 부적합).
- **IR-Analysis식 `requirements`/`>=` 느슨한 핀** — Node 락파일+캐럿이 더 나음. 반면교사(축 ⑤).
- **`.claude/rules·skills·hooks`, `.mcp.json` 풀셋업** — 1인 규모 대비 이득 불명확(축 ⑥, 보류).
