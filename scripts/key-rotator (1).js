/**
 * scripts/key-rotator.js
 * Robust YouTube API key rotation helper for Node 18+/20+ (global fetch available).
 * - Reads YT_KEY_1..YT_KEY_5 from env (skip empties)
 * - Rewrites `key=` query param on the provided URL
 * - On 403 or any quota‑style error, immediately tries the next key (no waiting)
 * - Keeps the rotation index across calls within the same process
 * - Exports: httpGet(url, init?), writeKeyStatus(status) [no-op placeholder]
 */

const KEYS = [
  process.env.YT_KEY_1,
  process.env.YT_KEY_2,
  process.env.YT_KEY_3,
  process.env.YT_KEY_4,
  process.env.YT_KEY_5,
].filter(Boolean);

if (!Array.isArray(KEYS) || KEYS.length === 0) {
  console.warn('[key-rotator] No YT_KEY_* provided in env.');
}

let idx = 0; // current key index for this process

function replaceKeyInUrl(rawUrl, apiKey) {
  const u = new URL(rawUrl);
  // Ensure we always carry the key we want
  u.searchParams.set('key', apiKey);
  return u.toString();
}

function isQuotaOr403(res, payloadText) {
  // 403 outright
  if (res && res.status === 403) return true;
  // Inspect JSON payload for quota/daily/rate messages
  try {
    const j = JSON.parse(payloadText || '{}');
    const msg = (j && j.error && (j.error.message || '')) || '';
    const reasonList = (j && j.error && Array.isArray(j.error.errors) ? j.error.errors : []);
    const hasReason = reasonList.some(e =>
      /quota|dailyLimitExceeded|rateLimitExceeded|quotaExceeded/i.test(
        (e && (e.reason || e.message || '')) + ''
      )
    );
    if (hasReason) return true;
    if (/quota|exceed(ed)?|daily\s*limit/i.test(msg)) return true;
  } catch (_) {}
  return false;
}

async function httpGet(rawUrl, init = {}) {
  if (!KEYS.length) {
    throw new Error('[key-rotator] No API keys available');
  }

  let attempts = 0;
  let lastErr;

  // We allow at most KEYS.length attempts per request.
  while (attempts < KEYS.length) {
    const k = KEYS[idx];
    const withKey = replaceKeyInUrl(rawUrl, k);

    try {
      const res = await fetch(withKey, { method: 'GET', ...init });
      const text = await res.text();

      if (!res.ok) {
        if (isQuotaOr403(res, text)) {
          // rotate and retry immediately
          const old = idx;
          idx = (idx + 1) % KEYS.length;
          console.warn(`[key-rotator] 403/quota with key #${old + 1}. Switched to #${idx + 1} and retrying…`);
          attempts++;
          continue;
        }
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }

      // Success
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (e) {
      // Network or parsing error → try the next key once, then continue
      lastErr = e;
      const old = idx;
      idx = (idx + 1) % KEYS.length;
      console.warn(`[key-rotator] network/unknown error with key #${old + 1}. Switched to #${idx + 1} and retrying…`);
      attempts++;
      continue;
    }
  }

  // Exhausted all keys
  throw lastErr || new Error('[key-rotator] All keys exhausted for this request.');
}

// Optional hook – keeps compatibility with existing code that may call it
function writeKeyStatus(/* status */) {
  // no-op; add file/kv logging here if you want to persist status
}

module.exports = { httpGet, writeKeyStatus };
