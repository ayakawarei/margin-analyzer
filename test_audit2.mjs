import fs from 'fs';
const src = fs.readFileSync(new URL('./engine2.js', import.meta.url), 'utf8');
const { MA2 } = new Function('window', src + '\n; return {MA2: window.MA2};')({});

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};

function makeBars(avgVol, lastDate, n = 30, closeBase = 100) {
  const bars = [];
  const d0 = new Date('2026-09-01');
  for (let i = 0; i < n; i++) {
    const d = new Date(d0.getTime() + i * 864e5);
    const ds = d.toISOString().slice(0, 10);
    if (ds > lastDate) break;
    bars.push({ date: ds, close: closeBase + i, adjClose: closeBase + i, vol: avgVol });
  }
  return bars;
}

console.log('=== 问题1：股票分割/分红 对四象限的污染 ===');
// 场景：5 期窗口内，第 3 期发生 1:4 分割。raw close 跳变，adjClose 平滑。
{
  // raw close（未复权，分割日 8000→2000 假跳变）
  const rawRows = [
    { date: '2026-09-28', buy: 1000000, sell: 500000, ratio: 2, close: 8000 },
    { date: '2026-09-29', buy: 1000000, sell: 500000, ratio: 2, close: 8100 },
    { date: '2026-09-30', buy: 4000000, sell: 500000, ratio: 8, close: 2000 },  // 分割日
    { date: '2026-10-01', buy: 4000000, sell: 500000, ratio: 8, close: 2100 },
    { date: '2026-10-02', buy: 4000000, sell: 500000, ratio: 8, close: 2050 },
  ];
  const indRaw = MA2.computeIndicators(rawRows, { shares: 100000000 }, { priceBarsAll: [], lastMarginDate: '2026-10-02' });
  // raw close 首尾 = (2050-8000)/8000 = -74.4%，会误判"股价暴跌"
  ok(indRaw.quadrant.priceChg < -50, '分割复现：raw close 首尾 priceChg 假跳变 -74%', indRaw.quadrant.priceChg);
  ok(indRaw.quadrant.key === 'accumulateDown', '分割污染：raw 价误判「下落中买残增加」', indRaw.quadrant.key);

  // adjClose（复权价，分割日平滑）
  const adjRows = rawRows.map((r, i) => ({ ...r, close: [2000, 2025, 2000, 2100, 2050][i] }));
  const indAdj = MA2.computeIndicators(adjRows, { shares: 100000000 }, { priceBarsAll: [], lastMarginDate: '2026-10-02' });
  // adjClose 首尾 = (2050-2000)/2000 = +2.5%，正确
  ok(Math.abs(indAdj.quadrant.priceChg - 2.5) < 0.5, '分割修复：adjClose 首尾 priceChg = +2.5%（无假跳变）', indAdj.quadrant.priceChg);
  ok(indAdj.quadrant.key !== 'accumulateDown', '分割修复：adjClose 不再误判', indAdj.quadrant.key);
}

console.log('\n=== 问题2：卖残=0 不崩溃且倍率=null ===');
{
  try {
    const rows = [{ date: '2026-10-02', buy: 276400, sell: 0, ratio: null, close: 100, vol: 5000000 }];
    const bars = makeBars(5000000, '2026-10-02');
    const ind = MA2.computeIndicators(rows, { shares: 10000000, price: 100 }, { priceBarsAll: bars, lastMarginDate: '2026-10-02' });
    const v = MA2.runRules(ind, {});
    ok(true, '卖残=0 不崩溃');
    ok(ind.ratio.value == null, '卖残=0 → 倍率 null', ind.ratio.value);
    ok(ind.ratio.absoluteLevel.label === '—', '卖残=0 → 倍率标签「—」', ind.ratio.absoluteLevel.label);
    ok(ind.borrowRate.buyListed != null, '卖残=0 仍算発行済比', ind.borrowRate.buyListed);
  } catch (e) { ok(false, '卖残=0 崩溃: ' + e.message); }
}

console.log('\n=== 问题3：分母稳定性检测 ===');
{
  // 3905：発行済 32M，JPX 上場比 26.3% 反推 38.4M，差异 +20% → 不稳定
  const rows3905 = [{ date: '2026-10-02', buy: 10110900, sell: 1848100, ratio: 5.47, buyListed: 26.3, sellListed: 4.8 }];
  const ind3905 = MA2.computeIndicators(rows3905, { shares: 32017051 }, { priceBarsAll: [], lastMarginDate: '2026-10-02' });
  ok(ind3905.borrowRate.denomStable === false, '3905 分母不稳定（差异>20%）', ind3905.borrowRate.denomStable);
  ok(ind3905.borrowRate.denomNote != null, '3905 给出分母不稳定说明', ind3905.borrowRate.denomNote);
  ok(ind3905.borrowRate.buyListed === 31.58, '3905 発行済比 = 31.58%', ind3905.borrowRate.buyListed);

  // 6920：発行済 94.3M，上場比 1.2% 反推 97.9M，差异 3.9% → 稳定
  const rows6920 = [{ date: '2026-10-02', buy: 1175100, sell: 680800, ratio: 1.73, buyListed: 1.2, sellListed: 0.7 }];
  const ind6920 = MA2.computeIndicators(rows6920, { shares: 94286400 }, { priceBarsAll: [], lastMarginDate: '2026-10-02' });
  ok(ind6920.borrowRate.denomStable === true, '6920 分母稳定（差异<20%）', ind6920.borrowRate.denomStable);

  // 上場比 <1%（4519 0.1%）：四舍五入误差大，反推不可靠 → denomStable=null + note
  const rows4519 = [{ date: '2026-10-02', buy: 2253800, sell: 41800, ratio: 53.92, buyListed: 0.1, sellListed: 0.0 }];
  const ind4519 = MA2.computeIndicators(rows4519, { shares: 1679057667 }, { priceBarsAll: [], lastMarginDate: '2026-10-02' });
  ok(ind4519.borrowRate.denomStable == null, '4519 上場比<1% → 不判定稳定性（denomStable=null）', ind4519.borrowRate.denomStable);
  ok(ind4519.borrowRate.denomNote != null, '4519 给出"上場比过小"说明', ind4519.borrowRate.denomNote);
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
