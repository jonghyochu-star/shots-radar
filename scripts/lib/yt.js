// scripts/lib/yt.js
// Node 20 전역 fetch 사용 (node-fetch 불필요)
// 키 로테이션: 라운드로빈 + quotaExceeded 시 즉시 다음 키로 교체

function mask(k) { return k ? `${k.slice(0,4)}…${k.slice(-4)}` : ''; }

export class YT {
  constructor(keys) {
    this.keys = (keys || []).filter(Boolean);
    if (this.keys.length === 0) throw new Error('No API keys provided');
    this.blocked = new Set();  // 오늘 소진된 키
    this.idx = 0;              // 라운드로빈 포인터
  }

  nextKey() {
    const n = this.keys.length;
    for (let step = 0; step < n; step++) {
      const k = this.keys[(this.idx + step) % n];
      if (!this.blocked.has(k)) {
        this.idx = (this.idx + step + 1) % n; // 다음 시작점 갱신
        return k;
      }
    }
    return null; // 모두 막힘
  }

  async call(endpoint, params) {
    let lastErr;
    while (true) {
      const key = this.nextKey();
      if (!key) break; // 전부 막힘

      const url = `https://www.googleapis.com/youtube/v3/${endpoint}?key=${key}&${new URLSearchParams(params)}`;
      const r = await fetch(url);

      if (r.ok) return r.json();

      const body = await r.text();
      if (body.includes('quotaExceeded')) {
        this.blocked.add(key);
        console.warn(`[quota] 키 소진 → 교체: ${mask(key)}`);
        continue; // 다음 키로
      }
      if ([429, 500, 503].includes(r.status)) {
        console.warn(`[retry] ${endpoint} ${r.status} (${mask(key)}) → 다음 키`);
        continue; // 다음 키로 재시도
      }
      lastErr = new Error(`${r.status} ${body}`);
      break;
    }
    throw lastErr || new Error('quotaExceeded');
  }

  search(params) { return this.call('search', params); }
  videos(params) { return this.call('videos', params); }
}
