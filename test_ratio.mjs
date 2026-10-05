import fs from 'fs';
const src = fs.readFileSync(new URL('./engine2.js', import.meta.url), 'utf8');
const { MA2 } = new Function('window', src + '\n; return {MA2: window.MA2};')({});

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
};

// 构造 20 日行情（用于消化日数）
function makeBars(avgVol, lastDate, n = 30) {
  const bars = [];
  const d0 = new Date('2026-09-01');
  for (let i = 0; i < n; i++) {
    const d = new Date(d0.getTime() + i * 864e5);
    const ds = d.toISOString().slice(0, 10);
    if (ds > lastDate) break;
    bars.push({ date: ds, close: 100 + i, vol: avgVol });
  }
  return bars;
}

console.log('=== P0-1 倍率评级：绝对水平与区间位置解耦 ===');
const lv = (r) => MA2.absoluteRatioLevel(r);
ok(lv(0.5).label === '売り長' && lv(0.5).emoji === '🔵', '0.5 → 🔵 売り長');
ok(lv(1.73).label === '均衡～良好' && lv(1.73).emoji === '🟢', '6920 1.73 → 🟢 均衡～良好');
ok(lv(3.5).label === 'やや高め' && lv(3.5).emoji === '🟡', '3.5 → 🟡 やや高め');
ok(lv(5.47).label === '高め' && lv(5.47).emoji === '🟠', '3905 5.47 → 🟠 高め');
ok(lv(13.44).label === 'かなり高い' && lv(13.44).emoji === '🔴', '7974 13.44 → 🔴 かなり高い');
ok(lv(53.92).label === 'かなり高い' && lv(53.92).emoji === '🔴', '4519 53.92 → 🔴 かなり高い');

console.log('\n=== P0-2 発行済比口径（自己算，用 val.shares） ===');
// 6920：买残 1,175,100 / 発行済 94,286,400 = 1.246%
let rows6920 = [
  { date: '2026-10-02', buy: 1175100, sell: 680800, ratio: 1.73, buyListed: 1.2, sellListed: 0.7 },
];
let ind6920 = MA2.computeIndicators(rows6920, { shares: 94286400 }, { priceBarsAll: [], lastMarginDate: '2026-10-02' });
ok(ind6920.borrowRate.buyListed === 1.25, '6920 発行済比 = 1.25%', ind6920.borrowRate.buyListed);
ok(ind6920.borrowRate.shares === 94286400, '6920 分母 = 94,286,400', ind6920.borrowRate.shares);
ok(ind6920.borrowRate.sharesSource === 'Ganan 発行済株式数', '6920 分母来源 = Ganan', ind6920.borrowRate.sharesSource);
ok(ind6920.borrowRate.buyListedJpx === 1.2, '6920 JPX上場比(参考) = 1.2%', ind6920.borrowRate.buyListedJpx);

// 3905：买残 10,110,900 / 発行済 32,017,051 = 31.58%
let rows3905 = [
  { date: '2026-10-02', buy: 10110900, sell: 1848100, ratio: 5.47, buyListed: 26.3, sellListed: 4.8 },
];
let ind3905 = MA2.computeIndicators(rows3905, { shares: 32017051 }, { priceBarsAll: [], lastMarginDate: '2026-10-02' });
ok(ind3905.borrowRate.buyListed === 31.58, '3905 発行済比 = 31.58%', ind3905.borrowRate.buyListed);

// fallback：无 shares 时回退 JPX 上場比
let rowsNoShare = [
  { date: '2026-10-02', buy: 1175100, sell: 680800, ratio: 1.73, buyListed: 1.2, sellListed: 0.7 },
];
let indNoShare = MA2.computeIndicators(rowsNoShare, { shares: null }, { priceBarsAll: [], lastMarginDate: '2026-10-02' });
ok(indNoShare.borrowRate.buyListed === 1.2, '无 shares 时 fallback 到 JPX 上場比 1.2%', indNoShare.borrowRate.buyListed);
ok(indNoShare.borrowRate.note != null, '无 shares 时给出 note', indNoShare.borrowRate.note);

