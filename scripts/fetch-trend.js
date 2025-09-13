// scripts/fetch-trend.js
// ESM module. Node >=20
// - 카테고리별 검색(2 pages x 9cats)
// - videos.list 상세 조회
// - RULES(토큰) + 채널 Prior 보정으로 스코어링
// - 멀티라벨 가중 합산(Δ조회수 × weight)
// - kw-trend.json 병합 저장 + ch-prior.json 갱신
// - SR_DEBUG=1 시 public/kw-debug.json 으로 검증 샘플 출력
// - 키 회전: scripts/key-rotator.js 의 httpGet 사용

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { httpGet, writeKeyStatus } from './key-rotator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ------------------ 설정 ------------------
const RESULT_PAGES_PER_RUN = Number(process.env.RESULT_PAGES_PER_RUN || 2);
const RESULTS_PER_PAGE     = 50;
const MAX_DAYS_KEEP        = Number(process.env.MAX_DAYS_KEEP || 180);
const LOOKBACK_DAYS_SEARCH = Number(process.env.LOOKBACK_DAYS_SEARCH || 14);

// 채널 prior 설정
const PRIOR_ALPHA        = Number(process.env.PRIOR_ALPHA || 20);     // 디리클레 스무딩 강도
const PRIOR_MIN_BOOST    = Number(process.env.PRIOR_MIN_BOOST || 0.6);// prior 보정 하한
const PRIOR_MAX_BOOST    = Number(process.env.PRIOR_MAX_BOOST || 1.4);// prior 보정 상한
const PRIOR_STRONG_THR   = Number(process.env.PRIOR_STRONG_THR || 0.70); // 채널 prior 업데이트에 쓸 강한 신뢰 임계치

// 디버그
const SR_DEBUG           = process.env.SR_DEBUG === '1';

const TARGET_TREND_FILE  = path.join(__dirname, '..', 'public', 'kw-trend.json');
const RULES_PATH         = process.env.SCORING_RULES_PATH || path.join(__dirname, '..', 'public', 'category-rules.json');
const CH_PRIOR_PATH      = process.env.CH_PRIOR_PATH || path.join(__dirname, '..', 'public', 'ch-prior.json');
const DEBUG_OUT_PATH     = path.join(__dirname, '..', 'public', 'kw-debug.json');

// 프론트 라벨(표시 순서)
const CATEGORIES = ['AI','게임','커뮤니티','리뷰','정치','연예','시니어','오피셜','스포츠'];

