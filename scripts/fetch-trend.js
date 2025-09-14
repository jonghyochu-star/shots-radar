// scripts/fetch-trend.js
// ESM / Node >= 20

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { httpGet, writeKeyStatus } from './key-rotator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// -------------------- 수집/보관 기본 --------------------
const RESULT_PAGES_PER_RUN = Number(process.env.RESULT_PAGES_PER_RUN || 2);
const RESULTS_PER_PAGE     = 50;
const LOOKBACK_DAYS_SEARCH = Number(process.env.LOOKBACK_DAYS_SEARCH || 14);
const MAX_DAYS_KEEP        = Number(process.env.MAX_DAYS_KEEP || 180);

// -------------------- Prior 파라미터 --------------------
const PRIOR_ALPHA      = Number(process.env.PRIOR_ALPHA || 20);
const PRIOR_MIN_BOOST  = Number(process.env.PRIOR_MIN_BOOST || 0.6);
const PRIOR_MAX_BOOST  = Number(process.env.PRIOR_MAX_BOOST || 1.4);
const PRIOR_STRONG_THR = Number(process.env.PRIOR_STRONG_THR || 0.70);

// -------------------- 디버그 --------------------
const SR_DEBUG = process.env.SR_DEBUG === '1';

// -------------------- 파일 경로 --------------------
const TARGET_TREND_FILE  = path.join(__dirname, '..', 'public', 'kw-trend.json');
const RULES_PATH         = process.env.SCORING_RULES_PATH || path.join(__dirname, '..', 'public', 'category-rules.json');
const CH_PRIOR_PATH      = process.env.CH_PRIOR_PATH || path.join(__dirname, '..', 'public', 'ch-prior.json');
const DEBUG_OUT_PATH     = path.join(__dirname, '..', 'public', 'kw-debug.json');

const CH_REVIEW_JSON_PATH = path.join(__dirname,'..','public','ch-review.json');
const CH_REVIEW_CSV_PATH  = path.join(__dirname,'..','public','ch-review.csv');
const CH_REVIEW_XLSX_PATH = path.join(__dirname,'..','public','ch-review.xlsx');

// -------------------- 한국 타겟팅 --------------------
const REGION_FILTER = process.env.REGION_FILTER || 'KR';
const LANG_PREF = process.env.LANG_PREF || 'ko';
const LANG_STRICT = process.env.LANG_STRICT === '1';
const LANG_MIN_HANGUL_RATIO = Number(process.env.LANG_MIN_HANGUL_RATIO || '0.15');

const CHANNEL_GEO_STRICT = process.env.CHANNEL_GEO_STRICT === '1';
const CH_GEO_CACHE_PATH = process.env.CH_GEO_CACHE_PATH
  || path.join(__dirname, '..', 'public', 'ch-geo.json');

// -------------------- 수동 라벨링 --------------------
const CH_MANUAL_PATH     = process.env.CH_MANUAL_PATH || path.join(__dirname, '..', 'public', 'ch-manual.json');
const CH_MANUAL_CSV_PATH = process.env.CH_MANUAL_CSV_PATH || path.join(__dirname, '..', 'public', 'ch-manual.csv');
const MANUAL_FROM_REVIEW_CSV  = process.env.MANUAL_FROM_REVIEW_CSV === '1'; // ch-review.csv/.xlsx의 rules 읽기
const MANUAL_MODE        = process.env.MANUAL_MODE || 'soft';              // 'soft' | 'hard'
const MANUAL_POS_BOOST   = Number(process.env.MANUAL_POS_BOOST || '1.6');
const MANUAL_NEG_BOOST   = Number(process.env.MANUAL_NEG_BOOST || '0.8');

// -------------------- 리뷰 파일 생성 --------------------
const SR_CH_REVIEW = process.env.SR_CH_REVIEW === '1';

// -------------------- 라벨/규칙 --------------------
const CATEGORIES = ['AI','게임','커뮤니티','리뷰','정치','연예','시니어','오피셜','스포츠'];
const RULE2LABEL = {
  ai: 'AI', game: '게임', community: '커뮤니티', review: '리뷰', politics: '정치',
  entertainment: '연예', senior: '시니어', official: '오피셜', sports: '스포츠',
};
const ALLOWED_RULES = new Set(Object.keys(RULE2LABEL));
const UNASSIGNED_SET = new Set(['unassigned','none','미지정','미분류','-']);

