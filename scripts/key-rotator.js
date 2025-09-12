// scripts/key-rotator.js  (ESM)
// - GitHub Secrets: YT_KEY_1..5 (또는 YT_API_KEY_1..5) 자동 탐색
// - 403(쿼터 초과/ dailyLimitExceeded / quotaExceeded 등) 발생 시 다음 키로 회전 후 재시도
// - 키 5개 모두 소진 시 에러 반환

const envKeys = [
  process.env.YT_KEY_1 || process.env.YT_API_KEY_1,
  process.env.YT_KEY_2 || process.env.YT_API_KEY_2,
  process.env.YT_KEY_3 || process.env.YT_API_KEY_3,
  process.env.YT_KEY_4 || process.env.YT_API_KEY_4,
  process.env.YT_KEY_5 || process.env.YT_API_KEY_5,
].filter(Boolean);

if (!envKeys.length) {
  throw new Error('No YouTube API keys found in secrets (YT_KEY_1..5 or YT_API_KEY_1..5)');
}

const keyStats = {
  pool: envKeys,
  idx: 0,
  blocked: new Set(),   // 403 등으로 세션 중 차단된 키
  ok: Array(envKeys.length).fill(0),
  fail: Array(envKeys.length).fill(0),
};

function currentKey() {
  return keyStats.pool[keyStats.idx];
}
function rotate() {
  keyStats.idx = (keyStats.idx + 1) % keyStats.pool.length;
}
function markBlocked(i) {
  keyStats.blocked.add(i);
}

function isQuotaError(text, status) {
  const t = (text || '').toLowerCase();
  return status === 403 && (
    t.includes('quota') ||
    t.includes('dailylimitexceeded') ||
    t.includes('quotaexceeded') ||
    t.includes('exceeded')
  );
}

export function writeKeyStatus(prefix='[keys]') {
  const badges = keyStats.pool.map((_, i) => {
    const mark = keyStats.blocked.has(i) ? 'BLOCK' : 'ok';
    return `k${i+1}:${mark} (ok:${keyStats.ok[i]}/fail:${keyStats.fail[i]})`;
  }).join(' | ');
  console.log(`${prefix} ${badges}`);
}

/**
 * YouTube GET 호출 (엔드포인트와 URLSearchParams만 넘기면 됨)
 * - &key는 여기서 붙여줌
 * - 403/쿼터 초과 시 다음 키로 회전하고 최대 키 수 만큼 재시도
 */
export async function ytGet(endpoint, params) {
  if (!(params instanceof URLSearchParams)) {
    params = new URLSearchParams(params || {});
  }

  let tried = 0;
  while (tried < keyStats.pool.length) {
    const i = keyStats.idx;
    const key = currentKey();

    if (keyStats.blocked.has(i)) { // 이미 막힌 키는 건너뛰기
      rotate(); tried++; continue;
    }

    const url = `https://www.googleapis.com/youtube/v3/${endpoint}?${params.toString()}&key=${key}`;

    const res = await fetch(url, { headers: { accept: 'application/json' } }).catch(e => ({ ok:false, status:0, statusText:String(e) }));
    if (!res.ok) {
      const text = await res.text().catch(()=>'');
      keyStats.fail[i]++;

      if (isQuotaError(text, res.status)) {
        // 이 키는 이번 런 동안 차단
        markBlocked(i);
        console.warn(`[ytGet] quota exceeded on k${i+1}, rotating…`);
        rotate(); tried++; continue;   // 다음 키로
      }

      throw new Error(`HTTP ${res.status} ${res.statusText} – ${text.slice(0,200)}`);
    }

    keyStats.ok[i]++;
    if ((keyStats.ok[i] + keyStats.fail[i]) % 20 === 0) writeKeyStatus('[keys]');
    return res.json();
  }

  writeKeyStatus('[keys:exhausted]');
  throw new Error('All API keys are exhausted (quota exceeded).');
}
