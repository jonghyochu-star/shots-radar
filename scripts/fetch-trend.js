/**
 * scripts/fetch-trend.js
 * - 매시간 2페이지(RESULT_PAGES_PER_RUN=2) 수집
 * - YT API 키 라운드로빈 로테이션 (Actions Secrets: YT_API_KEY_1..5)
 * - 기존 public/kw-trend.json과 "일 단위" 병합(최대 180일 유지)
 */



import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// === 설정 ===
const RESULT_PAGES_PER_RUN = 2;        // ✅ 매시간 2 페이지
const RESULTS_PER_PAGE     = 50;       // search 최대 50
const MAX_DAYS_KEEP        = 180;      // 180일 유지
const CATEGORIES = ['AI','게임','커뮤니티','리뷰','정치','연예','시니어','오피셜','스포츠'];

// 서버/프론트 동일 키 사용 가능. 여기엔 "서버에서 쓸" 키를 Secrets로 넣어주세요.
const KEY_POOL = [
  process.env.YT_KEY_1,
  process.env.YT_KEY_2,
  process.env.YT_KEY_3,
  process.env.YT_KEY_4,
  process.env.YT_KEY_5,
].filter(Boolean);

if (!KEY_POOL.length) {
  console.error('❌ No YT API keys in Secrets (YT_API_KEY_1..5)');
  process.exit(1);
}
let keyIdx = 0;
function nextKey(){ const k = KEY_POOL[keyIdx]; keyIdx = (keyIdx+1) % KEY_POOL.length; return k; }



// YouTube API
async function ytSearch(q, pageToken=''){
  const params = new URLSearchParams({
    key: nextKey(),
    part: 'snippet',
    type: 'video',
    maxResults: String(RESULTS_PER_PAGE),
    q,
    order: 'date',
    publishedAfter: new Date(Date.now()-14*86400e3).toISOString(), // 최근 14일
  });
  if(pageToken) params.set('pageToken', pageToken);
  const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
  return httpGet(url); // search 1회 = 100 unit
}
async function ytVideos(ids){
  const params = new URLSearchParams({
    key: nextKey(),
    part: 'statistics,contentDetails,snippet',
    id: ids.join(',')
  });
  const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`;
  return httpGet(url); // videos 1회 = 1 unit
}

// 합계
function sumViews(items){
  let total = 0, n=0;
  for(const it of items){
    const v = Number(it?.statistics?.viewCount||0);
    if(!Number.isNaN(v)){ total += v; n++; }
  }
  return { views: total, n };
}

// 병합
function mergeSeries(oldSeries, append){
  const out = { ...oldSeries };
  for(const [cat, rec] of Object.entries(append)){
    const arr = Array.isArray(out[cat]) ? out[cat].slice() : [];
    const idx = arr.findIndex(x=> x.d === rec.d);
    if(idx>=0) arr[idx] = rec; else arr.push(rec);
    arr.sort((a,b)=> (a.d < b.d ? -1 : 1));
    while(arr.length > MAX_DAYS_KEEP) arr.shift();
    out[cat] = arr;
  }
  return out;
}
function todayYmd(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

async function main(){
  const TARGET = path.join(__dirname, '..', 'public', 'kw-trend.json');

  // 1) 기존 로드
  let old = {};
  try {
    const raw = fs.readFileSync(TARGET, 'utf8');
    old = JSON.parse(raw||'{}')?.series || {};
  } catch(e){ /* 최초 실행일 수 있음 */ }

  const ymd = todayYmd();
  const appended = {}; // {카테고리:{d,views,n}}

  // 2) 카테고리 순회 (매시간 2페이지)
  for(const cat of CATEGORIES){
    let pageToken = '';
    let allVideoIds = [];

    for(let p=0; p<RESULT_PAGES_PER_RUN; p++){
      const js = await ytSearch(cat, pageToken);
      const ids = (js?.items||[])
        .map(it=> it?.id?.videoId)
        .filter(Boolean);
      allVideoIds.push(...ids);

      pageToken = js?.nextPageToken || '';
      if(!pageToken) break;
    }

    // videos.list(50개 단위)
    const batches = [];
    for(let i=0; i<allVideoIds.length; i+=50){
      const part = allVideoIds.slice(i, i+50);
      if(part.length) batches.push(part);
    }

    const details = [];
    for(const part of batches){
      const v = await ytVideos(part);
      details.push(...(v?.items||[]));
    }

    const {views, n} = sumViews(details);
    appended[cat] = { d: ymd, views, n };
    console.log(`✔ ${cat}: videos=${details.length}, views=${views.toLocaleString()}`);
  }

  // 3) 병합 & 저장
  const merged = mergeSeries(old, appended);
  const out = {
    updatedAt: new Date().toISOString(),
    series: merged
  };
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, JSON.stringify(out, null, 2), 'utf8');

  console.log(`✅ kw-trend.json updated: ${TARGET}`);
}

main().catch(err=>{
  console.error('❌ fetch-trend failed:', err);
  process.exit(1);
});