// -------------------- 유틸 --------------------
function readJsonSafe(p, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8') || '{}'); }
  catch { return fallback; }
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

const stripPunctRe = /[^\p{L}\p{N}\s]/gu;
function norm(s=''){ return String(s).toLowerCase().replace(stripPunctRe,' ').replace(/\s+/g,' ').trim(); }
function countHits(text, tokens){ if(!tokens?.length) return 0; let h=0; for(const t of tokens){const tok=norm(t); if(tok && text.includes(tok)) h++;} return h; }
function fieldScore(text, includeTokens){ if(!includeTokens?.length) return 0; const hits=countHits(text,includeTokens); if(hits<=0) return 0; if(hits===1) return 0.5; return 1.0; }
function contentScoreByFields({title,tags,description,channelTitle},includeTokens){
  const t=norm(title), tg=norm((tags||[]).join(' ')), d=norm(description), ch=norm(channelTitle);
  const sTitle=fieldScore(t,includeTokens), sTags=fieldScore(tg,includeTokens);
  const sDesc =fieldScore(d,includeTokens), sCh  =fieldScore(ch,includeTokens);
  const fw = RULES?.global?.field_weights || { title:0.45,tags:0.25,description:0.15,channel:0.15 };
  return fw.title*sTitle + fw.tags*sTags + fw.description*sDesc + fw.channel*sCh;
}
function hasNegative({title,tags,description,channelTitle},excludeTokens){
  if(!excludeTokens?.length) return false;
  const t=norm(title), tg=norm((tags||[]).join(' ')), d=norm(description), ch=norm(channelTitle);
  return (countHits(t,excludeTokens)+countHits(tg,excludeTokens)+countHits(d,excludeTokens)+countHits(ch,excludeTokens))>0;
}

const HANGUL_RE=/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/g;
function hangulRatio(s){ if(!s) return 0; const m=String(s).match(HANGUL_RE); return (m?m.length:0)/String(s).length; }
function isKoreanSnippet(snippet,tags=[]){
  const texts=[snippet?.title,snippet?.description, ...(Array.isArray(tags)?tags:[])].filter(Boolean).join(' ');
  const ratio=hangulRatio(texts);
  const hints=[snippet?.defaultLanguage,snippet?.defaultAudioLanguage,snippet?.localized?.language]
    .filter(Boolean).map(x=>String(x).toLowerCase());
  const hintKo=hints.some(x=>x.startsWith('ko'));
  return hintKo || ratio >= LANG_MIN_HANGUL_RATIO;
}

// -------------------- CSV/XLSX 로더 & 드롭다운 --------------------
function parseCSV(text){
  if (text && text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
  const rows=[]; let cur=[], field='', inQ=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(inQ){
      if(ch=== '"'){ if(text[i+1]=== '"'){ field+='"'; i++; } else inQ=false; }
      else field+=ch;
    }else{
      if(ch=== '"') inQ=true;
      else if(ch=== ','){ cur.push(field); field=''; }
      else if(ch=== '\n'){ cur.push(field); rows.push(cur); cur=[]; field=''; }
      else if(ch=== '\r'){ /* ignore */ }
      else field+=ch;
    }
  }
  if(field!=='' || cur.length){ cur.push(field); rows.push(cur); }
  return rows;
}
function splitRules(s){
  if(!s) return [];
  const raw = String(s).trim();
  if (UNASSIGNED_SET.has(raw.toLowerCase())) return [];
  const arr=raw.split(/[|,]/).map(t=>t.trim().toLowerCase()).filter(Boolean);
  return [...new Set(arr)].filter(k=>ALLOWED_RULES.has(k));
}
function loadManualFromCSV(csvPath){
  if(!fs.existsSync(csvPath)) return {};
  const rows=parseCSV(fs.readFileSync(csvPath,'utf8'));
  if(!rows.length) return {};
  const header=rows[0].map(h=>String(h||'').trim().toLowerCase());
  const idxId=header.indexOf('channelid');
  const idxRules=header.indexOf('rules');
  const idxNote=header.indexOf('note');
  if(idxId<0 || idxRules<0) return {};
  const out={};
  for(let r=1;r<rows.length;r++){
    const id=String(rows[r][idxId]||'').trim();
    const rules=splitRules(rows[r][idxRules]);
    const note = idxNote>=0 ? String(rows[r][idxNote]||'').trim() : '';
    if(!id || rules.length===0) continue;
    out[id]={ rules, ...(note?{note}:{}) };
  }
  return out;
}

// XLSX 읽기 (있으면 CSV보다 우선)
async function loadManualFromXLSX(xlsxPath){
  try{
    if(!fs.existsSync(xlsxPath)) return {};
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsxPath);
    const ws = wb.getWorksheet('review') || wb.worksheets[0];
    if(!ws) return {};
    const headerRow = ws.getRow(1);
    const headers = headerRow.values.map(v=>String(v||'').trim().toLowerCase());
    const idxId    = headers.findIndex(h=>h==='channelid');
    const idxRules = headers.findIndex(h=>h==='rules');
    const idxNote  = headers.findIndex(h=>h==='note');
    if(idxId<0 || idxRules<0) return {};
    const out={};
    for(let r=2; r<=ws.rowCount; r++){
      const row = ws.getRow(r).values;
      const id   = String(row[idxId] || '').trim();
      const rules= splitRules(row[idxRules] || '');
      const note = idxNote>0 ? String(row[idxNote] || '').trim() : '';
      if(!id || rules.length===0) continue;
      out[id] = { rules, ...(note?{note}:{}) };
    }
    return out;
  }catch(e){
    console.warn('[manual:xlsx] skip:', e?.message||e);
    return {};
  }
}

