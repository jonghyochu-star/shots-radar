// scripts/key-rotator.js
// ESM. Node >= 20 (global fetch OK)

const rawKeys = [
  // 표준 권장: YT_KEY_1..5
  process.env.YT_KEY_1,
  process.env.YT_KEY_2,
  process.env.YT_KEY_3,
  process.env.YT_KEY_4,
  process.env.YT_KEY_5,

  // 호환: YT_API_KEY1..5 (과거 명명)
  process.env.YT_API_KEY1,
  process.env.YT_API_KEY2,
  process.env.YT_API_KEY3,
  process.env.YT_API_KEY4,
  process.env.YT_API_KEY5,
].filter(k => typeof k === 'string' && k.trim().length > 0);

// 중복 제거
const KEYS = [...new Set(rawKeys)];
if (KEYS.length === 0) {
  throw new Error('[rotator] No API keys configured. Set YT_KEY_1..5 (or YT_API_KEY1..5).');
}

// 모든 키를 최소 1회씩 시도
const MAX_ATTEMPTS = KEYS.length;

// 성공 시에도 다음 키로 순환할지 여부 (쿼터 분산용)
const EAGER_ROTATE = process.env.ROTATE_EAGER === '1';

// 모듈 스코프 인덱스(프로세스 동안 유지)
let idx = 0;

// 안전 로그용 유틸
function tail4(k) {
  try { return k.slice(-4); } catch { return '----'; }
}

export async function httpGet(endpoint, params = {}) {
  for (let spins = 0; spins < MAX_ATTEMPTS; spins++) {
    const key = KEYS[idx];
    const url = new URL(endpoint);
    // query params
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    url.searchParams.set('key', key);

    const res = await fetch(url, { method: 'GET' });

    if (res.status === 403 || res.status === 429) {
      const txt = await safeText(res);
      console.log(`[rotator] rotate on ${res.status} (key#${idx + 1} ..${tail4(key)}) reason=${trim(txt, 120)}`);
      idx = (idx + 1) % KEYS.length;  // 다음 키로
      continue;                       // 재시도
    }

    if (!res.ok) {
      // 기타 오류는 즉시 실패 (회전 X)
      const txt = await safeText(res);
      throw new Error(`[rotator] HTTP ${res.status} ${trim(txt, 200)}`);
    }

    const json = await res.json();

    // 성공했는데도 키를 순환할지 여부 (쿼터 분산)
    if (EAGER_ROTATE) {
      idx = (idx + 1) % KEYS.length;
    }

    return json;
  }

  throw new Error(`[rotator] All ${KEYS.length} keys exhausted by 403/429`);
}

// helpers
async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}
function trim(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}...` : s;
}
