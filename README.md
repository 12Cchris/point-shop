# 포인트 상점 v2.1.0

관리자가 회원에게 포인트를 지급하고, 회원은 **각자 기기(폰/PC)** 로 접속해 구매만 할 수 있는 웹 서비스입니다.
포인트 계산과 재고 확인은 모두 서버에서 하므로 브라우저에서 조작할 수 없어요.

## 내 컴퓨터에서 실행
```
npm install
npm start
```
브라우저에서 http://localhost:3000 접속 (관리자 기본 PIN: `1234`)

서버는 Node.js 기본 모듈만 사용하므로 `npm install` 단계는 의존성이 추가된 경우에만 필요합니다. `node_modules/` 폴더 없이 `npm start`로 바로 실행할 수 있습니다.

---

## 인터넷에 올리기 (Render + Firebase 무료 DB)

Firebase를 연동하면 서비스가 쉬는 동안에도 회원/포인트 정보를 Firestore에 저장할 수 있습니다. Firebase 프로젝트와 데이터베이스를 유지하고 사용량 한도를 확인해 주세요.

### 1단계: Firebase 설정 (1회만 진행)
1. [Firebase 콘솔](https://console.firebase.google.com/) 접속 후 구글 로그인 → **프로젝트 추가**
2. 왼쪽 메뉴 **빌드(Build) → Firestore Database** 클릭 → **데이터베이스 만들기** (위치는 `asia-northeast3 (서울)` 추천)
3. Firestore Database를 **프로덕션 모드**로 만드세요. 브라우저에서 직접 Firestore에 접근하지 않도록 보안 규칙에서 모든 클라이언트 읽기/쓰기를 거부합니다.
4. 왼쪽 위 **프로젝트 개요 옆 톱니바퀴(⚙) → 프로젝트 설정** 이동
5. **서비스 계정(Service Accounts)** 탭 선택 → **새 비공개 키 생성** 버튼 클릭 → JSON 파일 다운로드

> 서버는 서비스 계정 자격 증명으로 Firestore REST API를 호출합니다. 이 요청은 Firestore 보안 규칙에 의해 차단되지 않으므로, 아래처럼 클라이언트 접근은 거부한 채 서비스 계정 키를 서버 환경변수에만 보관하세요.
> ```
> rules_version = '2';
> service cloud.firestore {
>   match /databases/{database}/documents {
>     match /{document=**} { allow read, write: if false; }
>   }
> }
> ```

### 2단계: Render에 배포 및 환경변수 등록
1. 이 폴더를 GitHub 저장소로 올립니다. (`node_modules/`, `data/`, `serviceAccountKey.json`은 `.gitignore`에 의해 자동으로 제외됩니다)
2. [Render](https://render.com/) → **New → Web Service** → GitHub 저장소 선택
   - Build Command: `npm install`
   - Start Command: `npm start`
3. **Environment** 탭에 환경변수 추가:
   - `ADMIN_PIN` : 나만의 관리자 비밀번호 (필수)
   - `ADMIN_SECRET` : 관리자 2단계 보안 시크릿 키 (강력 추천, 충분히 긴 임의 문자열)
   - `APP_URL` : Render 사이트 주소 (슬립 방지용, 예: `https://point-shop.onrender.com`)
   - `SHOP_NAME` : 상점 이름 (선택)
   - `FIREBASE_SERVICE_ACCOUNT` : 1단계에서 다운로드받은 **JSON 파일의 내용 전체**를 그대로 복사해서 값(Value)에 붙여넣기
4. **Save Changes**를 누르면 배포가 시작되며 Firestore에 데이터를 저장합니다. Firebase의 사용량 한도와 요금 정책을 확인하세요.

> **참고**: `FIREBASE_SERVICE_ACCOUNT`를 설정하지 않으면 자동으로 로컬 `data/data.json` 파일 모드로 동작합니다. 로컬 컴퓨터에서 테스트할 때는 다운받은 JSON 파일 이름을 `serviceAccountKey.json`으로 바꾸어 프로젝트 루트 폴더에 넣으면 로컬에서도 Firebase와 연동됩니다.

---

## 사용법
- **회원**: 이름 + 확인 코드로 입장 → 상품 담기 → 구매
- **관리자**: 첫 화면 오른쪽 위 "관리자" → 비밀번호 → 회원 추가(확인 코드 자동 생성), 포인트 지급/차감/설정, 내역 확인
- 회원에게는 **이름과 확인 코드**를 알려주세요. (코드는 관리자 화면에서 볼 수 있어요)

## 상품 추가
`products.js`에 한 줄 추가하고 서버를 다시 시작하면 됩니다.
```js
{ id:'new1', name:'새 상품', price:100, desc:'설명', stock:10 },
```
이미지는 `public/img/` 폴더에 넣고 `img:'/img/파일명.jpg'` 로 적으세요.
