// scripts/fetch-trend.js
// ESM module, Node >= 20
// 기능 요약:
// - 카테고리별 YouTube 검색(RESULT_PAGES_PER_RUN x 50)
// - videos.list 상세 조회 → 룰+채널 prior(수동 라벨 포함)로 멀티레이블 가중치 산출
// - 한국 타겟팅(언어/지역/채널국가 캐시) 적용
// - 시계열 합산 → public/kw-trend.json
// - prior/ch-geo/디버그/리뷰 파일 저장
//
// 환경변수 주요 항목(워크플로 env):
// RESULT_PAGES_PER_RUN, LOOKBACK_DAYS_SEARCH, MAX_DAYS_KEEP
// PRIOR_ALPHA, PRIOR_MIN_BOOST, PRIOR_MAX_BOOST, PRIOR_STRONG_THR
// REGION_FILTER, LANG_PREF, LANG_STRICT, LANG_MIN_HANGUL_RATIO
// CHANNEL_GEO_STRICT, CH_GEO_CACHE_PATH
// SR_DEBUG
// === 수동 라벨링 ===
// CH_MANUAL_PATH, MANUAL_MODE('soft'|'hard'), MANUAL_POS_BOOST, MANUAL_NEG_BOOST, SR_CH_REVIEW

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { httpGet, writeKeyStatus } from './key-rotator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ------------------ 수집/보관 기본 설정 ------------------
const RESULT_PAGES_PER_RUN = Number(process.env.RESULT_PAGES_PER_RUN || 2);
const RESULTS_PER_PAGE     = 50;
const MAX_DAYS_KEEP        = Number(process.env.MAX_DAYS_KEEP || 180);
const LOOKBACK_DAYS_SEARCH = Number(process.env.LOOKBACK_DAYS_SEARCH || 14);

// Prior 설정
const PRIOR_ALPHA      = Number(process.env.PRIOR_ALPHA || 20);
const PRIOR_MIN_BOOST  = Number(process.env.PRIOR_MIN_BOOST || 0.6);
const PRIOR_MAX_BOOST  = Number(process.env.PRIOR_MAX_BOOST || 1.4);
const PRIOR_STRONG_THR = Number(process.env.PRIOR_STRONG_THR || 0.70);

// 디버그
const SR_DEBUG = process.env.SR_DEBUG === '1';

// 파일 경로
const TARGET_TREND_FILE  = path.join(__dirname, '..', 'public', 'kw-trend.json');
const RULES_PATH         = process.env.SCORING_RULES_PATH || path.join(__dirname, '..', 'public', 'category-rules.json');
const CH_PRIOR_PATH      = process.env.CH_PRIOR_PATH || path.join(__dirname, '..', 'public', 'ch-prior.json');
const DEBUG_OUT_PATH     = path.join(__dirname, '..', 'public', 'kw-debug.json');

// 프런트 표기 라벨(표시 순서 참고)
const CATEGORIES = ['AI','게임','커뮤니티','리뷰','정치','연예','시니어','오피셜','스포츠'];

// ------------------ 한국 타겟팅 설정 ------------------
const REGION_FILTER = process.env.REGION_FILTER || 'KR';                  // 검색 지역 편향
const LANG_PREF = process.env.LANG_PREF || 'ko';                          // 검색 언어 편향
const LANG_STRICT = process.env.LANG_STRICT === '1';                      // 한국어 아니면 제외
const LANG_MIN_HANGUL_RATIO = Number(process.env.LANG_MIN_HANGUL_RATIO || '0.15');
const CHANNEL_GEO_STRICT = process.env.CHANNEL_GEO_STRICT === '1';        // 채널 국가까지 제한
const CH_GEO_CACHE_PATH = process.env.CH_GEO_CACHE_PATH
  || path.join(__dirname, '..', 'public', 'ch-geo.json');

// ------------------ 수동 채널 라벨링 설정 ------------------
const CH_MANUAL_PATH   = process.env.CH_MANUAL_PATH || path.join(__dirname, '..', 'public', 'ch-manual.json');
const MANUAL_MODE      = process.env.MANUAL_MODE || 'soft';              // 'soft' | 'hard'
const MANUAL_POS_BOOST = Number(process.env.MANUAL_POS_BOOST || '1.6');  // 포함 라벨 부스트(최소치)
const MANUAL_NEG_BOOST = Number(process.env.MANUAL_NEG_BOOST || '0.8');  // 비포함 라벨 상한
const SR_CH_REVIEW     = process.env.SR_CH_REVIEW === '1';               // 리뷰 파일 생성

