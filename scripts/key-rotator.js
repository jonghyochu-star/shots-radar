// scripts/key-rotator.js
// ESM module

const KEYS = [
  process.env.YT_KEY_1,
  process.env.YT_KEY_2,
  process.env.YT_KEY_3,
  process.env.YT_KEY_4,
  process.env.YT_KEY_5,
].filter(Boolean);

// 최소 3회까지 즉시 회전 재시도 (키 개수보다 많이는 안 함)
const MAX_ATTEMPTS = Math.min(3, KEYS.length || 0);

// 현재 커서
let cursor = 0;

function nextKeyIndex() {
  cursor = (cursor + 1) % KEYS.length;
  return cursor;
}

function withKey(url, key) {
  const u = new URL(url);
  // 기존 key 파라미터가 있어도 덮어씀
  u.searchParams.set('key', key);
  return u.toString();
}

async function readBodySafe(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * GitHub Actions 콘솔에서 상태만 찍어주는 함수
 * (원한다면 파일로 쓰도록 바꿔도 OK)
 */
export async function writeKeyStatus(message) {
  console.log(`[rotator] ${message}`);
}

/**
 * 403/429이면 다음 키로 즉시 회전해서 재시도.
 * 성공 시 JSON 반환. 그 외 상태코드는 즉시 throw.
 */
export async function httpGet(url) {
  if (!KEYS.length) {
    throw new Error('No YT_KEY_* secrets configured');
  }

  let lastErr;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const key = KEYS[cursor];
    const finalUrl = withKey(url, key);

    await writeKeyStatus(`try #${attempt + 1} with key[${cursor + 1}]`);

    const res = await fetch(finalUrl, {
      headers: { accept: 'application/json' },
    });

    if (res.ok) {
      await writeKeyStatus(`OK key[${cursor + 1}]`);
      // JSON API이므로 JSON으로 반환
      return res.json();
    }

    const body = await readBodySafe(res);
    const snippet = body.slice(0, 200);

    // 쿼터/레이트 리밋 → 다음 키로 즉시 회전 및 재시도
    if (res.status === 403 || res.status === 429) {
      await writeKeyStatus(`rotate on ${res.status} (key[${cursor + 1}])`);
      lastErr = new Error(`HTTP ${res.status} ${res.statusText} - ${snippet}`);
      nextKeyIndex();
      continue;
    }

    // 그 외 에러는 즉시 실패
    throw new Error(`HTTP ${res.status} ${res.statusText} - ${snippet}`);
  }

  // 모든 시도 실패
  throw lastErr ?? new Error('All keys exhausted');
}