// XLSX 생성 (rules 드롭다운)
async function writeReviewXLSX(rows){
  try{
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('review', {properties:{tabColor:{argb:'FFDDEEFF'}}});

    const headers = [
      'channelId','channelUrl','channelTitle','country','videos','views','suggest','examples','rules','note'
    ];
    ws.addRow(headers);

    for (const r of rows){
      const url = `https://www.youtube.com/channel/${r.channelId}`;
      const row = ws.addRow([
        r.channelId, url, r.channelTitle, r.country || '', r.videos, Math.round(r.views),
        Object.entries(r.suggest).map(([k,n])=>`${k}:${n}`).join('|'),
        (r.examples||[]).join(' / '), '', ''
      ]);
      // 하이퍼링크
      ws.getCell(`B${row.number}`).value = { text: url, hyperlink: url };
    }

    ws.columns = [
      { key:'channelId', width:28 }, { key:'channelUrl', width:36 },
      { key:'channelTitle', width:28 }, { key:'country', width:8 },
      { key:'videos', width:8 }, { key:'views', width:12 },
      { key:'suggest', width:22 }, { key:'examples', width:60 },
      { key:'rules', width:16 }, { key:'note', width:24 }
    ];

    // 드롭다운 목록용 숨김 시트
    const ref = wb.addWorksheet('ref');
    const allowedList = [
      'ai','game','community','review','politics','entertainment','senior','official','sports','unassigned'
    ];
    allowedList.forEach((v,i)=> ref.getCell(`A${i+1}`).value = v);
    ref.state = 'veryHidden';

    // rules 열 데이터 검증
    const lastRow = ws.rowCount;
    const dvRange = `I2:I${lastRow}`; // I: rules
    ws.dataValidations.add(dvRange, {
      type:'list', allowBlank:true, showErrorMessage:true, errorStyle:'stop',
      formulae: ['ref!$A$1:$A$10']
    });

    await wb.xlsx.writeFile(CH_REVIEW_XLSX_PATH);
  }catch(e){
    console.warn('[xlsx] workbook not written (exceljs missing?):', e?.message||e);
  }
}

