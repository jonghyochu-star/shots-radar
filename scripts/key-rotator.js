// scripts/key-rotator.js
// Node >= 20 (ESM, global fetch)
// 기능:
// - 403/429에서 다음 키로 회전
// - ROTATE_EAGER=1 → 성공 시에도 다음 키로 순환(쿼터 분산)
// - ROTATOR_DEBUG=1 → 로드 키/시도 순서/스킵/쿨다운 로그
// - ROTATOR_COOLDOWN_MIN=n → 반복 403/429 키 n분 쿨다운(기본 60)
// - ROTATOR_COOLDOWN_UNTIL_RESET=1 → 다음 KST 16:00까지 쿨다운
// - writeKeyStatus: 상태를 콘솔/파일(KEY_STATUS_PATH)로 기록

import fs from 'node:fs/promises';
import path from 'node:path';

// === env keys (두 네이밍 모두 지원) ===
const rawKeys = [
  process.env.YT_KEY_1,
  process.env.YT_KEY_2,
  process.env.YT_KEY_3,
  process.env.YT_KEY_4,
  process.env.YT_KEY_5,

  // 호환(과거)
  process.env.YT_API_KEY1,
  process.env.YT_API_KEY2,
  process.env.YT_API_KEY3,
  process.env.YT_API_KEY4,
  process.env.YT_API_KEY5,
].filter(k => typeof k === 'string' && k.trim().length > 0);

// ★중복제거 안 함(의도치 않게 1개로 줄어드는 상황 방지)
export const KEYS = rawKeys;

if (KEYS.length === 0) {
  throw new Error('[rotator] No API keys configured. Set YT_KEY_1..5 (or YT_API_KEY1..5).');
}

const EAGER_ROTATE  = process.env.ROTATE_EAGER === '1';
const ROTATOR_DEBUG = process.env.ROTATOR_DEBUG === '1';
const COOLDOWN_MIN  = Number.parseInt(process.env.ROTATOR_COOLDOWN_MIN || '60', 10);
const COOLDOWN_MS   = Math.max(1, COOLDOWN_MIN) * 60_000;
const COOLDOWN_UNTIL_RESET = process.env.ROTATOR_COOLDOWN_UNTIL_RESET === '1';

// 프로세스 전역 시작 인덱스
let idx = 0;

// 키별 실패 카운트/쿨다운 만료시각
const failCount = Array.from({ length: KEYS.length }, () => 0);
const deadUntil = Array.from({ length: KEYS.length }, () => 0);

// ===== helpers =====
function tail4(k) { try { return k.slice(-4); } catch { return '----'; } }
async function safeText(res) { try { return await res.text(); } catch { return ''; } }
function trim(s, n) { if (!s) return ''; return s.length > n ? `${s.slice(0, n)}...` : s; }
function alive(i) { return Date.now() >= deadUntil[i]; }
function msUntilNextKst16() {
  // KST 16:00 == UTC 07:00
  const now = new Date();
  const todayResetUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 0, 0, 0);
  const nextUTC = (now.getTime() < todayResetUTC)
    ? todayResetUTC
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 7, 0, 0, 0);
  return Math.max(1, nextUTC - now.getTime());
}

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

if (ROTATOR_DEBUG) {
  console.log(`[rotator] loaded ${KEYS.length} key(s): tails=${KEYS.map(k => tail4(k)).join(',')}`);
  console.log(`[rotator] cooldown: ${COOLDOWN_MIN}min (COOLDOWN_UNTIL_RESET=${COOLDOWN_UNTIL_RESET ? 'on' : 'off'})`);
}

// 요청 1회 안에서 현재 idx부터 모든 키를 순차 시도(쿨다운 키는 스킵)
export async function httpGet(endpoint, params = {}) {
  const order = Array.from({ length: KEYS.length }, (_, j) => (idx + j) % KEYS.length);
  let usable = order.filter(i => alive(i));
  if (usable.length === 0) usable = order; // 전부 쿨다운이면 강제로라도 시도

  if (ROTATOR_DEBUG) {
    const skipped = order.filter(i => !usable.includes(i));
    console.log(`[rotator] attempt order this call: ${usable.map(i => i + 1).join('→')}` +
      (skipped.length ? ` (skipping: ${skipped.map(i => i + 1).join(',')})` : ''));
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

      // 동일 키 반복 403/429면 쿨다운
      if (failCount[kIndex] >= 2 && alive(kIndex)) {
        const cdMs = COOLDOWN_UNTIL_RESET ? msUntilNextKst16() : COOLDOWN_MS;
        deadUntil[kIndex] = Date.now() + cdMs;
        await writeKeyStatus({
          event: 'cooldown',
          code: res.status,
          keyIndex: kIndex + 1,
          keyTail: tail4(key),
          until: new Date(deadUntil[kIndex]).toISOString(),
          fails: failCount[kIndex]
        });
        if (ROTATOR_DEBUG) {
          const mins = Math.round(cdMs / 60000);
          console.log(`[rotator] key#${kIndex + 1} ..${tail4(key)} cooldown ~${mins}min`);
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
