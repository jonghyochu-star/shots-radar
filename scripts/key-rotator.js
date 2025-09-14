// scripts/key-rotator.js
// Node >= 20  (ESM)
// 기능:
// - 403/429 시 즉시 다음 키로 회전
// - ROTATE_EAGER=1 이면 성공 후에도 다음 키로 순환(쿼터 분산)
// - ROTATOR_DEBUG=1 디버그 로그 (로드키/시도순서/스킵 사유)
// - ROTATOR_COOLDOWN_MIN=n 분 동안 403/429 반복 키 임시 제외(기본 60분)
// - writeKeyStatus: 상태를 콘솔 또는 파일(KEY_STATUS_PATH)로 남김

import fs from 'node:fs/promises';
import path from 'node:path';

const rawKeys = [
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

// 중복제거 없음(의도치 않은 1개화 방지)
export const KEYS = rawKeys;

if (KEYS.length === 0) {
  throw new Error('[rotator] No API keys configured. Set YT_KEY_1..5 (or YT_API_KEY1..5).');
}

const EAGER_ROTATE   = process.env.ROTATE_EAGER === '1';
const ROTATOR_DEBUG  = process.env.ROTATOR_DEBUG === '1';
const COOLDOWN_MIN   = Number.parseInt(process.env.ROTATOR_COOLDOWN_MIN || '60', 10); // 기본 60분
const COOLDOWN_MS    = Math.max(1, COOLDOWN_MIN) * 60_000;

// 프로세스 전역 시작 인덱스
let idx = 0;

// 키별 실패 카운트/쿨다운 만료시각
const failCount  = Array.from({ length: KEYS.length }, () => 0);
const deadUntil  = Array.from({ length: KEYS.length }, () => 0);

// ===== helpers =====
function tail4(k) { try { return k.slice(-4); } catch { return '----'; } }
async function safeText(res) { try { return await res.text(); } catch { return ''; } }
function trim(s, n) { if (!s) return ''; return s.length > n ? `${s.slice(0, n)}...` : s; }
function alive(i) { return Date.now() >= deadUntil[i]; }

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

if (ROTATOR_DEBUG) {
  console.log(`[rotator] loaded ${KEYS.length} key(s): tails=${KEYS.map(k => tail4(k)).join(',')}`);
  console.log(`[rotator] cooldown: ${COOLDOWN_MIN}min (ROTATOR_COOLDOWN_MIN)`);
}

// 요청 1회 안에서 현재 idx부터 모든 키를 순차 시도(쿨다운 키는 건너뜀)
export async function httpGet(endpoint, params = {}) {
  // 기본 시도 순서
  const order = Array.from({ length: KEYS.length }, (_, j) => (idx + j) % KEYS.length);
  // 쿨다운 제외
  let usable = order.filter(i => alive(i));
  if (usable.length === 0) usable = order; // 전부 쿨다운이면 강제로라도 시도

  if (ROTATOR_DEBUG) {
    console.log(`[rotator] attempt order this call: ${usable.map(i => i + 1).join('→')}` +
      (usable.length !== order.length ? ` (skipping: ${order.filter(i=>!usable.includes(i)).map(i=>i+1).join(',')})` : ''));
  }

  for (const kIndex of usable) {
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
      failCount[kIndex] = (failCount[kIndex] || 0) + 1;

      // 동일 키 반복 403/429면 일정 시간 쿨다운
      if (failCount[kIndex] >= 2 && alive(kIndex)) {
        deadUntil[kIndex] = Date.now() + COOLDOWN_MS;
        await writeKeyStatus({
          event: 'cooldown',
          code: res.status,
          keyIndex: kIndex + 1,
          keyTail: tail4(key),
          until: new Date(deadUntil[kIndex]).toISOString(),
          fails: failCount[kIndex]
        });
        if (ROTATOR_DEBUG) {
          console.log(`[rotator] key#${kIndex + 1} ..${tail4(key)} cooldown for ${COOLDOWN_MIN}min`);
        }
      } else {
        await writeKeyStatus({ event: 'rotate', code: res.status, keyIndex: kIndex + 1, keyTail: tail4(key) });
      }
      continue; // 다음 키로
    }

    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`[rotator] HTTP ${res.status} ${trim(txt, 200)}`);
    }

    const json = await res.json();

    // 성공 시: 실패 카운트/쿨다운 리셋, 다음 호출 시작점 이동
    failCount[kIndex] = 0;
    deadUntil[kIndex] = 0;
    idx = (kIndex + (EAGER_ROTATE ? 1 : 0)) % KEYS.length;

    await writeKeyStatus({ event: 'success', code: 200, keyIndex: kIndex + 1, keyTail: tail4(key) });
    return json;
  }

  throw new Error(`[rotator] All ${KEYS.length} keys exhausted by 403/429 or cooldown`);
}
