
import fetch from 'node-fetch';

const COST = { search: 100, videos: 1 };

export class YT {
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
