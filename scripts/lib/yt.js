// scripts/lib/yt.js
// Node 20 전역 fetch 사용 (node-fetch 불필요)
// 키 로테이션: 라운드로빈 + quotaExceeded 시 즉시 다음 키로 교체
// 통계(getStats) 노출: 프론트에서 kw-status.json으로 가시화

function mask(k) { return k ? `${k.slice(0,4)}…${k.slice(-4)}` : ''; }

export class YT {
  constructor(keys) {
    this.keys = (keys || []).filter(Boolean);
    if (this.keys.length === 0) throw new Error('No API keys provided');

    this.blocked = new Set();
    this.idx = 0;

    // 프론트 노출용 통계
    this.stats = this.keys.map(k => ({
      mask: mask(k),
      blocked: false,
      calls: { search: 0, videos: 0 },
      lastUsed: null,
    }));
  }

  nextKey() {
    const n = this.keys.length;
    for (let step = 0; step < n; step++) {
      const k = this.keys[(this.idx + step) % n];
      if (!this.blocked.has(k)) {
        this.idx = (this.idx + step + 1) % n; // 다음 시작점
        return k;
      }
    }
    return null; // 모두 막힘
  }

  async call(endpoint, params) {
    let lastErr;
    while (true) {
      const key = this.nextKey();
      if (!key) break;

      const url = `https://www.googleapis.com/youtube/v3/${endpoint}?key=${key}&${new URLSearchParams(params)}`;
      const r = await fetch(url);

      if (r.ok) {
        const i = this.keys.indexOf(key);
        if (i > -1) {
          this.stats[i].calls[endpoint] = (this.stats[i].calls[endpoint] || 0) + 1;
          this.stats[i].lastUsed = new Date().toISOString();
        }
        return r.json();
      }

      const body = await r.text();

      if (body.includes('quotaExceeded')) {
        this.blocked.add(key);
        const i = this.keys.indexOf(key);
        if (i > -1) this.stats[i].blocked = true;
        console.warn(`[quota] 키 소진 → 교체: ${this.stats[i]?.mask || mask(key)}`);
        continue; // 다음 키
      }

      if ([429, 500, 503].includes(r.status)) {
        console.warn(`[retry] ${endpoint} ${r.status} → 다음 키`);
        continue;
      }

      lastErr = new Error(`${r.status} ${body}`);
      break;
    }
    throw lastErr || new Error('quotaExceeded');
  }

  search(p) { return this.call('search', p); }
  videos(p) { return this.call('videos', p); }

  getStats() {
    return {
      keys: this.stats,
      total: this.stats.length,
      blocked: this.stats.filter(k => k.blocked).length,
    };
  }
}
