import fs from 'fs';
const src = fs.readFileSync(new URL('./engine2.js', import.meta.url), 'utf8');
const { MA2 } = new Function('window', src + '\n; return {MA2: window.MA2};')({});

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};

// 构造 N 日行情
function makeBars(avgVol, lastDate, n = 30, closeBase = 100) {
  const bars = [];
  const d0 = new Date('2026-09-01');
  for (let i = 0; i < n; i++) {
    const d = new Date(d0.getTime() + i * 864e5);
    const ds = d.toISOString().slice(0, 10);
    if (ds > lastDate) break;
    bars.push({ date: ds, close: closeBase + i, vol: avgVol });
  }
  return bars;
}

// 构造信用残行（含 close，用于四象限）
function makeRows(buy, sell, ratio, priceChgPct, buyChgPct, vol, closeBase = 100) {
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const px = closeBase * (1 + priceChgPct / 100 * i / 4);
    const b = buy * (1 + buyChgPct / 100 * i / 4);
    rows.push({ date: '2026-09-' + String(25 + i), buy: Math.round(b), sell, ratio, close: px, vol });
  }
  return rows;
}

console.log('=== 单元测试：absoluteRatioLevel / chg / digestDays ===');
ok(MA2.absoluteRatioLevel(0.5).label === '売り長', '0.5 → 売り長');
ok(MA2.absoluteRatioLevel(1.73).label === '均衡～良好', '1.73 → 均衡～良好');
ok(MA2.absoluteRatioLevel(50).label === 'かなり高い', '50 → かなり高い');
ok(MA2.absoluteRatioLevel(null).label === '—', 'null → —（不崩溃）');
ok(MA2.absoluteRatioLevel(Infinity).label === '—', 'Infinity → —（不崩溃）');

const chgRows = [{date:'2026-01-01',buy:100},{date:'2026-01-02',buy:110},{date:'2026-01-03',buy:121}];
ok(MA2.chg(chgRows,'buy',1) === 10.0, 'chg(1期) = 10%', MA2.chg(chgRows,'buy',1));
ok(MA2.chg(chgRows,'buy',2) === 21.0, 'chg(2期) = 21%', MA2.chg(chgRows,'buy',2));
ok(MA2.chg(chgRows,'buy',3) === null, 'chg 超样本 → null');

console.log('\n=== 场景测试 A-H ===');
// A: 股价+10% 买残-20% 消化0.2日 → 偏改善
{
  const rows = makeRows(1000000, 500000, 2.0, 10, -20, 5000000);
  const bars = makeBars(5000000, '2026-10-02'); // 消化 = 100万/500万 = 0.2日
  const ind = MA2.computeIndicators(rows, { shares: 100000000, price: 110 }, { priceBarsAll: bars, lastMarginDate: '2026-10-02' });
  const v = MA2.runRules(ind, {});
  ok(ind.quadrant.key === 'strong', 'A 四象限 = strong（股价↑买残↓）', ind.quadrant.key);
  ok(ind.digest.days != null && ind.digest.days < 0.3, 'A 消化 0.2日', ind.digest.days);
  ok(v.dir > 0, 'A 方向 = 偏多', v.dir);
}

// B: 股价-10% 买残+30% 消化5日 → 明显恶化
{
  const rows = makeRows(2000000, 400000, 5.0, -10, 30, 400000);
  const bars = makeBars(400000, '2026-10-02'); // 消化 = 200万/40万 = 5日
  const ind = MA2.computeIndicators(rows, { shares: 100000000, price: 90 }, { priceBarsAll: bars, lastMarginDate: '2026-10-02' });
  const v = MA2.runRules(ind, {});
  ok(ind.quadrant.key === 'accumulateDown', 'B 四象限 = accumulateDown', ind.quadrant.key);
  ok(ind.digest.days != null && ind.digest.days >= 5, 'B 消化 5日', ind.digest.days);
  ok(v.dir < 0, 'B 方向 = 偏空', v.dir);
  ok(v.risk >= 45, 'B 风险明显偏高', v.risk);
}

// C: 倍率50倍 但消化0.2日 发行股比0.1% → 不能单凭倍率判极高风险
{
  const rows = [{ date: '2026-10-02', buy: 1000000, sell: 20000, ratio: 50, close: 100, vol: 5000000 }];
  const bars = makeBars(5000000, '2026-10-02'); // 消化 = 100万/500万 = 0.2日
  const ind = MA2.computeIndicators(rows, { shares: 1000000000, price: 100 }, { priceBarsAll: bars, lastMarginDate: '2026-10-02' });
  const v = MA2.runRules(ind, {});
  ok(ind.ratio.absoluteLevel.emoji === '🔴', 'C 倍率标签 🔴（标签层面）', ind.ratio.absoluteLevel.label);
  ok(ind.digest.days < 0.5, 'C 消化 0.2日', ind.digest.days);
  ok(ind.borrowRate.buyListed === 0.1, 'C 发行股比 0.1%', ind.borrowRate.buyListed);
  ok(v.risk < 45, 'C 总风险不因倍率高而"高"', v.risk);
}