// -------------------- 규칙/priors/지오 캐시 --------------------
const RULES = readJsonSafe(RULES_PATH, {});
const RULE_KEYS = RULES?.categories ? Object.keys(RULES.categories) : [];
const P0 = RULE_KEYS.length ? 1/RULE_KEYS.length : 0.1;

const CHPR  = readJsonSafe(CH_PRIOR_PATH, {});
const CH_GEO = readJsonSafe(CH_GEO_CACHE_PATH, {});

// 수동 라벨: JSON + manual.csv
let CH_MAN = readJsonSafe(CH_MANUAL_PATH, {});
const CH_MAN_CSV = loadManualFromCSV(CH_MANUAL_CSV_PATH);
CH_MAN = { ...CH_MAN, ...CH_MAN_CSV };

// -------------------- YouTube API --------------------
function qs(obj){ return Object.entries(obj).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }

async function ytSearch(q, pageToken=''){
  const params={
    part:'snippet', type:'video', maxResults:String(RESULTS_PER_PAGE), q,
    order:'date',
    publishedAfter: new Date(Date.now()-LOOKBACK_DAYS_SEARCH*86400e3).toISOString(),
    regionCode: REGION_FILTER, relevanceLanguage: LANG_PREF,
  };
  if (pageToken) params.pageToken=pageToken;
  const url=`https://www.googleapis.com/youtube/v3/search?${qs(params)}`;
  return httpGet(url);
}

async function ytVideos(videoIds=[]){
  if (!videoIds.length) return { items: [] };
  const url=`https://www.googleapis.com/youtube/v3/videos?${qs({part:'statistics,snippet,contentDetails', id: videoIds.join(',')})}`;
  return httpGet(url);
}

async function fetchChannelsCountry(chIds=[]){
  if(!chIds.length) return {};
  const out={};
  for(let i=0;i<chIds.length;i+=50){
    const ids=chIds.slice(i,i+50).join(',');
    const url=`https://www.googleapis.com/youtube/v3/channels?${qs({part:'snippet', id: ids, maxResults:50})}`;
    const res=await httpGet(url);
    for(const c of res.items ?? []) out[c.id]=c?.snippet?.country || null;
  }
  return out;
}

// -------------------- Prior (수동 라벨 반영) --------------------
function priorOf(channelId, ruleKey){
  const rec=CHPR[channelId] || {};
  const hits=Number(rec[ruleKey] || 0);
  const tot =Number(rec._total || 0);
  const prior=(hits + PRIOR_ALPHA*P0) / (tot + PRIOR_ALPHA);
  let boost=prior / P0;
  if(!Number.isFinite(boost) || boost<=0) boost=1.0;
  boost=Math.max(PRIOR_MIN_BOOST, Math.min(PRIOR_MAX_BOOST, boost));

  const man=CH_MAN[channelId];
  if(man?.rules?.length){
    const hit = man.rules.includes(ruleKey);
    if (MANUAL_MODE === 'hard'){
      boost = hit ? MANUAL_POS_BOOST : MANUAL_NEG_BOOST;
    } else {
      if (hit) boost = Math.max(boost, MANUAL_POS_BOOST);
      else     boost = Math.min(boost, MANUAL_NEG_BOOST);
    }
  }
  return boost;
}
function updatePrior(channelId, topRuleKey){
  if(!channelId || !topRuleKey) return;
  const rec=CHPR[channelId] || {};
  rec[topRuleKey]=Number(rec[topRuleKey]||0)+1;
  rec._total=Number(rec._total||0)+1;
  rec._updatedAt=new Date().toISOString();
  CHPR[channelId]=rec;
}