console.log('\n=== P1 总判断解耦：倍率高 ≠ 风险高 ===');
// 4519：倍率 53.92，但消化日数极低（0.4日）
const bars4519 = makeBars(5000000, '2026-10-02'); // 20日均量 500万，买残225万 → 0.45日
let rows4519 = [
  { date: '2026-09-28', buy: 1832100, sell: 52300, ratio: 35.03, close: 7000, vol: 5000000, buyListed: 0.1 },
  { date: '2026-09-29', buy: 2048400, sell: 47300, ratio: 43.31, close: 7050, vol: 5000000, buyListed: 0.1 },
  { date: '2026-09-30', buy: 2016200, sell: 41000, ratio: 49.18, close: 6980, vol: 5000000, buyListed: 0.1 },
  { date: '2026-10-01', buy: 2054800, sell: 41100, ratio: 50.0, close: 6950, vol: 5000000, buyListed: 0.1 },
  { date: '2026-10-02', buy: 2253800, sell: 41800, ratio: 53.92, close: 6930, vol: 5000000, buyListed: 0.1 },
];
let ind4519 = MA2.computeIndicators(rows4519, { shares: 1679057667 }, { priceBarsAll: bars4519, lastMarginDate: '2026-10-02' });
let verdict4519 = MA2.runRules(ind4519, {});
console.log('  4519: 倍率', ind4519.ratio.value, '消化', ind4519.digest.days, '风险', verdict4519.risk, '方向', verdict4519.dir);
ok(ind4519.ratio.absoluteLevel.emoji === '🔴', '4519 倍率标签 = 🔴 かなり高い（标签）', ind4519.ratio.absoluteLevel);
ok(verdict4519.risk < 70, '4519 风险分 < 70（不被倍率抬高到"高"）', verdict4519.risk);
ok(!(verdict4519.riskHits.some(h => h.id.startsWith('ratio'))), '4519 风险规则里无纯倍率规则', verdict4519.riskHits.map(h=>h.id));

// 3905：倍率仅 5.47，但発行済比 31.58% 重
let rows3905full = [
  { date: '2026-10-02', buy: 10110900, sell: 1848100, ratio: 5.47, close: 500, vol: 3000000, buyListed: 26.3 },
];
let ind3905full = MA2.computeIndicators(rows3905full, { shares: 32017051 }, { priceBarsAll: makeBars(3000000,'2026-10-02'), lastMarginDate: '2026-10-02' });
let verdict3905 = MA2.runRules(ind3905full, {});
console.log('  3905: 倍率', ind3905full.ratio.value, '発行済比', ind3905full.borrowRate.buyListed+'%', '风险', verdict3905.risk);
ok(ind3905full.ratio.absoluteLevel.emoji === '🟠', '3905 倍率标签 = 🟠 高め', ind3905full.ratio.absoluteLevel);
ok(verdict3905.risk >= 14, '3905 触发 listed-high 风险规则（発行済比 31.58% ≥4%）', verdict3905.riskHits.map(h=>h.id));

// 6920 完整：倍率 1.73 🟢，股价 +15.3%，买残 -19%
let rows6920full = [
  { date: '2026-09-28', buy: 1450500, sell: 375800, ratio: 3.86, close: 40060, vol: 3917000, buyListed: 1.5 },
  { date: '2026-09-29', buy: 1368700, sell: 429000, ratio: 3.19, close: 41500, vol: 3917000, buyListed: 1.5 },
  { date: '2026-09-30', buy: 1448300, sell: 406900, ratio: 3.56, close: 43200, vol: 3917000, buyListed: 1.5 },
  { date: '2026-10-01', buy: 1211800, sell: 716300, ratio: 1.69, close: 44800, vol: 3917000, buyListed: 1.3 },
  { date: '2026-10-02', buy: 1175100, sell: 680800, ratio: 1.73, close: 46190, vol: 3917000, buyListed: 1.2 },
];
let ind6920full = MA2.computeIndicators(rows6920full, { shares: 94286400, price: 46190 }, { priceBarsAll: makeBars(3917000,'2026-10-02'), lastMarginDate: '2026-10-02' });
let verdict6920 = MA2.runRules(ind6920full, {});
console.log('  6920: 倍率', ind6920full.ratio.value, '→', ind6920full.ratio.absoluteLevel.emoji+ind6920full.ratio.absoluteLevel.label,
  '| 消化', ind6920full.digest.days, '| 股价', ind6920full.quadrant.priceChg+'%', '| 买残', ind6920full.quadrant.buyChg+'%', '| 方向', verdict6920.dir);
ok(ind6920full.ratio.absoluteLevel.emoji === '🟢', '6920 倍率标签 = 🟢 均衡～良好', ind6920full.ratio.absoluteLevel);
ok(ind6920full.quadrant.key === 'strong', '6920 四象限 = 股价↑+买残↓（健全）', ind6920full.quadrant.key);
ok(Math.abs(ind6920full.quadrant.priceChg - 15.3) < 0.2, '6920 股价 +15.3%', ind6920full.quadrant.priceChg);
ok(ind6920full.quadrant.buyChg < -15, '6920 买残约 -19%', ind6920full.quadrant.buyChg);
ok(verdict6920.dir > 0, '6920 总方向 = 偏多（改善）', verdict6920.dir);

console.log('\n========================================');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