// ------------------ 공통 유틸 ------------------
function readJsonSafe(p, fallback = {}) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw || '{}');
  } catch { return fallback; }
}
function writeJsonPretty(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// ------------------ 규칙/priors/수동라벨/지오캐시 ------------------
const RULES   = readJsonSafe(RULES_PATH, {});
const CHPR    = readJsonSafe(CH_PRIOR_PATH, {});
const CH_MAN  = readJsonSafe(CH_MANUAL_PATH, {});   // {channelId:{rules:[...],note,...}}
const CH_GEO  = readJsonSafe(CH_GEO_CACHE_PATH, {});

const FIELD_W = RULES?.global?.field_weights || { title:0.45, tags:0.25, description:0.15, channel:0.15 };
const RULE_KEYS = RULES?.categories ? Object.keys(RULES.categories) : [];
const P0 = RULE_KEYS.length ? 1 / RULE_KEYS.length : 0.1; // prior baseline

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

// ------------------ 텍스트 전처리/매칭 ------------------
const stripPunctRe = /[^\p{L}\p{N}\s]/gu;
function norm(s='') {
  return String(s).toLowerCase().replace(stripPunctRe, ' ').replace(/\s+/g, ' ').trim();
}
function countHits(text, tokens) {
  if (!tokens || !tokens.length) return 0;
  let hits = 0;
  for (const t of tokens) {
    const tok = norm(t);
    if (tok && text.includes(tok)) hits++;
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

// ------------------ 한국어/채널국가 판정 ------------------
const HANGUL_RE = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/g;
function hangulRatio(s) {
  if (!s) return 0;
  const m = String(s).match(HANGUL_RE);
  return (m ? m.length : 0) / String(s).length;
}
function isKoreanSnippet(snippet, tags=[]) {
  const texts = [snippet?.title, snippet?.description, ...(Array.isArray(tags)?tags:[])].filter(Boolean).join(' ');
  const ratio = hangulRatio(texts);
  const langHints = [
    snippet?.defaultLanguage,
    snippet?.defaultAudioLanguage,
    snippet?.localized?.language
  ].filter(Boolean).map(x => String(x).toLowerCase());
  const hintKo = langHints.some(x => x.startsWith('ko'));
  return hintKo || ratio >= LANG_MIN_HANGUL_RATIO;
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
  // 한국 편향
  params.set('regionCode', REGION_FILTER);
  params.set('relevanceLanguage', LANG_PREF);
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
async function fetchChannelsCountry(chIds = []) {
  if (!chIds.length) return {};
  const out = {};
  for (let i=0; i<chIds.length; i+=50) {
    const ids = chIds.slice(i, i+50);
    const res = await httpGet('https://www.googleapis.com/youtube/v3/channels', {
      part: 'snippet', id: ids.join(','), maxResults: 50
    });
    for (const c of res.items ?? []) out[c.id] = c?.snippet?.country || null;
  }
  return out;
}

// ------------------ Prior(수동 라벨 반영 포함) ------------------
function priorOf(channelId, ruleKey) {
  const rec = CHPR[channelId] || {};
  const hits = Number(rec[ruleKey] || 0);
  const tot  = Number(rec._total || 0);
  const prior = (hits + PRIOR_ALPHA * P0) / (tot + PRIOR_ALPHA);
  let boost = prior / P0;
  if (!Number.isFinite(boost) || boost<=0) boost = 1.0;
  boost = Math.max(PRIOR_MIN_BOOST, Math.min(PRIOR_MAX_BOOST, boost));

  // --- 수동 채널 라벨 반영 ---
  const man = CH_MAN[channelId];
  if (man && Array.isArray(man.rules)) {
    const hit = man.rules.includes(ruleKey);
    if (MANUAL_MODE === 'hard') {
      boost = hit ? MANUAL_POS_BOOST : MANUAL_NEG_BOOST;
    } else { // soft
      if (hit) boost = Math.max(boost, MANUAL_POS_BOOST);
      else     boost = Math.min(boost, MANUAL_NEG_BOOST);
    }
  }

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

  // 1) 룰 기반 content score
  for (const key of cats) {
    const cat = RULES.categories[key];
    const include = cat.include_tokens || [];
    const exclude = cat.exclude_tokens || [];
    let s = contentScoreByFields(fields, include);
    if (hasNegative(fields, exclude)) s *= 0.4;
    content[key] = s;
  }

  // 2) prior(수동 라벨 포함) 부스트
  for (const key of cats) {
    const s = content[key] || 0;
    if (s <= 0) { boosted[key] = 0; continue; }
    const b = priorOf(channelId, key);
    const sb = s * b;
    boosted[key] = sb;
    sumBoosted += sb;
  }
  if (sumBoosted <= 0) return { weights:{}, content, boosted };

  // 3) 정규화
  const weights = {};
  for (const key of cats) weights[key] = boosted[key] / sumBoosted;

  // 4) prior 업데이트(강한 신뢰일 때만)
  const entries = Object.entries(content).sort((a,b)=>b[1]-a[1]);
  const [topKey, topScore] = entries[0] || [null, 0];
  if (topKey && topScore >= PRIOR_STRONG_THR) updatePrior(channelId, topKey);

  return { weights, content, boosted };
}

function initDailySums() {
  const res = {};
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
  const reviewMap = {}; // SR_CH_REVIEW용

  // KR 필터 요약 카운터
  let kept = 0, dropLang = 0, dropGeo = 0;

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

      // 채널 국가 캐시 보강
      const needIds = [...new Set(details.map(v => v?.snippet?.channelId))]
        .filter(id => id && CH_GEO[id] === undefined);
      if (needIds.length) {
        const fetched = await fetchChannelsCountry(needIds);
        Object.assign(CH_GEO, fetched);
        writeJsonPretty(CH_GEO_CACHE_PATH, CH_GEO);
      }

      for (const v of details) {
        const vid = v.id;
        const sn  = v.snippet || {};
        const stats = v.statistics || {};
        if (!vid || processed.has(vid)) continue;
        processed.add(vid);

        const tags = sn.tags || [];
        // --- 한국어 엄격 필터 ---
        if (LANG_STRICT && !isKoreanSnippet(sn, tags)) { dropLang++; continue; }
        // --- 채널 국가 엄격 필터 ---
        const chCountry = CH_GEO[sn.channelId] || null;
        if (CHANNEL_GEO_STRICT && chCountry && chCountry !== 'KR') { dropGeo++; continue; }

        const vc = Number(stats.viewCount || 0);
        if (!isFinite(vc) || vc <= 0) continue;

        const { weights, content, boosted } = scoreVideoAllCats(v);
        const keys = Object.keys(weights);
        if (keys.length === 0) continue;

        // 일일 합산
        for (const rk of keys) {
          const w = weights[rk];
          const label = RULE2LABEL[rk] || rk;
          if (!dailySums[label]) dailySums[label] = { views: 0, n: 0 };
          dailySums[label].views += vc * w;
          dailySums[label].n     += w;
        }
        kept++;

        // 리뷰 파일용 집계(옵션)
        if (SR_CH_REVIEW) {
          const chId = sn.channelId;
          const topKey = Object.entries(weights).sort((a,b)=>b[1]-a[1])[0]?.[0];
          const r = reviewMap[chId] || (reviewMap[chId] = {
            channelId: chId,
            channelTitle: sn.channelTitle || '',
            country: chCountry || null,
            videos: 0,
            views: 0,
            suggest: {},
            examples: []
          });
          r.videos += 1;
          r.views  += vc;
          if (topKey) r.suggest[topKey] = (r.suggest[topKey] || 0) + 1;
          if (r.examples.length < 3) r.examples.push((sn.title || '').slice(0, 80));
        }

        // 디버그 샘플
        if (SR_DEBUG && debugRows.length < 120) {
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

  // 병합 및 보관
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
    appended[label] = { d: todayYmd(), views: Math.round(cur.views), n: Math.round(cur.n) };
  }
  const merged = mergeSeries(oldSeries, appended);
  const out = {
    updatedAt: new Date().toISOString(),
    meta: { scoring: RULES?.categories ? "rules+prior-v1" : "classic" },
    series: merged
  };
  writeJsonPretty(TARGET_TREND_FILE, out);

  // 보조 산출물
  writeJsonPretty(CH_PRIOR_PATH, CHPR);
  writeJsonPretty(CH_GEO_CACHE_PATH, CH_GEO);
  if (SR_DEBUG) writeJsonPretty(DEBUG_OUT_PATH, { ymd: todayYmd(), sample: debugRows });

  if (SR_CH_REVIEW) {
    const rows = Object.values(reviewMap).sort((a,b)=>b.views-a.views);
    writeJsonPretty(path.join(__dirname,'..','public','ch-review.json'),
      { updatedAt: new Date().toISOString(), rows });
    // CSV (참고: 워크플로 커밋 스텝은 *.csv 추가 필요)
    const header = 'channelId,channelTitle,country,videos,views,suggest,examples\n';
    const esc = s => `"${String(s||'').replace(/"/g,'""')}"`;
    const csv = header + rows.map(r =>
      [r.channelId, esc(r.channelTitle), r.country||'', r.videos, Math.round(r.views),
       esc(Object.entries(r.suggest).map(([k,n])=>`${k}:${n}`).join('|')),
       esc(r.examples.join(' / '))].join(',')
    ).join('\n');
    fs.writeFileSync(path.join(__dirname,'..','public','ch-review.csv'), csv, 'utf8');
  }

  await writeKeyStatus({
    event: 'kw-trend-updated',
    mode: out.meta.scoring,
    priorChannels: Object.keys(CHPR).length,
    krFilter: { kept, dropLang, dropGeo, langStrict: LANG_STRICT, langThr: LANG_MIN_HANGUL_RATIO, geoStrict: CHANNEL_GEO_STRICT }
  });
}

main().catch(err => {
  console.error('❌ fetch-trend failed:', err);
  process.exit(1);
});
