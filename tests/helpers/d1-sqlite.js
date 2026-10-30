// テスト用：Cloudflare D1 の使い方（prepare → bind → run / first / all）を、Node の SQLite（node:sqlite）でまねる。
// 本物の D1 との違い（同時実行・レプリカ・BLOBの返し方）はここでは確かめられない。
const fs = require('fs');
const path = require('path');
process.removeAllListeners('warning'); // node:sqlite の「実験的機能」の警告を出さない
const { DatabaseSync } = require('node:sqlite');

function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'worker', 'schema.sql'), 'utf8'));
  const state = { fail: false, writes: 0 };
  const conv = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
  return {
    state,
    raw: db,
    prepare(sql) {
      if (state.fail) throw new Error('D1_ERROR: simulated failure');
      const st = db.prepare(sql);
      let args = [];
      const o = {
        bind(...a) { args = a.map(conv); return o; },
        async first(col) { const r = st.get(...args); if (!r) return null; return col ? r[col] : r; },
        async run() { const r = st.run(...args); state.writes += Number(r.changes); return { success: true, meta: { changes: Number(r.changes) } }; },
        async all() { return { success: true, results: st.all(...args) }; },
      };
      return o;
    },
  };
}
module.exports = { makeD1 };