// -------------------- 스코어링 --------------------
function scoreVideoAllCats(v){
  const sn=v.snippet || {};
  const fields={
    title: sn.title || '',
    tags: sn.tags || [],
    description: sn.description || '',
    channelTitle: sn.channelTitle || ''
  };
  const channelId = sn.channelId || '';
  const cats = RULES?.categories ? Object.keys(RULES.categories) : [];

  const content={}, boosted={}; let sum=0;

  for(const key of cats){
    const cat=RULES.categories[key];
    const include=cat.include_tokens || [];
    const exclude=cat.exclude_tokens || [];
    let s = contentScoreByFields(fields, include);
    if (hasNegative(fields, exclude)) s *= 0.4;
    content[key]=s;
  }
  for(const key of cats){
    const s=content[key] || 0;
    if (s<=0){ boosted[key]=0; continue; }
    const b=priorOf(channelId,key);
    const sb=s*b; boosted[key]=sb; sum+=sb;
  }
  if (sum<=0) return { weights:{}, content, boosted };

  const weights={}; for(const key of cats) weights[key]=boosted[key]/sum;

  const top = Object.entries(content).sort((a,b)=>b[1]-a[1])[0] || [null,0];
  if (top[0] && top[1] >= PRIOR_STRONG_THR) updatePrior(channelId, top[0]);

  return { weights, content, boosted };
}

function initDailySums(){
  const res={};
  const keys=RULES?.categories ? Object.keys(RULES.categories) : [];
  if(keys.length){
    for(const k of keys){ const label=RULE2LABEL[k]||k; res[label]={views:0,n:0}; }
  }else{
    for(const label of CATEGORIES) res[label]={views:0,n:0};
  }
  return res;
}

