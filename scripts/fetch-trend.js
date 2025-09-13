// scripts/fetch-trend.js
// ESM module. Node >=20
// - 시간당 카테고리 검색(2 pages x 9cats), videos.list로 상세 조회
// - rule-based scoring으로 Δviews 가중 합산(멀티라벨 분배)
// - kw-trend.json에 일 단위 병합 (MAX_DAYS_KEEP 유지)
// - meta.scoring="rules-v1" 추가
// - 키 회전은 scripts/key-rotator.js 의 httpGet 사용

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

const TARGET_TREND_FILE = path.join(__dirname, '..', 'public', 'kw-trend.json');
const RULES_PATH        = process.env.SCORING_RULES_PATH || path.join(__dirname, '..', 'public', 'category-rules.json');

// 한국어+영문 카테고리 라벨(프론트 표기와 맞춤)
const CATEGORIES = ['AI','게임','커뮤니티','리뷰','정치','연예','시니어','오피셜','스포츠'];

// ------------------ 유틸 ------------------
function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw || '{}');
  } catch { return {}; }
}
function writeJsonPretty(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

// ------------------ 규칙 로드 ------------------
const RULES = readJsonSafe(RULES_PATH);
if (!RULES?.categories) {
  console.warn(`[rules] ${RULES_PATH} 를 찾지 못했거나 categories가 비어있습니다. classic 모드로 진행됩니다.`);
}
const FIELD_W = RULES?.global?.field_weights || { title:0.45, tags:0.25, description:0.15, channel:0.15 };
const NEG_PENALTY = 0.4; // 네거티브 토큰 히트 시 곱해줄 페널티

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
    // 간단 포함 검색(한글 조사·띄어쓰기 변형 완화)
    if (text.includes(tok)) hits++;
  }
  return hits;
}
function fieldScore(text, includeTokens) {
  if (!includeTokens || includeTokens.length===0) return 0;
  const hits = countHits(text, includeTokens);
  // 1개 히트=0.5, 2개 이상=1.0 (과도 포화 방지)
  if (hits<=0) return 0;
  if (hits===1) return 0.5;
  return 1.0;
}
function contentScoreByFields({title, tags, description, channelTitle}, includeTokens) {
  const t = norm(title);
  const tg = norm((tags||[]).join(' '));
  const d = norm(description);
  const ch = norm(channelTitle);
  const sTitle = fieldScore(t, includeTokens);
  const sTags  = fieldScore(tg, includeTokens);
  const sDesc  = fieldScore(d, includeTokens);
  const sCh    = fieldScore(ch, includeTokens);
  return (FIELD_W.title*sTitle + FIELD_W.tags*sTags + FIELD_W.description*sDesc + FIELD_W.channel*sCh);
}
function hasNegative({title, tags, description, channelTitle}, excludeTokens) {
  if (!excludeTokens || excludeTokens.length===0) return false;
  const t = norm(title);
  const tg = norm((tags||[]).join(' '));
  const d = norm(description);
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

// ------------------ 핵심: 스코어링 & 가중 합산 ------------------
function scoreVideoAllCats(v) {
  // 입력: videos.list item
  const sn = v.snippet || {};
  const stats = v.statistics || {};
  const fields = {
    title: sn.title || '',
    tags: sn.tags || [],
    description: sn.description || '',
    channelTitle: sn.channelTitle || '',
  };

  const cats = RULES?.categories ? Object.keys(RULES.categories) : [];
  const scores = {};
  let sum = 0;
  for (const key of cats) {
    const cat = RULES.categories[key];
    const include = cat.include_tokens || [];
    const exclude = cat.exclude_tokens || [];
    let s = contentScoreByFields(fields, include);
    if (hasNegative(fields, exclude)) s *= NEG_PENALTY;
    scores[key] = s;
    sum += s;
  }
  // 정규화(합=1). 합이 0이면 빈 객체 반환 → 호출부에서 스킵
  if (sum > 0) {
    for (const k of Object.keys(scores)) scores[k] = scores[k] / sum;
  } else {
    return {};
  }
  return scores; // { ai:0.3, sports:0.1, ... }
}

function initDailySums() {
  const res = {};
  // RULES 존재 시 규칙 카테고리 기준, 없으면 프론트 라벨 기준으로 생성
  const keys = RULES?.categories ? Object.keys(RULES.categories) : [];
  if (keys.length) {
    for (const k of keys) res[k] = { views: 0, n: 0 };
  } else {
    for (const label of CATEGORIES) res[label] = { views: 0, n: 0 };
  }
  return res;
}

function mapRuleKeyToLabel(ruleKey) {
  // ruleKey -> 프론트 표기 라벨 매핑
  const m = {
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
  return m[ruleKey] || ruleKey;
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

  // 일일 합산 초기화
  const dailySums = initDailySums();
  const processed = new Set(); // videoId 중복 방지(카테고리 검색 겹침 제거)

  // 1) 카테고리별 검색(2페이지) -> videos.list -> 스코어링 -> 멀티라벨 가중 합산
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

    // videos.list는 50개씩
    for (let i=0; i<ids.length; i+=50) {
      const part = ids.slice(i, i+50);
      const vjs = await ytVideos(part);
      const details = vjs?.items || [];
      for (const v of details) {
        const vid = v.id;
        if (!vid || processed.has(vid)) continue;
        processed.add(vid);

        const vc = Number(v?.statistics?.viewCount || 0);
        if (!isFinite(vc) || vc <= 0) continue;

        // 규칙 기반 스코어(합=1). 합=0이면 제외
        const weights = scoreVideoAllCats(v);
        const keys = Object.keys(weights);
        if (keys.length === 0) continue;

        // 가중 분배
        for (const rk of keys) {
          const w = weights[rk];
          const label = mapRuleKeyToLabel(rk);
          if (!dailySums[label]) dailySums[label] = { views: 0, n: 0 };
          dailySums[label].views += vc * w;
          dailySums[label].n     += w; // 유효 표본 기여도(가중)
        }
      }
    }
  }

  // 2) 병합(일자별), MAX_DAYS_KEEP 유지
  // 라벨 목록(출력용): 프론트 라벨 기준으로 정렬
  const outKeys = CATEGORIES;

  const appended = {};
  for (const label of outKeys) {
    const cur = dailySums[label] || { views: 0, n: 0 };
    appended[label] = {
      d: ymd,
      views: Math.round(cur.views),
      n: Math.round(cur.n)
    };
  }

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

  const merged = mergeSeries(oldSeries, appended);
  const out = {
    updatedAt: new Date().toISOString(),
    meta: { scoring: RULES?.categories ? "rules-v1" : "classic" },
    series: merged
  };
  writeJsonPretty(TARGET_TREND_FILE, out);

  await writeKeyStatus(`kw-trend.json updated (${ymd}) — mode=${out.meta.scoring}`);
}

main().catch(err => {
  console.error('❌ fetch-trend failed:', err);
  process.exit(1);
});
