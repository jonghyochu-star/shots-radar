
import fs from 'fs';
import path from 'path';
// --- YT 모듈 (전역 fetch 사용, node-fetch 불필요) ---
const COST = { search: 100, videos: 1 };

class YT {
  constructor(keys) {
    this.keys = keys.filter(Boolean).map(k => ({ key: k, used: 0 }));
    if (this.keys.length === 0) throw new Error("No API keys provided");
  }
  pick() { return this.keys.sort((a,b)=>a.used-b.used)[0]; }
  async call(endpoint, params, cost) {
    let lastErr;
    for (let i=0;i<this.keys.length;i++) {
      const k = this.pick();
      const url = `https://www.googleapis.com/youtube/v3/${endpoint}?key=${k.key}&${new URLSearchParams(params)}`;
      const r = await fetch(url);
      if (r.ok) { k.used += cost; return r.json(); }
      const retriable = [403,429,500,503].includes(r.status);
      lastErr = new Error(`${r.status} ${await r.text()}`);
      if (!retriable) break;
      await new Promise(res=>setTimeout(res, 200*(i+1)));
    }
    throw lastErr;
  }
  search(params) { return this.call('search', params, COST.search); }
  videos(params) { return this.call('videos', params, COST.videos); }
}
// --- /YT 모듈 ---


const OUTPUT = 'public/kw-trend.json';
const REGION = 'KR';
const LANG = 'ko';
const MAX_RESULTS = 50;
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

function dayStr(d) { return d.toISOString().slice(0,10); }
function plusDays(d, n) { const x=new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p,'utf-8')); } catch { return null; } }
function uniq(arr) { return [...new Set(arr)]; }

const KEYS = [process.env.YT_KEY_1,process.env.YT_KEY_2,process.env.YT_KEY_3,process.env.YT_KEY_4,process.env.YT_KEY_5];
const yt = new YT(KEYS);

async function fetchDay(category, dateISO) {
  const qlist = QUERIES[category] || [category];
  let views = 0, n = 0, ids = [];
  for (const q of qlist.slice(0,2)) {
    const res = await yt.search({
      part: 'snippet',
      q,
      type: 'video',
      maxResults: MAX_RESULTS,
      publishedAfter: `${dateISO}T00:00:00Z`,
      publishedBefore:`${dateISO}T23:59:59Z`,
      relevanceLanguage: LANG,
      regionCode: REGION,
      order: 'viewCount',
      videoDuration: 'short'
    });
    ids.push(...(res.items||[]).map(i=>i.id && i.id.videoId).filter(Boolean));
  }
  ids = uniq(ids);
  for (let i=0;i<ids.length;i+=50) {
    const chunk = ids.slice(i,i+50);
    const v = await yt.videos({
      part: 'statistics',
      id: chunk.join(','),
      fields: 'items(statistics/viewCount)'
    });
    for (const it of (v.items||[])) {
      const s = it.statistics || {};
      views += Number(s.viewCount||0);
      n++;
    }
  }
  return { views, n };
}

async function main() {
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const existing = readJSON(OUTPUT) || { updatedAt: null, series: {} };
  for (const k of Object.keys(QUERIES)) existing.series[k] = existing.series[k] || [];

  const bootstrapDays = parseInt(process.env.BOOTSTRAP_DAYS||'0',10);
  let days = [];
  if (bootstrapDays > 0) {
    const start = plusDays(today, -bootstrapDays+1);
    for (let d=new Date(start); d<=today; d=plusDays(d,1)) days.push(dayStr(d));
  } else {
    days = [ dayStr(today) ];
  }

  for (const ds of days) {
    for (const cat of Object.keys(QUERIES)) {
      const arr = existing.series[cat];
      const idx = arr.findIndex(x=>x.d===ds);
      if (idx !== -1) arr.splice(idx,1);
      const r = await fetchDay(cat, ds);
      arr.push({ d: ds, views: r.views, n: r.n });
      arr.sort((a,b)=>a.d.localeCompare(b.d));
      if (arr.length > 180) existing.series[cat] = arr.slice(-180);
    }
  }
  existing.updatedAt = dayStr(today);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(existing, null, 2));
  console.log("Wrote", OUTPUT, "updatedAt", existing.updatedAt);
}

main().catch(e=>{ console.error(e); process.exit(1); });
