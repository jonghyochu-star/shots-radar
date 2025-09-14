// scripts/manual-import.js  (ESM / Node>=20)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// 입력/출력 경로
const IN_CSV  = process.env.MANUAL_CSV_PATH  || path.join(__dirname,'..','public','ch-manual.csv');
const OUT_JSON= process.env.MANUAL_JSON_PATH || path.join(__dirname,'..','public','ch-manual.json');

// 허용 규칙키
const allowed = new Set(['ai','game','community','review','politics','entertainment','senior','official','sports']);

// 간단한 CSV 파서(따옴표/콤마 처리, BOM 허용)
function parseCSV(text){
  // BOM 제거
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let cur = [], field = '', inQ = false;
  for (let i=0;i<text.length;i++){
    const ch = text[i];
    if (inQ){
      if (ch === '"'){
        if (text[i+1] === '"'){ field += '"'; i++; } else { inQ = false; }
      } else field += ch;
    } else {
      if (ch === '"'){ inQ = true; }
      else if (ch === ','){ cur.push(field); field=''; }
      else if (ch === '\n'){ cur.push(field); rows.push(cur); cur=[]; field=''; }
      else if (ch === '\r'){ /* ignore */ }
      else field += ch;
    }
  }
  if (field!=='' || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

function toRules(s){
  if (!s) return [];
  const parts = String(s).split(/[|,]/).map(t=>t.trim().toLowerCase()).filter(Boolean);
  const uniq = [...new Set(parts)].filter(k => allowed.has(k));
  return uniq;
}

function main(){
  if (!fs.existsSync(IN_CSV)) {
    console.error(`Input CSV not found: ${IN_CSV}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(IN_CSV, 'utf8');
  const rows = parseCSV(raw);
  if (rows.length === 0) {
    console.error('Empty CSV.');
    process.exit(1);
  }
  const header = rows[0].map(h=>h.trim());
  const idxId   = header.findIndex(h => /^channelid$/i.test(h));
  const idxRules= header.findIndex(h => /^rules?$/i.test(h));
  const idxNote = header.findIndex(h => /^note$/i.test(h));
  if (idxId < 0 || idxRules < 0) {
    console.error('CSV header must include "channelId" and "rules". Optional "note".');
    process.exit(1);
  }

  const out = {};
  let used = 0, skipped = 0;
  for (let r=1;r<rows.length;r++){
    const row = rows[r];
    const id = (row[idxId]||'').trim();
    const rules = toRules(row[idxRules]);
    const note  = idxNote>=0 ? (row[idxNote]||'').trim() : '';
    if (!id || rules.length===0) { skipped++; continue; }
    out[id] = { rules, ...(note?{note}:{}) };
    used++;
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive:true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(out,null,2), 'utf8');
  console.log(JSON.stringify({event:'manual-import', used, skipped, out: OUT_JSON}, null, 2));
}
main();
