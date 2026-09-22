# NEON PROTOCOL — 웹 기반 실시간 멀티플레이어 전술 슈팅

Three.js(3D 렌더링 + cannon-es 충돌) + Node.js/Express/Socket.io(실시간 방 시스템)로 만든
발로란트 스타일 전술 슈팅 프로토타입입니다. 빌드 과정 없이 브라우저에서 바로 실행되며,
방 링크(`?room=코드`)만 공유하면 다른 사람이 같은 매치에 들어옵니다.

> 무기/맵 이름은 발로란트의 실제 상표(Vandal, Phantom, Bind 등)를 그대로 쓰지 않고
> "Sidearm / Viper / Falcon / Raptor / Vanguard / Reaper" 같은 오리지널 이름으로
> 재구성했습니다. 가격·데미지·탄창 곡선은 권총 → SMG → 라이플 → 저격 구조를 그대로 따릅니다.

## 1. 프로젝트 구조

```
valorant-web/
├── package.json          # express, socket.io 만 의존 (빌드 툴체인 없음)
├── server.js              # Express 정적 서빙 + Socket.io 방/경제/라운드 로직
├── README.md
└── public/
    ├── index.html          # 로비 화면 + HUD + 상점 오버레이 + importmap
    ├── css/
    │   └── style.css        # 사이버펑크 톤의 HUD/상점 스타일
    └── js/
        ├── main.js           # Three.js 씬, 카메라/이동, 사격, 소켓 연동 (엔트리 포인트)
        ├── network.js        # Socket.io 클라이언트 래퍼 + 스냅샷 보간 버퍼
        ├── mapBuilder.js     # 맵 지오메트리/조명/사이트 마커 생성
        ├── players.js        # 원격 플레이어 메시 + 보간 렌더링
        ├── weapons.js        # 클라이언트용 무기 카탈로그 (상점 UI용)
        ├── economy.js        # 구매 단계 상점 UI 바인딩
        └── hud.js            # HP/탄약/타이머/킬피드 등 HUD 업데이트 함수
```

**빌드 스텝이 없는 이유**: Vite 대신, Three.js·cannon-es를 브라우저의 `<script type="importmap">`
으로 CDN(unpkg)에서 바로 불러오는 방식을 택했습니다. Glitch·StackBlitz 양쪽에서 `npm install && npm start`
만으로 즉시 뜨는 것이 "링크 공유"라는 핵심 요구사항에 더 중요하다고 판단했기 때문입니다.
로컬에서 Vite 개발 서버(HMR)로 프론트엔드만 따로 굴리고 싶다면, `public/`을 Vite 프로젝트의
루트로 잡고 `vite.config.js`에 `server.proxy['/socket.io'] = 'http://localhost:3000'`을
추가하면 됩니다.

## 2. 로컬 실행

```bash
npm install
npm start
# http://localhost:3000 접속
```

같은 컴퓨터에서 두 번째 탭을 열거나, 같은 네트워크의 다른 사람이 `http://<내-IP>:3000`으로
접속하면 바로 같은 서버에서 멀티플레이가 됩니다. 인터넷 너머의 친구와 하려면 아래 배포
가이드를 따라 공개 URL을 만드세요.

## 3. 핵심 시스템 설명

### 맵 (`mapBuilder.js`)
- 사이버펑크 네온 라이트(청록 A사이트, 레드 B사이트, 보라 미드) + 고전 건축 양식의
  대리석 기둥·엔타블러처가 섞인 중앙 구조물.
- `DirectionalLight`(그림자 캐스팅) + `AmbientLight` + `HemisphereLight` + 사이트별
  `PointLight`로 대비가 있는 조명을 구성했습니다.
- 엄폐용 상자(Crates), 레인을 나누는 낮은 벽, A/B 두 개의 폭탄 설치 구역을
  `SITE_ZONES` 좌표(서버의 `SITE_ZONES`와 반드시 동일해야 함)로 명확히 배치했습니다.

### 경제 시스템 (`server.js` + `economy.js`)
- 라운드 시작마다 30초 구매 단계 → 100초 라운드 → 5초 라운드 종료 사이클을
  서버가 `setInterval`로 관장합니다(치팅 방지를 위해 크레딧/HP/라운드 판정은 전부 서버 권위).
- 승리 시 +3000 크레딧, 패배 시 연패 단계별 보상(1900→1900→2400→2400→2900→2900),
  킬 시 +200 크레딧을 지급합니다.
- 무기 8종(권총 4 / SMG 1 / 라이플 2 / 저격 1)의 가격·데미지·탄창·연사속도를
  `WEAPONS`(서버, 구매 검증용)와 `WEAPON_CATALOG`(클라이언트, UI 렌더링용)에 정의했습니다.

### 실시간 멀티플레이어 (`server.js` + `network.js`)
- 접속 시 `?room=코드`가 없으면 서버가 6자리 방 코드를 생성하고, 있으면 해당 방에 합류합니다.
  합류 직후 클라이언트가 `history.replaceState`로 주소창을 `?room=코드`로 바꿔주므로,
  그 상태에서 주소창을 복사(또는 HUD의 "🔗 링크 복사" 버튼)하면 바로 초대 링크가 됩니다.
- 이동은 클라이언트가 **50ms(20Hz) 주기**로 `move` 이벤트를 보내고, 서버는 같은 방의
  다른 플레이어에게 그대로 릴레이합니다.
- 수신 측(`network.js`의 `InterpolationBuffer`)은 들어오는 스냅샷을 타임스탬프와 함께
  버퍼에 쌓아두고, "현재 시각 - 100ms" 시점을 두 스냅샷 사이에서 선형 보간(lerp)하여
  렌더링합니다. 네트워크가 불규칙해도 순간이동처럼 튀지 않고 부드럽게 움직입니다.