// -------------------- 메인 --------------------
async function main(){
  // XLSX에서 수동 라벨 읽기(있으면 최우선)
  if (MANUAL_FROM_REVIEW_CSV && fs.existsSync(CH_REVIEW_XLSX_PATH)) {
    const map = await loadManualFromXLSX(CH_REVIEW_XLSX_PATH);
    CH_MAN = { ...CH_MAN, ...map };
  }
  // CSV도 지원 (엑셀에서 csv로 저장 덮어쓰기 한 경우)
  if (MANUAL_FROM_REVIEW_CSV && fs.existsSync(CH_REVIEW_CSV_PATH)) {
    const map = loadManualFromCSV(CH_REVIEW_CSV_PATH);
    CH_MAN = { ...CH_MAN, ...map };
  }

  // 이전 시계열 로드
  let oldSeries={};
  try {
    const raw=fs.readFileSync(TARGET_TREND_FILE,'utf8');
    oldSeries=(JSON.parse(raw||'{}').series)||{};
  } catch {}

  const dailySums=initDailySums();
  const processed=new Set();
  const debugRows=[];
  const reviewMap={}; // SR_CH_REVIEW

  let kept=0, dropLang=0, dropGeo=0;

  for(const q of CATEGORIES){
    let pageToken=''; let ids=[];

    for(let p=0;p<RESULT_PAGES_PER_RUN;p++){
      const js=await ytSearch(q, pageToken);
      const items=js?.items || [];
      ids.push(...items.map(it=>it?.id?.videoId).filter(Boolean));
      pageToken=js?.nextPageToken || '';
      if(!pageToken) break;
    }

    for(let i=0;i<ids.length;i+=50){
      const vjs=await ytVideos(ids.slice(i,i+50));
      const details=vjs?.items || [];

      const needIds=[...new Set(details.map(v=>v?.snippet?.channelId))]
        .filter(id => id && CH_GEO[id] === undefined);
      if (needIds.length){
        const fetched=await fetchChannelsCountry(needIds);
        Object.assign(CH_GEO, fetched);
        writeJsonPretty(CH_GEO_CACHE_PATH, CH_GEO);
      }

      for(const v of details){
        const vid=v.id; if(!vid || processed.has(vid)) continue; processed.add(vid);
        const sn=v.snippet || {}; const stats=v.statistics || {};
        const tags=sn.tags || [];

        if (LANG_STRICT && !isKoreanSnippet(sn, tags)){ dropLang++; continue; }

        const chCountry = CH_GEO[sn.channelId] || null;
        if (CHANNEL_GEO_STRICT && chCountry && chCountry !== 'KR'){ dropGeo++; continue; }

        const vc=Number(stats.viewCount||0); if(!isFinite(vc) || vc<=0) continue;

        const {weights,content,boosted}=scoreVideoAllCats(v);
        const keys=Object.keys(weights); if(!keys.length) continue;

        for(const rk of keys){
          const w=weights[rk]; const label=RULE2LABEL[rk]||rk;
          if(!dailySums[label]) dailySums[label]={views:0,n:0};
          dailySums[label].views += vc * w;
          dailySums[label].n     += w;
        }
        kept++;

        if (SR_CH_REVIEW){
          const chId=sn.channelId;
          const topKey=Object.entries(weights).sort((a,b)=>b[1]-a[1])[0]?.[0];
          const r=reviewMap[chId] || (reviewMap[chId]={
            channelId: chId,
            channelTitle: sn.channelTitle || '',
            country: chCountry || null,
            videos: 0, views: 0, suggest:{}, examples:[]
          });
          r.videos += 1; r.views += vc;
          if(topKey) r.suggest[topKey]=(r.suggest[topKey]||0)+1;
          if(r.examples.length<3) r.examples.push((sn.title||'').slice(0,80));
        }

        if (SR_DEBUG && debugRows.length<120){
          const top=Object.entries(weights).sort((a,b)=>b[1]-a[1]).slice(0,3)
            .map(([k,v])=>({rule:k,label:RULE2LABEL[k]||k,w:Number(v.toFixed(3)),content:Number((content[k]||0).toFixed(3)),boosted:Number((boosted[k]||0).toFixed(3))}));
          debugRows.push({ videoId:vid, channelId:sn.channelId, title:(sn.title||'').slice(0,120), viewCount:vc, top });
        }
      }
    }
  }

  // 시계열 병합
  function mergeSeries(oldSeries, appended){
    const out={...oldSeries};
    for(const [label,rec] of Object.entries(appended)){
      const list=Array.isArray(out[label]) ? out[label].slice() : [];
      const idx=list.findIndex(x=>x.d===rec.d);
      if(idx>=0) list[idx]=rec; else list.push(rec);
      list.sort((a,b)=>(a.d<b.d?-1:1));
      while(list.length>MAX_DAYS_KEEP) list.shift();
      out[label]=list;
    }
    return out;
  }
  const appended={};
  for(const label of CATEGORIES){
    const cur=dailySums[label] || {views:0,n:0};
    appended[label]={ d: todayYmd(), views: Math.round(cur.views), n: Math.round(cur.n) };
  }
  const merged=mergeSeries(oldSeries, appended);
  const out={ updatedAt:new Date().toISOString(), meta:{ scoring: RULE_KEYS.length? 'rules+prior-v1' : 'classic' }, series: merged };
  writeJsonPretty(TARGET_TREND_FILE, out);

  // 보조 산출물
  writeJsonPretty(CH_PRIOR_PATH, CHPR);
  writeJsonPretty(CH_GEO_CACHE_PATH, CH_GEO);
  if (SR_DEBUG) writeJsonPretty(DEBUG_OUT_PATH, { ymd: todayYmd(), sample: debugRows });

  // 리뷰 파일
  if (SR_CH_REVIEW){
    const rows=Object.values({}).concat(Object.values(
      // reviewMap은 채널별로 이미 aggregate
      reviewMap
    )).sort((a,b)=>b.views-a.views);

    writeJsonPretty(CH_REVIEW_JSON_PATH, { updatedAt:new Date().toISOString(), rows });

    // CSV (rules/note 컬럼 포함)
    const header='channelId,channelUrl,channelTitle,country,videos,views,suggest,examples,rules,note\n';
    const esc=s=>`"${String(s||'').replace(/"/g,'""')}"`;
    const csv = header + rows.map(r=>{
      const url=`https://www.youtube.com/channel/${r.channelId}`;
      return [
        r.channelId,
        url,
        esc(r.channelTitle),
        r.country||'',
        r.videos,
        Math.round(r.views),
        esc(Object.entries(r.suggest).map(([k,n])=>`${k}:${n}`).join('|')),
        esc((r.examples||[]).join(' / ')),
        '', '' // rules, note (사용자 입력용)
      ].join(',');
    }).join('\n');
    fs.writeFileSync(CH_REVIEW_CSV_PATH, '\ufeff' + csv, 'utf8'); // BOM for Excel

    // XLSX (드롭다운 포함)
    await writeReviewXLSX(rows);
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