// ------------------ 유틸 ------------------
function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function readJsonSafe(p, fallback={}) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw || '{}');
  } catch { return fallback; }
}
function writeJsonPretty(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

// ------------------ 규칙/채널 prior 로드 ------------------
const RULES = readJsonSafe(RULES_PATH, {});
const CHPR  = readJsonSafe(CH_PRIOR_PATH, {});

const FIELD_W = RULES?.global?.field_weights || { title:0.45, tags:0.25, description:0.15, channel:0.15 };
const NEG_PENALTY = 0.4; // 네거티브 토큰 히트 시 곱해줄 페널티

// rule key -> 프론트 표기 라벨
const RULE2LABEL = {
  ai: 'AI',
  sports: '스포츠',
  entertainment: '연예',
  senior: '시니어',
  game: '게임',
  community: '커뮤니티',
  official: '오피셜',
  review: '리뷰',
  politics: '정치',
};

// baseline p0 (uniform)
const RULE_KEYS = RULES?.categories ? Object.keys(RULES.categories) : [];
const P0 = RULE_KEYS.length ? 1 / RULE_KEYS.length : 0.1;

// ------------------ 텍스트 전처리 & 매칭 ------------------
const stripPunctRe = /[^\p{L}\p{N}\s]/gu; // 글자/숫자/공백 외 제거(유니코드)
function norm(s='') {
  return String(s)
    .toLowerCase()
    .replace(stripPunctRe, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function countHits(text, tokens) {
  if (!tokens || !tokens.length) return 0;
  let hits = 0;
  for (const t of tokens) {
    const tok = norm(t);
    if (!tok) continue;
    if (text.includes(tok)) hits++;
  }
  return hits;
}
function fieldScore(text, includeTokens) {
  if (!includeTokens || includeTokens.length===0) return 0;
  const hits = countHits(text, includeTokens);
  if (hits<=0) return 0;
  if (hits===1) return 0.5;
  return 1.0;
}
function contentScoreByFields({title, tags, description, channelTitle}, includeTokens) {
  const t  = norm(title);
  const tg = norm((tags||[]).join(' '));
  const d  = norm(description);
  const ch = norm(channelTitle);
  const sTitle = fieldScore(t, includeTokens);
  const sTags  = fieldScore(tg, includeTokens);
  const sDesc  = fieldScore(d, includeTokens);
  const sCh    = fieldScore(ch, includeTokens);
  return (FIELD_W.title*sTitle + FIELD_W.tags*sTags + FIELD_W.description*sDesc + FIELD_W.channel*sCh);
}
function hasNegative({title, tags, description, channelTitle}, excludeTokens) {
  if (!excludeTokens || excludeTokens.length===0) return false;
  const t  = norm(title);
  const tg = norm((tags||[]).join(' '));
  const d  = norm(description);
  const ch = norm(channelTitle);
  const hits = (
    countHits(t, excludeTokens) +
    countHits(tg, excludeTokens) +
    countHits(d, excludeTokens) +
    countHits(ch, excludeTokens)
  );
  return hits > 0;
}

// ------------------ YouTube API ------------------
async function ytSearch(q, pageToken='') {
  const params = new URLSearchParams({
    part:'snippet',
    type:'video',
    maxResults:String(RESULTS_PER_PAGE),
    q,
    order:'date',
    publishedAfter: new Date(Date.now()-LOOKBACK_DAYS_SEARCH*86400e3).toISOString(),
  });
  if (pageToken) params.set('pageToken', pageToken);
  const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
  return httpGet(url);
}
async function ytVideos(videoIds) {
  if (!videoIds.length) return { items: [] };
  const params = new URLSearchParams({
    part:'statistics,snippet,contentDetails',
    id: videoIds.join(','),
  });
  const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`;
  return httpGet(url);
}

// ------------------ Prior 계산 ------------------
function priorOf(channelId, ruleKey) {
  const rec = CHPR[channelId] || {};
  const hits = Number(rec[ruleKey] || 0);
  const tot  = Number(rec._total || 0);
  const prior = (hits + PRIOR_ALPHA * P0) / (tot + PRIOR_ALPHA); // 0..1
  // neutral(p0) 대비 상대값 → 1.0이 중립
  let boost = (prior / P0); // >1 선호, <1 비선호
  // 부드럽게: 0.5 + 0.5*(prior/P0) 형태로 축소할 수도 있으나,
  // 범위를 하한/상한으로 클램핑
  if (!Number.isFinite(boost) || boost<=0) boost = 1.0;
  boost = Math.max(PRIOR_MIN_BOOST, Math.min(PRIOR_MAX_BOOST, boost));
  return boost;
}
function updatePrior(channelId, topRuleKey) {
  if (!channelId || !topRuleKey) return;
  const rec = CHPR[channelId] || {};
  rec[topRuleKey] = Number(rec[topRuleKey] || 0) + 1;
  rec._total      = Number(rec._total || 0) + 1;
  rec._updatedAt  = new Date().toISOString();
  CHPR[channelId] = rec;
}

// ------------------ 스코어링 ------------------
function scoreVideoAllCats(v) {
  const sn = v.snippet || {};
  const fields = {
    title: sn.title || '',
    tags: sn.tags || [],
    description: sn.description || '',
    channelTitle: sn.channelTitle || '',
  };
  const channelId = sn.channelId || '';

  const cats = RULES?.categories ? Object.keys(RULES.categories) : [];
  const content = {};
  const boosted = {};
  let sumBoosted = 0;

  // 1) content score (룰 기반)
  for (const key of cats) {
    const cat = RULES.categories[key];
    const include = cat.include_tokens || [];
    const exclude = cat.exclude_tokens || [];
    let s = contentScoreByFields(fields, include);
    if (hasNegative(fields, exclude)) s *= 0.4;
    content[key] = s;
  }

  // 2) 채널 prior boost 적용 (정규화 전)
  for (const key of cats) {
    const s = content[key] || 0;
    if (s <= 0) { boosted[key] = 0; continue; }
    const b = priorOf(channelId, key); // 0.6 ~ 1.4 (기본)
    const sb = s * b;
    boosted[key] = sb;
    sumBoosted += sb;
  }

  if (sumBoosted <= 0) return { weights:{}, content, boosted };

  // 3) 정규화(합=1) → 멀티레이블 가중치
  const weights = {};
  for (const key of cats) weights[key] = boosted[key] / sumBoosted;

  // 4) prior 업데이트(학습): 가장 자신있는 카테고리만, 강한 신뢰일 때만
  const entries = Object.entries(content).sort((a,b)=>b[1]-a[1]);
  const [topKey, topScore] = entries[0] || [null, 0];
  if (topKey && topScore >= PRIOR_STRONG_THR) {
    updatePrior(channelId, topKey);
  }

  return { weights, content, boosted };
}

function initDailySums() {
  const res = {};
  // RULES 기준 생성
  const keys = RULES?.categories ? Object.keys(RULES.categories) : [];
  if (keys.length) {
    for (const k of keys) {
      const label = RULE2LABEL[k] || k;
      res[label] = { views: 0, n: 0 };
    }
  } else {
    for (const label of CATEGORIES) res[label] = { views: 0, n: 0 };
  }
  return res;
}

// ------------------ 메인 ------------------
async function main() {
  const ymd = todayYmd();

  // 이전 시계열 로드
  let oldSeries = {};
  try {
    const raw = fs.readFileSync(TARGET_TREND_FILE, 'utf8');
    const js = JSON.parse(raw||'{}');
    oldSeries = js.series || {};
  } catch {}

  const dailySums = initDailySums();
  const processed = new Set();
  const debugRows = [];

  for (const q of CATEGORIES) {
    let pageToken = '';
    let ids = [];

    for (let p=0; p<RESULT_PAGES_PER_RUN; p++) {
      const js = await ytSearch(q, pageToken);
      const items = js?.items || [];
      const newIds = items.map(it => it?.id?.videoId).filter(Boolean);
      ids.push(...newIds);
      pageToken = js?.nextPageToken || '';
      if (!pageToken) break;
    }

    for (let i=0; i<ids.length; i+=50) {
      const part = ids.slice(i, i+50);
      const vjs = await ytVideos(part);
      const details = vjs?.items || [];
      for (const v of details) {
        const vid = v.id;
        const sn  = v.snippet || {};
        const stats = v.statistics || {};
        if (!vid || processed.has(vid)) continue;
        processed.add(vid);

        const vc = Number(stats.viewCount || 0);
        if (!isFinite(vc) || vc <= 0) continue;

        const { weights, content, boosted } = scoreVideoAllCats(v);
        const keys = Object.keys(weights);
        if (keys.length === 0) continue;

        // 가중 분배 합산
        for (const rk of keys) {
          const w = weights[rk];
          const label = RULE2LABEL[rk] || rk;
          if (!dailySums[label]) dailySums[label] = { views: 0, n: 0 };
          dailySums[label].views += vc * w;
          dailySums[label].n     += w;
        }

        if (SR_DEBUG && debugRows.length < 120) {
          // 디버깅용 일부 샘플
          const top = Object.entries(weights).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v]) => ({
            rule: k, label: RULE2LABEL[k] || k, w: Number(v.toFixed(3)),
            content: Number((content[k]||0).toFixed(3)),
            boosted: Number((boosted[k]||0).toFixed(3)),
          }));
          debugRows.push({
            videoId: vid,
            channelId: sn.channelId,
            title: (sn.title||'').slice(0,120),
            viewCount: vc,
            top
          });
        }
      }
    }
  }

  // 병합(일자별), MAX_DAYS_KEEP 유지
  function mergeSeries(oldSeries, appended) {
    const out = { ...oldSeries };
    for (const [label, rec] of Object.entries(appended)) {
      const list = Array.isArray(out[label]) ? out[label].slice() : [];
      const idx = list.findIndex(x => x.d === rec.d);
      if (idx >= 0) list[idx] = rec; else list.push(rec);
      list.sort((a,b) => (a.d < b.d ? -1 : 1));
      while (list.length > MAX_DAYS_KEEP) list.shift();
      out[label] = list;
    }
    return out;
  }

  const appended = {};
  for (const label of CATEGORIES) {
    const cur = dailySums[label] || { views: 0, n: 0 };
    appended[label] = {
      d: ymd,
      views: Math.round(cur.views),
      n: Math.round(cur.n),
    };
  }

  const merged = mergeSeries(oldSeries, appended);
  const out = {
    updatedAt: new Date().toISOString(),
    meta: { scoring: RULES?.categories ? "rules+prior-v1" : "classic" },
    series: merged
  };
  writeJsonPretty(TARGET_TREND_FILE, out);

  // prior & debug 저장
  writeJsonPretty(CH_PRIOR_PATH, CHPR);
  if (SR_DEBUG) writeJsonPretty(DEBUG_OUT_PATH, { ymd, sample: debugRows });

  await writeKeyStatus(`kw-trend.json updated (${ymd}) — mode=${out.meta.scoring}, prior: ${Object.keys(CHPR).length} ch.`);
}

main().catch(err => {
  console.error('❌ fetch-trend failed:', err);
  process.exit(1);
});