- 사격은 클라이언트가 로컬 레이캐스트로 피격 여부를 1차 판정한 뒤 `report_hit`으로
  서버에 보고하고, 서버가 데미지를 클램프(1~150)하고 HP/킬/크레딧을 확정합니다.
  (데모 수준의 절충안입니다 — 프로덕션에서는 서버가 히트박스까지 직접 검증해야 안전합니다.)
- 폭탄 설치/해체는 서버가 좌표(`SITE_ZONES`)와 팀을 검증하고, 타이머(설치 4초/해체 7초/
  폭발 45초)를 서버 쪽에서 관리합니다.

## 4. 링크 생성 및 배포 가이드

### 방법 A — Glitch (권장: 진짜 상시 구동 서버)

Glitch는 브라우저 탭과 무관하게 계속 켜져 있는 실제 Node 서버이므로, 친구에게 보낸
링크가 여러분이 컴퓨터를 꺼도 계속 살아 있습니다(무료 플랜은 일정 시간 미접속 시 슬립
상태가 되며, 첫 접속 시 몇 초 깨어나는 시간이 걸릴 수 있습니다).

1. https://glitch.com 접속 → **New Project → Import from GitHub** (이 프로젝트를 GitHub
   레포로 올려둔 경우) 또는 **New Project → glitch-hello-node**로 빈 Node 프로젝트를 만든 뒤,
   `server.js`, `package.json`, `public/` 폴더 내용을 그대로 붙여넣기/업로드합니다.
2. Glitch가 자동으로 `npm install`을 실행하고 `npm start`(= `node server.js`)로
   서버를 띄웁니다. 상단의 **Preview** 또는 **Share** 버튼을 누르면
   `https://프로젝트이름.glitch.me` 형태의 공개 URL이 나옵니다.
3. 방을 만들고 싶다면 그냥 `https://프로젝트이름.glitch.me`로 접속해 "입장하기"를 누르세요.
   주소창이 `?room=AB12CD`로 바뀌면, 그 URL 전체를 복사해 친구에게 보내면 됩니다.
   친구는 그 링크를 열고 이름만 입력한 뒤 입장하면 바로 같은 매치에 합류합니다.

### 방법 B — StackBlitz (빠른 코드 확인·솔로 테스트용)

StackBlitz는 **WebContainers**라는 브라우저 내장 WebAssembly Node 런타임을 사용합니다.
즉 서버가 여러분의 브라우저 탭 안에서 돌아갑니다. 코드를 즉시 실행해보거나 혼자 테스트하기엔
최적이지만, **탭을 닫으면 서버도 같이 내려가고**, 미리보기 URL이 브라우저/세션에 따라
다른 사람에게 안정적으로 열리지 않는 경우가 있습니다. 친구와 실제로 같이 플레이할 안정적인
링크가 필요하다면 위의 Glitch(또는 Render, Railway 같은 상시 구동 호스팅)를 쓰는 것을
권장하며, StackBlitz는 "코드가 바로 돌아가는지 확인" 용도로 안내합니다.

1. https://stackblitz.com/fork/node (또는 New Project → Node.js 템플릿) 로 빈 프로젝트를 만듭니다.
2. 좌측 파일 트리에서 `server.js`, `package.json`을 만들고 이 문서의 코드를 붙여넣은 뒤,
   `public/` 폴더를 만들어 `index.html`, `css/style.css`, `js/*.js` 파일들을 그대로 추가합니다.
3. 터미널 탭에서 `npm install`을 실행하면 WebContainer가 의존성을 설치하고,
   `package.json`의 `start` 스크립트를 감지해 자동으로 서버를 띄웁니다.
4. 오른쪽 미리보기 패널에 뜨는 URL(`https://xxxxxxx.stackblitz.io` 형태) 상단의
   **새 창에서 열기** 버튼으로 열어 본인 탭에서 먼저 정상 동작을 확인한 뒤,
   실제 공유가 필요하면 Glitch 배포본의 링크를 사용하세요.

### 배포 전 체크리스트
- `package.json`의 `"start": "node server.js"`가 그대로인지 확인 (Glitch/StackBlitz 모두 이 스크립트로 서버를 켭니다).
- 포트를 하드코딩하지 않았는지 확인 — `server.js`는 `process.env.PORT`를 우선 사용하므로 별도 설정이 필요 없습니다.
- CORS는 데모 편의상 전체 허용(`origin: '*'`)으로 열어뒀습니다. 특정 도메인에만 배포한다면
  `server.js`의 `io = new Server(server, { cors: { origin: '*' } })` 부분을 실제 배포 도메인으로 좁히는 것을 권장합니다.

## 5. 알려진 한계 & 다음 단계 (프로덕션으로 발전시키려면)
- **안티치트**: 현재 피격 판정은 클라이언트 레이캐스트 → 서버 보고 방식입니다. 경쟁전 수준의
  무결성이 필요하면 서버가 각 플레이어의 위치/히트박스를 직접 들고 있다가 서버 사이드
  레이캐스트로 재검증해야 합니다.
- **이동 검증**: 서버는 클라이언트가 보낸 `position`을 그대로 신뢰합니다. 스피드핵 방지가
  필요하면 서버에서 프레임당 이동 가능 거리를 검증하세요.
- **3인칭/애니메이션**: 원격 플레이어는 캡슐+구체 메시로 단순화되어 있습니다. 실제 캐릭터
  모델·애니메이션 상태 머신을 붙이면 완성도가 크게 올라갑니다.
- **사운드/스킬**: 발소리, 총성, 스킬(어빌리티) 시스템은 포함되어 있지 않습니다.