// D: 倍率2倍 但消化8日 发行股比15% → 不能判低风险
{
  const rows = [{ date: '2026-10-02', buy: 15000000, sell: 7500000, ratio: 2, close: 100, vol: 1875000 }];
  const bars = makeBars(1875000, '2026-10-02'); // 消化 = 1500万/187.5万 = 8日
  const ind = MA2.computeIndicators(rows, { shares: 100000000, price: 100 }, { priceBarsAll: bars, lastMarginDate: '2026-10-02' });
  const v = MA2.runRules(ind, {});
  ok(ind.ratio.absoluteLevel.emoji === '🟢', 'D 倍率标签 🟢（标签层面）', ind.ratio.absoluteLevel.label);
  ok(ind.digest.days != null && ind.digest.days >= 5, 'D 消化 8日', ind.digest.days);
  ok(ind.borrowRate.buyListed === 15, 'D 发行股比 15%', ind.borrowRate.buyListed);
  ok(v.risk >= 40, 'D 总风险不因倍率低而"低"（risk≥40，属中程度偏上）', v.risk);
}

// E: 卖残=0 → 不得崩溃
{
  try {
    const rows = [{ date: '2026-10-02', buy: 1000000, sell: 0, ratio: null, close: 100, vol: 5000000 }];
    const bars = makeBars(5000000, '2026-10-02');
    const ind = MA2.computeIndicators(rows, { shares: 100000000, price: 100 }, { priceBarsAll: bars, lastMarginDate: '2026-10-02' });
    const v = MA2.runRules(ind, {});
    ok(true, 'E 卖残=0 不崩溃（ratio=null → 显示 —）');
    ok(ind.ratio.value == null || !isFinite(ind.ratio.value), 'E ratio 为 null/Infinity 不参与评级', ind.ratio.value);
  } catch (e) { ok(false, 'E 卖残=0 崩溃: ' + e.message); }
}

// F: 买残=0 → 不得崩溃
{
  try {
    const rows = [{ date: '2026-10-02', buy: 0, sell: 500000, ratio: 0, close: 100, vol: 5000000 }];
    const bars = makeBars(5000000, '2026-10-02');
    const ind = MA2.computeIndicators(rows, { shares: 100000000, price: 100 }, { priceBarsAll: bars, lastMarginDate: '2026-10-02' });
    MA2.runRules(ind, {});
    ok(true, 'F 买残=0 不崩溃');
    ok(ind.digest.days == null, 'F 买残=0 → 消化日数不计算', ind.digest.days);
  } catch (e) { ok(false, 'F 买残=0 崩溃: ' + e.message); }
}

// H: 只有1期信用残 + 485日行情 → 20日消化日数仍正常
{
  const rows = [{ date: '2026-10-02', buy: 1000000, sell: 500000, ratio: 2, close: 100 }];
  const bars = makeBars(5000000, '2026-10-02', 485); // 485 日行情
  const ind = MA2.computeIndicators(rows, { shares: 100000000, price: 100 }, { priceBarsAll: bars, lastMarginDate: '2026-10-02' });
  ok(ind.digest.days != null && Math.abs(ind.digest.days - 0.2) < 0.01, 'H 1期信用残仍算 20 日消化（0.2日）', ind.digest.days);
  ok(ind.digest.samples === 20, 'H 用满 20 个成交量样本', ind.digest.samples);
  ok(ind.digest.fallback === false, 'H 无降级', ind.digest.fallback);
}

console.log('\n=== invariant tests（UI 文字与评级一致性）===');
// 消化<0.5 且 发行股比<0.5% → 绝对倍率压力不应判"高"
{
  const rows = [{ date: '2026-10-02', buy: 1000000, sell: 500000, ratio: 2, close: 100, vol: 5000000 }];
  const bars = makeBars(5000000, '2026-10-02');
  const ind = MA2.computeIndicators(rows, { shares: 1000000000, price: 100 }, { priceBarsAll: bars, lastMarginDate: '2026-10-02' });
  const v = MA2.runRules(ind, {});
  ok(ind.digest.days < 0.5, 'invariant: 消化 < 0.5日', ind.digest.days);
  ok(ind.borrowRate.buyListed < 0.5, 'invariant: 发行股比 < 0.5%', ind.borrowRate.buyListed);
  ok(v.risk < 45, 'invariant: 绝对压力不判"高"（risk < 45）', v.risk);
}
// 倍率 1.7 → 评级不该是"高"
{
  const lv = MA2.absoluteRatioLevel(1.7);
  ok(lv.label === '均衡～良好' && lv.emoji === '🟢', 'invariant: 1.7倍 → 均衡（非"高"）', lv);
}

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
