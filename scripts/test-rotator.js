// scripts/test-rotator.js
// ESM 모듈: package.json 에 "type":"module" 가정
import { httpGet } from './key-rotator.js';

async function test403() {
  console.log('\n[TEST-403] 강제 403: 모든 키를 순회하며 회전하는지 확인');
  try {
    // 항상 403을 돌려주는 테스트 엔드포인트
    await httpGet('https://httpbin.org/status/403');
    console.log('❌ 예상과 달리 성공했습니다(여기 오면 안됨)');
  } catch (e) {
    console.log('✅ 예상대로 실패(403) - 회전 시도 로그를 위에서 확인하세요.');
    console.log('message:', e.message);
  }
}

async function test429() {
  console.log('\n[TEST-429] 강제 429: 백오프 + 회전이 수행되는지 확인');
  try {
    // 항상 429를 돌려주는 테스트 엔드포인트
    await httpGet('https://httpbin.org/status/429');
    console.log('❌ 예상과 달리 성공했습니다(여기 오면 안됨)');
  } catch (e) {
    console.log('✅ 예상대로 실패(429) - 백오프/회전 로그를 위에서 확인하세요.');
    console.log('message:', e.message);
  }
}

async function test200() {
  console.log('\n[TEST-200] 정상 200: 성공 흐름 확인 (JSON 응답)');
  const data = await httpGet('https://httpbin.org/json');
  console.log('✅ 성공 응답 일부:', { slideshowTitle: data?.slideshow?.title });
}

(async () => {
  await test403();
  await test429();
  await test200();
})().catch((e) => {
  console.error('[TEST] 예기치 못한 오류', e);
  process.exit(1);
});
