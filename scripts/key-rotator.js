// scripts/key-rotator.js
// Node >= 20 (global fetch)
// - 403/429에서 다음 키로 회전
// - ROTATE_EAGER=1 이면 성공 시에도 다음 키로 순환(쿼터 분산)
// - ROTATOR_DEBUG=1 이면 로드 키/시도 순서 로그 출력
// - fetch-trend.js가 import하는 writeKeyStatus 포함

import fs from 'node:fs/promises';
import path from 'node:path';

// 환경변수에서 키 읽기 (두 네이밍 모두 지원)
const rawKeys = [
  process.env.YT_KEY_1,
  process.env.YT_KEY_2,
  process.env.YT_KEY_3,
  process.env.YT_KEY_4,
  process.env.YT_KEY_5,

  process.env.YT_API_KEY1,
  process.env.YT_API_KEY2,
  process.env.YT_API_KEY3,
  process.env.YT_API_KEY4,
  process.env.YT_API_KEY5,
].filter(k => typeof k === 'string' && k.trim().length > 0);

// ★중복제거 없음(의도치 않은 1개화 방지)
export const KEYS = rawKeys;

if (KEYS.length === 0) {
  throw new Error('[rotator] No API keys configured. Set YT_KEY_1..5 (or YT_API_KEY1..5).');
}

const EAGER_ROTATE   = process.env.ROTATE_EAGER === '1';
const ROTATOR_DEBUG  = process.env.ROTATOR_DEBUG === '1';

// 프로세스 전역 시작 인덱스
let idx = 0;

// ========== helpers ==========
function tail4(k) { try { return k.slice(-4); } catch { return '----'; } }
async function safeText(res) { try { return await res.text(); } catch { return ''; } }
function trim(s, n) { if (!s) return ''; return s.length > n ? `${s.slice(0, n)}...` : s; }

// 상태 기록(선택) — KEY_STATUS_PATH 지정 시 파일로도 기록
export async function writeKeyStatus(data = {}) {
  const payload = { updatedAt: new Date().toISOString(), ...data };
  const p = process.env.KEY_STATUS_PATH; // 예: public/key-status.json
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

// ========== main ==========
if (ROTATOR_DEBUG) {
  console.log(`[rotator] loaded ${KEYS.length} key(s): tails=${KEYS.map(k => tail4(k)).join(',')}`);
}

// 요청 1회 안에서 반드시 현재 idx부터 모든 키를 순차 시도
export async function httpGet(endpoint, params = {}) {
  const order = Array.from({ length: KEYS.length }, (_, j) => (idx + j) % KEYS.length);
  if (ROTATOR_DEBUG) {
    console.log(`[rotator] attempt order this call: ${order.map(i => i + 1).join('→')}`);
  }

  for (const kIndex of order) {
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
      // 다음 키로 계속 시도
      continue;
    }

    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`[rotator] HTTP ${res.status} ${trim(txt, 200)}`);
    }

    const json = await res.json();

    // 성공했으면 다음 호출의 시작점을 조정
    idx = (kIndex + (EAGER_ROTATE ? 1 : 0)) % KEYS.length;
    await writeKeyStatus({ event: 'success', code: 200, keyIndex: kIndex + 1, keyTail: tail4(key) });

    return json;
  }

  throw new Error(`[rotator] All ${KEYS.length} keys exhausted by 403/429`);
}
