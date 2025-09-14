// scripts/key-rotator.js
// ESM. Node >= 20

import fs from 'node:fs/promises';
import path from 'node:path';

const rawKeys = [
  // 권장 네이밍
  process.env.YT_KEY_1,
  process.env.YT_KEY_2,
  process.env.YT_KEY_3,
  process.env.YT_KEY_4,
  process.env.YT_KEY_5,
  // 호환(과거 네이밍)
  process.env.YT_API_KEY1,
  process.env.YT_API_KEY2,
  process.env.YT_API_KEY3,
  process.env.YT_API_KEY4,
  process.env.YT_API_KEY5,
].filter(k => typeof k === 'string' && k.trim().length > 0);

export const KEYS = [...new Set(rawKeys)];
if (KEYS.length === 0) {
  throw new Error('[rotator] No API keys configured. Set YT_KEY_1..5 (or YT_API_KEY1..5).');
}

// 모든 키를 최소 1번씩 시도
const MAX_ATTEMPTS = KEYS.length;

// 성공 시에도 다음 키로 순환(쿼터 분산)
const EAGER_ROTATE = process.env.ROTATE_EAGER === '1';

// 모듈 스코프 인덱스
let idx = 0;

// 안전 로그 유틸
function tail4(k) { try { return k.slice(-4); } catch { return '----'; } }
async function safeText(res) { try { return await res.text(); } catch { return ''; } }
function trim(s, n) { if (!s) return ''; return s.length > n ? `${s.slice(0, n)}...` : s; }

/**
 * writeKeyStatus: fetch-trend.js에서 import 하는 상태 기록 함수
 * - 기본은 콘솔 로그만 남깁니다.
 * - 환경변수 KEY_STATUS_PATH가 지정되면 해당 경로(JSON)로도 기록합니다.
 *   (예: KEY_STATUS_PATH='public/key-status.json')
 */
export async function writeKeyStatus(data = {}) {
  const payload = { updatedAt: new Date().toISOString(), ...data };
  const p = process.env.KEY_STATUS_PATH; // 선택사항
  try {
    if (p) {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, JSON.stringify(payload, null, 2), 'utf8');
    } else {
      console.log(`[rotator:status] ${JSON.stringify(payload)}`);
    }
  } catch (e) {
    console.log(`[rotator:status] write failed: ${e.message}`);
  }
}

export async function httpGet(endpoint, params = {}) {
  // 요청 1회 안에서 반드시 1→2→3→4→5 순으로 시도
  for (let spins = 0; spins < KEYS.length; spins++) {
    const kIndex = (idx + spins) % KEYS.length; // 이번 요청의 시도 인덱스
    const key = KEYS[kIndex];
    const url = new URL(endpoint);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    url.searchParams.set('key', key);

    const res = await fetch(url, { method: 'GET' });

    if (res.status === 403 || res.status === 429) {
      const txt = await safeText(res);
      console.log(`[rotator] rotate on ${res.status} (key#${kIndex + 1} ..${tail4(key)}) reason=${trim(txt, 120)}`);
      await writeKeyStatus({ event: 'rotate', code: res.status, keyIndex: kIndex + 1, keyTail: tail4(key) });
      // 계속 다음 키로 시도 (spins 증가)
      continue;
    }

    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`[rotator] HTTP ${res.status} ${trim(txt, 200)}`);
    }

    const json = await res.json();

    // 성공했으면 글로벌 포인터를 이번에 쓴 키로 이동
    idx = (kIndex + (EAGER_ROTATE ? 1 : 0)) % KEYS.length;
    await writeKeyStatus({ event: 'success', code: 200, keyIndex: kIndex + 1, keyTail: tail4(key) });

    return json;
  }
  throw new Error(`[rotator] All ${KEYS.length} keys exhausted by 403/429`);
}

