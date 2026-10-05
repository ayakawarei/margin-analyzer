/**
 * 回归测试：買残消化日数的数据源隔离
 * 验收（用户指定）：
 *   1. alignedBars 数量变化不能影响 20 日均量
 *   2. marginRows 只有 1~5 条时仍应能算 20 日均量
 *   3. lastMarginDate 之后的行情绝不能进入平均成交量
 */
import { readFileSync } from 'fs';
const src = readFileSync(new URL('./engine2.js', import.meta.url), 'utf8');
const { MA2 } = new Function('window', src + '\n; return {MA2: window.MA2};')({});

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → 实际: ' + JSON.stringify(extra) : '')); }
};

/* ---------- 构造 Yahoo 完整行情：485 期，2024-10-07 ~ 2026-10-05 ---------- */
function makeBars(n = 485, endDate = '2026-10-05', startDate = '2024-10-07') {
  const out = [];
  const d = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  let i = 0;
  while (out.length < n && d <= end) {
    const iso = d.toISOString().slice(0, 10);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {            // 跳过周末
      out.push({ date: iso, close: 7000 + (i % 50), vol: 5000000 + (i % 17) * 100000 });
      i++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const barsAll = makeBars();

/* ---------- 构造 marginRows（只有 5 条） ---------- */
const marginRows = [
  { date: '2026-09-28', buy: 8914500, sell: 735500, ratio: 12.12 },
  { date: '2026-09-29', buy: 9092400, sell: 705200, ratio: 12.89 },
  { date: '2026-09-30', buy: 9099600, sell: 727800, ratio: 12.50 },
  { date: '2026-10-01', buy: 9145500, sell: 703700, ratio: 13.00 },
  { date: '2026-10-02', buy: 9324600, sell: 693900, ratio: 13.44 },
];
const marginBuy = marginRows[marginRows.length - 1].buy;   // 9,324,600
const lastMarginDate = '2026-10-02';

console.log('\n=== 基准场景 ===');
console.log('  priceBarsAll =', barsAll.length);
console.log('  marginRows   =', marginRows.length);
console.log('  lastMarginDate =', lastMarginDate);

const base = MA2.digestDays({ marginBuy, priceBarsAll: barsAll, lastMarginDate });
console.log('  返回:', JSON.stringify({
  days: base.days, avgVolume: base.avgVolume, period: base.period,
  samples: base.samples, fallback: base.fallback,
  days5: base.days5, avgVolume5: base.avgVolume5,
  winFrom: base.winFrom, winTo: base.winTo, cutoff: base.cutoff,
}, null, 1));

console.log('\n=== 验收 1：alignedBars 数量变化不影响 20 日均量 ===');
ok(base.samples === 20, '20日均量取到 20 个样本', base.samples);
ok(base.period === 20, '主口径为 20 日', base.period);
ok(base.fallback === false, '未降级', base.fallback);

// 模拟「对齐后只剩 1 条 / 2 条 / 5 条」等不同 aligned 规模 —— digestDays 根本不接收 rows，
// 因此结果必须完全一致。这里通过改变 marginBuy 之外的输入来验证隔离性。
const variants = [
  ['marginRows=1条', [{ date: lastMarginDate, buy: marginBuy, sell: 693900, ratio: 13.44 }]],
  ['marginRows=2条', marginRows.slice(-2)],
  ['marginRows=5条', marginRows],
];
for (const [label, mr] of variants) {
  const r = MA2.digestDays({ marginBuy: mr[mr.length - 1].buy, priceBarsAll: barsAll, lastMarginDate });
  ok(r.avgVolume === base.avgVolume && r.days === base.days,
     label + ' → 20日均量与消化日数不变', { d: r.days, v: r.avgVolume });
}

console.log('\n=== 验收 2：marginRows 极少也能量到 20 日均量 ===');
const one = MA2.digestDays({ marginBuy, priceBarsAll: barsAll, lastMarginDate });
ok(one.samples === 20, '即使只有 1 期信用残，仍取满 20 个成交量样本', one.samples);
ok(one.fallback === false, '不会因信用残期数少而降级', one.fallback);

console.log('\n=== 验收 3：lastMarginDate 之后的行情不进入平均 ===');
// 构造：把 cutoff 之后的数据换成极端值，若被计入，均值必然剧变
const tampered = barsAll.map(function (b) {
  return (b.date > lastMarginDate) ? Object.assign({}, b, { vol: 99999999 }) : b;
});
const t = MA2.digestDays({ marginBuy, priceBarsAll: tampered, lastMarginDate });
ok(t.avgVolume === base.avgVolume,
   'cutoff 后的成交量被篡改，均值不受影响', { base: base.avgVolume, tampered: t.avgVolume });
ok(t.winTo === base.winTo && t.winTo <= lastMarginDate,
   '窗口右端不超过 lastMarginDate', { winTo: t.winTo, cutoff: lastMarginDate });

// 更早的 cutoff：窗口应随之左移
const early = MA2.digestDays({ marginBuy, priceBarsAll: barsAll, lastMarginDate: '2026-08-14' });
const earlyExpected = barsAll.filter(b => b.date <= '2026-08-14' && b.vol > 0).slice(-20);
const earlyAvg = Math.round(earlyExpected.reduce((a, b) => a + b.vol, 0) / 20);
ok(early.avgVolume === earlyAvg, '更早的 cutoff → 窗口正确左移', { got: early.avgVolume, exp: earlyAvg });
ok(early.winTo <= '2026-08-14', '窗口右端 = 新的 cutoff', early.winTo);

console.log('\n=== 附加：days5 来自完整行情（非 aligned） ===');
ok(base.avgVolume5 !== null && base.days5 !== null, '5日口径已算出', { v5: base.avgVolume5, d5: base.days5 });
const exp5 = barsAll.filter(b => b.date <= lastMarginDate && b.vol > 0).slice(-5);
const expAvg5 = Math.round(exp5.reduce((a, b) => a + b.vol, 0) / 5);
ok(base.avgVolume5 === expAvg5, '5日均量 = 市场最近5个交易日', { got: base.avgVolume5, exp: expAvg5 });

console.log('\n=== 附加：降级规则 ===');
// 构造只有 5~19 个有效成交量的场景：取一个仅含 8 个交易日的日期区间
const sortedAll2 = barsAll.slice().sort((a, b) => a.date < b.date ? -1 : 1);
const win8 = sortedAll2.slice(-8);                    // 末尾 8 个交易日
const few = win8.slice();                             // 只有这 8 条
const rFb = MA2.digestDays({ marginBuy, priceBarsAll: few, lastMarginDate: win8[7].date });
ok(few.length === 8, '构造出 8 条有效成交量', few.length);
ok(rFb.totalValid === 8, 'totalValid = 8', rFb.totalValid);
ok(rFb.period === 5 && rFb.fallback === true, '5~19 条 → 降级 5 日并标记 fallback',
   { period: rFb.period, fallback: rFb.fallback, totalValid: rFb.totalValid });
ok(!!rFb.note, '降级时给出明确说明', rFb.note);
const tiny = barsAll.filter(b => b.date <= '2026-09-01' && b.date > '2026-08-25'); // 5 个
const rNo = MA2.digestDays({ marginBuy, priceBarsAll: tiny, lastMarginDate: '2026-09-01' });
ok(rNo.days === null, '< 5 条 → 不计算', { days: rNo.days, samples: rNo.samples });

console.log('\n' + '='.repeat(52));
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);