// scripts/fetch-trend.js
// public/kw-trend.json + public/kw-status.json 생성
import fs from 'fs';
import path from 'path';
import { YT } from './lib/yt.js';

const OUTPUT = 'public/kw-trend.json';
const REGION = 'KR';
const LANG   = 'ko';

// 비용 제어 (필요 시 조정)
const MAX_RESULTS = parseInt(process.env.SEARCH_MAX || '25', 10);
const QUERIES_PER_CAT = parseInt(process.env.QPER || '1', 10);

const QUERIES = {
  "정치": ["정치", "국회"],
  "AI": ["AI", "인공지능", "chatgpt"],
  "연예": ["연예", "연예뉴스"],
  "스포츠": ["스포츠", "야구", "축구"],
  "커뮤니티": ["커뮤니티", "밈"],
  "게임": ["게임", "게임뉴스"],
  "시니어": ["시니어", "실버"],
  "오피셜": ["공식", "오피셜"],
  "리뷰": ["리뷰", "언박싱"]
};

const KEYS = [
  process.env.YT_KEY_1, process.env.YT_KEY_2, process.env.YT_KEY_3,
  process.env.YT_KEY_4, process.env.YT_KEY_5
];

const yt = new YT(KEYS);

function dayStr(d){ return d.toISOString().slice(0,10); }
function plusDays(d,n){ const x=new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }
function readJSON(p){ try{ return JSON.parse(fs.readFileSync(p,'utf-8')); } catch{ return null; } }
function uniq(a){ return [...new Set(a)]; }

async function fetchDay(category, dateISO){
  const qlist = QUERIES[category] || [category];
  let views = 0, n = 0, ids = [];

  for (const q of qlist.slice(0, QUERIES_PER_CAT)) {
    const res = await yt.search({
      part: 'snippet',
      q,
      type: 'video',
      maxResults: MAX_RESULTS,
      publishedAfter:  `${dateISO}T00:00:00Z`,
      publishedBefore: `${dateISO}T23:59:59Z`,
      relevanceLanguage: LANG,
      regionCode: REGION,
      order: 'viewCount',
      videoDuration: 'short'
    });
    ids.push(...(res.items || []).map(i => i.id && i.id.videoId).filter(Boolean));
  }

  ids = uniq(ids);
  for (let i=0;i<ids.length;i+=50){
    const chunk = ids.slice(i,i+50);
    if (!chunk.length) break;
    const v = await yt.videos({
      part: 'statistics',
      id: chunk.join(','),
      fields: 'items(statistics/viewCount)'
    });
    for (const it of (v.items || [])) {
      const s = it.statistics || {};
      views += Number(s.viewCount || 0);
      n++;
    }
  }

  return { views, n };
}

async function main(){
  const tStart = Date.now();
  const today = new Date(); today.setUTCHours(0,0,0,0);

  const existing = readJSON(OUTPUT) || { updatedAt: null, series: {} };
  for (const k of Object.keys(QUERIES)) existing.series[k] = existing.series[k] || [];

  const bootstrapDays = parseInt(process.env.BOOTSTRAP_DAYS || '0', 10);
  let days = [];
  if (bootstrapDays > 0){
    const start = plusDays(today, -bootstrapDays + 1);
    for (let d = new Date(start); d <= today; d = plusDays(d,1)) days.push(dayStr(d));
  } else {
    days = [ dayStr(today) ];
  }

  for (const ds of days){
    for (const cat of Object.keys(QUERIES)){
      const arr = existing.series[cat];
      const idx = arr.findIndex(x => x.d === ds);
      if (idx !== -1) arr.splice(idx,1);

      const r = await fetchDay(cat, ds);
      arr.push({ d: ds, views: r.views, n: r.n });
      arr.sort((a,b) => a.d.localeCompare(b.d));
      if (arr.length > 180) existing.series[cat] = arr.slice(-180);
    }
  }

  existing.updatedAt = dayStr(today);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(existing, null, 2));
  console.log('Wrote', OUTPUT, 'updatedAt', existing.updatedAt);

  // --- 키 로테이션 상태 파일 출력 ---
  const status = yt.getStats();
  status.updatedAt = existing.updatedAt;
  status.runtimeSec = Math.round((Date.now()-tStart)/1000);
  fs.writeFileSync('public/kw-status.json', JSON.stringify(status, null, 2));
  console.log('Wrote public/kw-status.json');
}

main().catch(e => {
  const msg = String(e || '');
  if (msg.includes('quotaExceeded')) {
    console.warn('[INFO] Quota exhausted. 기존 kw-trend.json 유지 후 성공 처리');
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});
