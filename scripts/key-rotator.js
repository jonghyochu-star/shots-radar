// scripts/key-rotator.js
// Shorts Radar - YouTube API Key rotator (403/429 자동 회전 + 상태 기록)
// Secrets 이름: YT_KEY_1..5 또는 YT_API_KEY_1..5 둘 다 지원

const https = require('https');
const { URL } = require('url');
const fs = require('fs/promises');

const BLOCK_MINUTES_QUOTA = 60;   // 쿼터/레이트 한도 시 블록 시간
const BLOCK_MINUTES_MISC  = 5;    // 기타 오류(네트워크 등) 블록 시간
const REQ_TIMEOUT_MS      = 15000;

let state = {
  keys: [],           // {name, key, ok, fail, blockedUntil, lastErr}
  lastPick: -1,       // 마지막 사용 인덱스
  startedAt: new Date().toISOString(),
};

function now() { return Date.now(); }
function mins(n) { return n * 60 * 1000; }

function loadEnvKeys() {
  const list = [];
  for (let i = 1; i <= 5; i++) {
    const k1 = process.env[`YT_KEY_${i}`];
    const k2 = process.env[`YT_API_KEY_${i}`];
    const key = k1 || k2;
    if (key && String(key).trim()) {
      list.push({
        name: `key#${i}`,
        key: String(key).trim(),
        ok: 0,
        fail: 0,
        blockedUntil: 0,
        lastErr: null,
      });
    }
  }
  return list;
}

state.keys = loadEnvKeys();
if (state.keys.length === 0) {
  console.warn('[SR] No API keys in env (YT_KEY_1..5 or YT_API_KEY_1..5).');
}

function appendKey(url, key) {
  const u = new URL(url);
  // 사용자가 key를 붙이지 않도록 강제
  u.searchParams.delete('key');
  u.searchParams.set('key', key);
  return u.toString();
}

function classifyYouTubeError(e) {
  // e: {status, body, json?, code?, reason?}
  const txt = JSON.stringify(e && e.json ? e.json : e) || '';
  const reasons = [
    'quotaExceeded',
    'rateLimitExceeded',
    'dailyLimitExceeded',
    'userRateLimitExceeded',
    'forbidden',
  ];
  const isQuota = reasons.some(r => txt.includes(r));
  return isQuota ? 'quota' : 'misc';
}

function pickNextKey() {
  const n = state.keys.length;
  if (!n) return -1;
  const start = (state.lastPick + 1) % n;
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    const k = state.keys[idx];
    if (!k.blockedUntil || k.blockedUntil <= now()) {
      state.lastPick = idx;
      return idx;
    }
  }
  return -1; // 모두 블록 상태
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function rawGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: REQ_TIMEOUT_MS }, res => {
      let chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(body); } catch {}

        if (res.statusCode >= 200 && res.statusCode < 300) {
          // YouTube도 간혹 200에 error payload를 줄 수 있음
          if (json && json.error) {
            return reject({ status: res.statusCode, json, body });
          }
          return resolve(json ?? body);
        }
        return reject({ status: res.statusCode, json, body });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => reject({ code: 'network', err }));
  });
}

async function httpGet(url) {
  const n = state.keys.length;
  if (!n) throw new Error('[SR] No API keys loaded');

  let attempts = 0;
  const maxAttempts = n * 2; // 여유있게 두 바퀴
  while (attempts < maxAttempts) {
    attempts += 1;

    let idx = pickNextKey();
    if (idx === -1) {
      // 모두 블록이면 가장 빨리 풀리는 키까지 짧게 대기
      const soonest = Math.min(...state.keys.map(k => k.blockedUntil || (now()+mins(1))));
      const waitMs = Math.max(0, soonest - now());
      const wait = Math.min(waitMs, mins(1)); // 1분 이상 대기하지 않음
      if (wait > 0) await sleep(wait);
      idx = pickNextKey();
      if (idx === -1) break; // 여전히 막혔으면 종료
    }

    const k = state.keys[idx];
    const withKey = appendKey(url, k.key);

    try {
      const data = await rawGet(withKey);
      k.ok += 1;
      return data;
    } catch (e) {
      k.fail += 1;
      k.lastErr = e;
      const cls = classifyYouTubeError(e);
      const blockFor = cls === 'quota' ? mins(BLOCK_MINUTES_QUOTA) : mins(BLOCK_MINUTES_MISC);
      k.blockedUntil = now() + blockFor;
      continue; // 다음 키로
    }
  }

  const err = new Error('[SR] All keys exhausted or blocked');
  err.state = state;
  throw err;
}

async function writeKeyStatus(outPath) {
  try {
    const snapshot = {
      ts: new Date().toISOString(),
      keys: state.keys.map(k => ({
        name: k.name,
        ok: k.ok,
        fail: k.fail,
        blockedUntil: k.blockedUntil ? new Date(k.blockedUntil).toISOString() : null,
        lastErr: k.lastErr && k.lastErr.json && k.lastErr.json.error
          ? k.lastErr.json.error
          : (k.lastErr && k.lastErr.status) || null
      })),
    };
    await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (e) {
    console.warn('[SR] writeKeyStatus failed:', e);
  }
}

module.exports = { httpGet, writeKeyStatus };
