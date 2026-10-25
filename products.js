/* ============================================================
   ★ 상품 목록 — 여기에 한 줄씩 추가하면 상품이 늘어납니다 ★
   (저장 후 서버를 다시 시작하면 반영돼요)

   { id:'고유값', name:'상품명', price:가격, desc:'설명', stock:재고, img:'이미지주소' },

   - id    : 다른 상품과 겹치지 않게 (영문/숫자)
   - stock : 생략하면 재고 무제한
   - img   : 생략하면 상품명 첫 글자가 표시됩니다
             (public/img 폴더에 넣은 파일은 '/img/파일명.jpg' 로 적으세요)
   ============================================================ */
module.exports = [
  { id:'americano', name:'아메리카노',  price:300,  desc:'따뜻한 커피 한 잔',   stock:20 },
  { id:'cookie',    name:'쿠키',        price:200,  desc:'바삭한 초코칩 쿠키',   stock:30 },
  { id:'chicken',   name:'치킨 쿠폰',   price:1500, desc:'치킨 1마리 교환권',    stock:5  },
  { id:'movie',     name:'영화 티켓',   price:1200, desc:'영화 1인 관람권',      stock:10 },
  { id:'game',      name:'게임 시간권', price:500,  desc:'게임 1시간 이용권' },
  { id:'pen',       name:'펜 세트',     price:150,  desc:'볼펜 3종 세트',        stock:50 },
  // { id:'new1', name:'새 상품', price:100, desc:'설명', stock:10 },
];
