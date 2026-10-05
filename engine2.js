/* =========================================================================
 * 信用需給分析引擎 v3
 * -------------------------------------------------------------------------
 * v3 相比 v2 的关键修正：
 *  1. 新增「株価 × 信用買残」四象限判断 —— 信用残方向必须结合股价方向，
 *     否则「股价下跌 + 买残增加」会被误判为「温和建仓」（方向性错误）。
 *  2. 新增「買残消化日数」= 信用買残 ÷ 20日平均成交量。
 *     信用倍率在卖残极少时会失真，消化日数用「绝对量 vs 换手」看真实压力。
 *  3. 信用倍率拆解为买残侧 / 卖残侧贡献，回答「倍率高到底因为什么」。
 *  4. 方向（Direction）与风险（Risk）**分离**，不再混成一个分数。
 *     「信用风险高」≠「股价一定跌」。
 *  5. 13週前比在无周次数据时返回 null，绝不用日次 5 期冒充。
 * ========================================================================= */

/* ---------------- 基础工具 ---------------- */
const sd = (a, b, d = 2) =>
  (a == null || b == null || b === 0) ? null : +(a / b).toFixed(d);

function pctPos(v, lo, hi) {
  if (v == null || lo == null || hi == null || hi === lo) return null;
  return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
}

/**
 * 绝对倍率水平 —— 与「区间位置」彻底分离。
 * 这是纯 UI 风险标签，只按倍率数值本身定级，
 * 绝不因为它落在某个局部区间的高/低位就改变。
 * 它也不参与总信用需给结论（总判断由消化日数/発行済比/买残变化/四象限等共同决定）。
 */
function absoluteRatioLevel(ratio) {
  if (ratio == null || !isFinite(ratio)) return { level: 'unknown', label: '—', color: '#8b96ad', emoji: '' };
  if (ratio < 1)  return { level: 'short', label: '売り長',     color: '#38bdf8', emoji: '🔵' };
  if (ratio < 3)  return { level: 'ok',    label: '均衡～良好', color: '#22c55e', emoji: '🟢' };
  if (ratio < 5)  return { level: 'warn',  label: 'やや高め',   color: '#fbbf24', emoji: '🟡' };
  if (ratio < 10) return { level: 'high',  label: '高め',       color: '#f5a524', emoji: '🟠' };
  return              { level: 'vhigh', label: 'かなり高い', color: '#ff5a6e', emoji: '🔴' };
}

function stat(arr) {
  const xs = (arr || []).filter((x) => x != null && isFinite(x));
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return {
    min: s[0], max: s[s.length - 1], last: xs[xs.length - 1],
    mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2),
    median: s[Math.floor(s.length / 2)], n: xs.length,
  };
}

/** 变化率：末值 vs N 期前 */
function chg(rows, field, periods = 1) {
  if (!rows || rows.length <= periods) return null;
  const a = rows[rows.length - 1][field];
  const b = rows[rows.length - 1 - periods][field];
  if (a == null || b == null || b === 0) return null;
  return +(((a - b) / Math.abs(b)) * 100).toFixed(1);
}

function ma(rows, field, n) {
  if (!rows || rows.length < n) return null;
  const xs = rows.slice(-n).map((r) => r[field]).filter((x) => x != null);
  if (xs.length < n) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / n);
}

function slope(rows, field) {
  const pts = rows.map((r, i) => [i, r[field]]).filter((p) => p[1] != null);
  if (pts.length < 3) return null;
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p[0], 0);
  const sy = pts.reduce((a, p) => a + p[1], 0);
  const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
  const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0);
  const den = n * sxx - sx * sx;
  return den === 0 ? null : Math.round((n * sxy - sx * sy) / den);
}

// wan()（残量转万股）由页面主脚本提供。此处用独立命名，
// 避免内联进单文件时同名顶层 const 冲突导致整段脚本静默失效。
const toWan = (n) => (n == null ? '—' : (n / 10000).toFixed(1));

/* =========================================================================
 * 1. 信用倍率拆解：倍率高到底因为什么？
 * -------------------------------------------------------------------------
 * 倍率 = 買残 ÷ 売残。卖残极少时倍率会失真。
 * 通过「買残/売残各自变化」判断主因，并给出可读结论。
 * ========================================================================= */
function decomposeRatio(rows, span) {
  const last = rows[rows.length - 1];
  const ratio = last.ratio;
  const buyChg = chg(rows, 'buy', span);
  const sellChg = chg(rows, 'sell', span);

  const buys = rows.map(r => r.buy).filter(x => x != null);
  const sells = rows.map(r => r.sell).filter(x => x != null);
  const buyHigh = buys.length > 1 ? pctPos(last.buy, Math.min(...buys), Math.max(...buys)) : null;
  const sellLow = sells.length > 1 ? pctPos(last.sell, Math.min(...sells), Math.max(...sells)) : null;

  const out = {
    ratio: ratio, cause: 'unknown', causeText: '', level: 'info',
    buyChg, sellChg, buyHigh, sellLow,
    buyListed: last.buyListed ?? null,
  };
  if (ratio == null) { out.causeText = '数据不足'; return out; }

  const buyUp   = buyChg != null && buyChg >  3;
  const sellUp   = sellChg != null && sellChg >  3;
  const sellDown = sellChg != null && sellChg < -3;
  const sellVeryLow = sellLow != null && sellLow <= 20;

  const pc = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v + '%');

  if (buyUp && sellDown) {                    // Case C 双因
    out.cause = 'both'; out.level = 'warn';
    out.causeText = `近${span}期为「買残増加（${pc(buyChg)}）＋売残減少（${pc(sellChg)}）」的复合要因。`;
  } else if (buyUp) {                         // Case A 买残堆积
    out.cause = 'longBuild'; out.level = (buyChg >= 20) ? 'warn' : 'info';
    out.causeText = `倍率主要来自「信用買い残の積み上がり」（買残 ${pc(buyChg)}）。`;
  } else if (sellVeryLow || (sellDown && !sellUp)) {   // Case B 卖残极少
    out.cause = 'shortTiny'; out.level = 'info';
    out.causeText = `倍率主要来自「売残が極めて少ない」ため高く見えています（売残 ${pc(sellChg)}、区間位置${sellLow != null ? Math.round(sellLow) + '%' : '—'}）。`;
  } else {
    out.cause = 'mixed';
    out.causeText = `倍率の変化は緩やか（買残 ${pc(buyChg)}、売残 ${pc(sellChg)}）。`;
  }
  return out;
}

/* =========================================================================
 * 2. 株価 × 信用買残 四象限（v3 核心修正）
 * ========================================================================= */
function quadrant(rows, span) {
  const buyChg = chg(rows, 'buy', span);
  // 股价变化用「有收盘价的行」计算；缺价格时返回 null 而非猜测
  const px = rows.filter(r => r.close != null);
  let priceChg = null;
  if (px.length >= 2) {
    const a = px[px.length - 1].close, b = px[0].close;
    if (a != null && b) priceChg = +(((a - b) / b) * 100).toFixed(1);
  }

  if (buyChg == null || priceChg == null) {
    return { key: 'unknown', label: '判定不能', level: 'info', color: '#8b96ad',
             buyChg, priceChg,
             text: '株価または信用残の推移が短く、四象限を判定できません。' };
  }

  const PD = 0.5, BD = 1.0;   // 判定阈值
  const pUp = priceChg > PD, pDn = priceChg < -PD;
  const bUp = buyChg > BD,  bDn = buyChg < -BD;

  if (pUp && bDn) {
    return { key: 'strong', label: '🟢 強い / 健全', level: 'ok', color: '#22c55e',
             buyChg, priceChg,
             text: '株価上昇中に信用買い残が減少。需給の改善であり、健全な調整。' };
  }
  if (pUp && bUp) {
    return { key: 'chasing', label: '🟡 注意', level: 'warn', color: '#f5a524',
             buyChg, priceChg,
             text: '上昇局面で信用買いが積み上がっています。上昇に伴う追高は、後の反転に注意。' };
  }
  if (pDn && bDn) {
    return { key: 'deleverage', label: '🟡 去杠杆', level: 'warn', color: '#f5a524',
             buyChg, priceChg,
             text: '株価下落と同時に信用整理が進行。売り圧の消化に进展。' };
  }
  if (pDn && bUp) {
    return { key: 'accumulateDown', label: '🔴 下落中の買い残増加', level: 'alert', color: '#ff5a6e',
             buyChg, priceChg,
             text: '下落局面で信用買いが増加。ナンピン・信用買い積み上がりの可能性があり、短期需給は悪化。' };
  }
  return { key: 'flat', label: '— 方向性弱', level: 'info', color: '#8b96ad',
           buyChg, priceChg, text: '株価・信用残ともに横ばい。方向性の読み取り材料が不足。' };
}

/* =========================================================================
 * 3. 買残消化日数 = 信用買残 ÷ N日平均成交量
 * -------------------------------------------------------------------------
 * 这才是「买残到底重不重」的核心尺度。
 * 信用倍率在卖残极少时失真，但消化日数不会。
 * ========================================================================= */
/**
 * 買残消化日数 = 信用買残 ÷ N日平均出来高
 * ==================================================================
 * 纯函数签名（不接收 marginRows，天然不会被其期数污染）：
 *
 *   digestDays({ marginBuy, priceBarsAll, lastMarginDate })
 *
 * 参数
 *   marginBuy      最新信用買残（股）
 *   priceBarsAll   Yahoo 完整日线 [{date, close, vol}, ...]（约 485 期）
 *   lastMarginDate 信用残最新日，作为成交量窗口的**右边界**
 *
 * 返回
 *   { days, avgVolume, period, samples, fallback,
 *     days5, avgVolume5, winFrom, winTo, cutoff, level, label, note }
 *
 * 降级规则
 *   >= 20 条有效成交量 → 20 日主口径，fallback=false
 *   5 ~ 19 条         → 降级 5 日，  fallback=true（UI 必须标注）
 *   < 5 条            → 不计算（days=null）
 *
 * 硬约束
 *   · lastMarginDate 之后的行情绝不参与（避免未来数据）
 *   · 取「最后 N 个有效交易日」，不写死日期区间（节假日安全）
 *   · days5 同样取自 priceBarsAll —— 定义是「市场最近 5 个交易日」，
 *     而非「恰好有信用残数据的那几天」
 *   · aligned（同期对齐）数据完全不参与本函数，它只服务四象限判断
 */
function digestDays(opts) {
  const o = opts || {};
  const marginBuy = o.marginBuy;
  const barsAll = o.priceBarsAll || [];
  const cutoff = o.lastMarginDate || (barsAll.length ? barsAll[barsAll.length - 1].date : null);

  const empty = {
    days: null, avgVolume: null, period: null, samples: 0, fallback: false,
    days5: null, avgVolume5: null, level: 'na', label: '—',
    note: '行情データに有効な出来高がありません', cutoff: cutoff,
  };
  if (marginBuy == null || !barsAll.length || !cutoff) return empty;

  // 有效成交量序列：date <= cutoff 且 vol > 0，按日期升序
  const valid = barsAll
    .filter(function (b) { return b.date <= cutoff && b.vol != null && b.vol > 0; })
    .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  if (valid.length < 5) {
    return Object.assign({}, empty, {
      samples: valid.length,
      note: '有効出来高が ' + valid.length + ' 件のみ（5 未満のため算出不可）',
    });
  }

  const avgOf = (n) => {
    if (valid.length < n) return null;
    const w = valid.slice(-n);                 // 最后 n 个有效交易日
    return {
      avg: Math.round(w.reduce(function (a, b) { return a + b.vol; }, 0) / w.length),
      n: w.length,
      from: w[0].date,
      to: w[w.length - 1].date,
    };
  };

  const r20 = avgOf(20);
  const r5 = avgOf(5);

  // 主口径：够 20 用 20；5~19 降级 5 并标记 fallback
  const use = r20 ? { r: r20, period: 20, fallback: false }
                  : { r: r5, period: 5, fallback: true };

  const days = +(marginBuy / use.r.avg).toFixed(2);
  const days5 = r5 ? +(marginBuy / r5.avg).toFixed(2) : null;

  let level, label;
  if (days < 0.5)      { level = 'ok';    label = '軽'; }
  else if (days < 1)   { level = 'ok';    label = '正常'; }
  else if (days < 3)   { level = 'warn';  label = '注意'; }
  else if (days < 5)   { level = 'alert'; label = '偏重'; }
  else                 { level = 'alert'; label = '混雑'; }

  return {
    days: days,
    avgVolume: use.r.avg,
    period: use.period,
    samples: use.r.n,
    fallback: use.fallback,
    days5: days5,
    avgVolume5: r5 ? r5.avg : null,
    // 窗口信息（可追溯）
    winFrom: use.r.from,
    winTo: use.r.to,
    cutoff: cutoff,
    totalValid: valid.length,
    level: level,
    label: label,
    note: use.fallback
      ? '有効出来高 ' + valid.length + ' 件（20 未満）のため ' + use.period +
        ' 日均量に降格。信用需給の判定には 20 日基準を推奨します。'
      : null,
  };
}/* =========================================================================
 * 4. 主指标计算
 * ========================================================================= */
function computeIndicators(rows, val, ctx) {
  const last = rows[rows.length - 1] || {};
  const R = {};

  // 样本自适应周期（日次数据当前仅 5~6 期）
  const span = Math.max(1, Math.min(5, rows.length - 1));
  R.span = span;
  R.dataRange = {
    n: rows.length,
    from: rows[0] ? rows[0].date : null,
    to: rows[rows.length - 1] ? rows[rows.length - 1].date : null,
    has13w: false,      // 由周次数据注入后置为 true
  };

  /* 1. 信用倍率 + 拆解 */
  const ratios = rows.map(r => r.ratio).filter(x => x != null && x > 0);
  R.ratio = {
    value: last.ratio,
    min: ratios.length ? Math.min(...ratios) : null,
    max: ratios.length ? Math.max(...ratios) : null,
    mean: stat(ratios)?.mean ?? null,
    // 短样本时不输出中长期 percentile，改为标注窗口大小
    rangeWindow: ratios.length,
    pos: ratios.length > 1
      ? pctPos(last.ratio, Math.min(...ratios), Math.max(...ratios)) : null,
    chg1: chg(rows, 'ratio', 1),
    chgN: chg(rows, 'ratio', span),
    // 绝对倍率水平（与区间位置无关，纯 UI 标签）
    absoluteLevel: absoluteRatioLevel(last.ratio),
  };
  R.ratioDecomp = decomposeRatio(rows, span);

  /* 2/3. 買残 / 売残 */
  const ma5buy = ma(rows, 'buy', 5), ma20buy = ma(rows, 'buy', 20);
  const ma5sell = ma(rows, 'sell', 5), ma20sell = ma(rows, 'sell', 20);
  const maNbuy = ma(rows, 'buy', span), maNsell = ma(rows, 'sell', span);
  R.long = {
    value: last.buy,
    chg1: chg(rows, 'buy', 1),
    chgN: chg(rows, 'buy', span),
    chg13w: null,            // 无周次数据时保持 null，不伪造
    ma5: ma5buy, ma20: ma20buy, maN: maNbuy,
    aboveMa5: ma5buy != null ? last.buy > ma5buy : null,
    aboveMa20: ma20buy != null ? last.buy > ma20buy : null,
    aboveMaN: (maNbuy != null && last.buy != null) ? last.buy > maNbuy : null,
    listedRatio: last.buyListed ?? null,
  };
  R.short = {
    value: last.sell,
    chg1: chg(rows, 'sell', 1),
    chgN: chg(rows, 'sell', span),
    chg13w: null,
    ma5: ma5sell, ma20: ma20sell, maN: maNsell,
    aboveMa5: ma5sell != null ? last.sell > ma5sell : null,
    aboveMa20: ma20sell != null ? last.sell > ma20sell : null,
    aboveMaN: (maNsell != null && last.sell != null) ? last.sell > maNsell : null,
    listedRatio: last.sellListed ?? null,
  };

  /* 4. 变化率趋势 */
  R.trend = {
    buySlope: slope(rows, 'buy'),
    sellSlope: slope(rows, 'sell'),
    ratioSlope: slope(rows, 'ratio'),
    netFlow: (R.long.chgN != null && R.short.chgN != null)
      ? +(R.long.chgN - R.short.chgN).toFixed(1) : null,
    span,
  };

  /* 5. 買残/売残 対 発行済株式数
     口径说明（重要）：
     - JPX 的「上場比」字段（last.buyListed）分母是「上場株式数」，不是発行済株式数；
     - Ganan 提供的是「発行済株式数」（val.shares）。
     两者口径不同，不能混用。此处主口径 = 自己用 val.shares 算「買残 ÷ 発行済株式数」，
     JPX 上場比作为审计对比保留。拿不到発行済株式数时 fallback 到 JPX 上場比并如实标注。 */
  const shares = (val && val.shares > 0) ? val.shares : null;
  R.borrowRate = {
    // 分母（発行済株式数，来自 Ganan）
    shares: shares,
    sharesSource: shares ? 'Ganan 発行済株式数' : (last.buyListed != null ? 'JPX 上場比（分母=上場株式数）' : null),
    // 主口径：買残/売残 ÷ 発行済株式数
    buyListed: (shares && last.buy != null) ? +((last.buy / shares) * 100).toFixed(2)
             : (last.buyListed ?? null),
    sellListed: (shares && last.sell != null) ? +((last.sell / shares) * 100).toFixed(2)
              : (last.sellListed ?? null),
    // 审计：JPX 原始上場比（分母=上場株式数），供对比
    buyListedJpx: last.buyListed ?? null,
    sellListedJpx: last.sellListed ?? null,
    daysToCover: null,
    note: shares ? null : '発行済株式数未取得，fallback 到 JPX 上場比（分母=上場株式数）',
  };

  /* 6. 買残消化日数（核心）
     只传 marginBuy / priceBarsAll / lastMarginDate 三个标量（数据源：完整行情 + 信用残最新日截断），
     不把 rows（仅 1~5 期）传入，避免污染成交量窗口。 */
  const _barsAll = ctx && ctx.priceBarsAll ? ctx.priceBarsAll
                : (val && val.bars) ? val.bars : null;
  const _lastMDate = (ctx && ctx.lastMarginDate) || (rows.length ? rows[rows.length-1].date : null);
  R.digest = digestDays({
    marginBuy: last.buy,
    priceBarsAll: _barsAll,
    lastMarginDate: _lastMDate,
  });

  /* 7. 株価 × 買残 四象限（核心） */
  R.quadrant = quadrant(rows, span);

  /* 估值类（不属于信用需给，单独模块） */
  const price = val && val.price;
  const mcap = val && val.mcap ? val.mcap * 1e6 : null;
  R.creditToMcap = {
    price: price ?? null, mcap,
    creditValue: (last.buy != null && price) ? last.buy * price : null,
    ratio: (mcap && last.buy != null && price)
      ? +((last.buy * price) / mcap * 100).toFixed(2) : null,
    note: mcap ? null : '站点未提供时価総額，无法计算',
  };
  R.per = { now: (val?.perFcst || val?.perResult) ?? null,
            result: val?.perResult ?? null, forecast: val?.perFcst ?? null };
  R.pbr = { now: (val?.pbrFcst || val?.pbrResult) ?? null,
            result: val?.pbrResult ?? null, forecast: val?.pbrFcst ?? null };
  R.dividend = { yield: val?.divYield ?? null, dps: val?.dps ?? null };

  return R;
}

/* =========================================================================
 * 5. 异常值检测
 * ========================================================================= */
/**
 * 异常值检测 —— 分为两类（P1-6）
 *   kind:'data'   データ異常：数据本身可疑（计算不一致、异常跳变、单位/日期错误）
 *   kind:'note'   分析上の注意：数据没错，但分析前提受限（样本不足、周次缺失等）
 * 正常时返回空数组，UI 显示「データ整合性OK」。
 */
function detectAnomalies(rows, ind, val) {
  const out = [];
  const last = rows[rows.length - 1] || {};
  const push = (kind, level, t, d) => out.push({ kind, level, title: t, detail: d });

  /* ========== A. データ異常 ========== */

  // A1 倍率计算不一致
  if (last.buy != null && last.sell != null && last.sell > 0 && last.ratio != null) {
    const calc = +(last.buy / last.sell).toFixed(2);
    if (Math.abs(calc - last.ratio) > 0.02) {
      push('data', 'err', '倍率の計算が一致しません',
        `表示値 ${last.ratio}倍 と 買残÷売残 = ${calc}倍 が異なります。数据源の整合性を確認してください。`);
    }
  }

  // A2 单位异常：残量级突变（与相邻期相差 2 个数量级）
  if (rows.length >= 2) {
    const prev = rows[rows.length - 2];
    for (const [k, label] of [['buy', '信用買残'], ['sell', '信用売残']]) {
      const a = last[k], b = prev[k];
      if (!a || !b) continue;
      const r = a / b;
      if (r > 100 || r < 0.01) {
        push('data', 'err', `${label}の単位異常疑い`,
          `${prev.date} ${b.toLocaleString()} → ${last.date} ${a.toLocaleString()}（${Math.round(r*100)}%）` +
          `。桁ずれ（株/口、1万株単位切替等）の可能性があります。`);
      }
    }
  }

  // A3 单日异常跳变（倍率）
  const r1 = ind.ratio.chg1;
  if (r1 != null && Math.abs(r1) >= 25) {
    push('data', 'warn', '信用倍率の単日急変',
      `前営業日比 ${r1 > 0 ? '+' : ''}${r1}%（${last.ratio}倍）。` +
      `大口取引や投信/大股东の異動が疑われます。`);
  }

  // A4 売残单日激增
  const s1 = ind.short.chg1;
  if (s1 != null && s1 >= 40) {
    push('data', 'warn', '信用売残の単日急増',
      `前営業日比 +${s1}%。空売り建倉の集中の可能性。`);
  }

  // A5 日期异常：日次数据里出现非递增或重复
  const seen = new Set();
  let dateIssue = null;
  for (let i = 0; i < rows.length; i++) {
    const d = rows[i].date;
    if (seen.has(d)) { dateIssue = `重複日付: ${d}`; break; }
    seen.add(d);
    if (i > 0 && d <= rows[i - 1].date) { dateIssue = `日付が逆行: ${rows[i-1].date} → ${d}`; break; }
  }
  if (dateIssue) push('data', 'err', '日付の整合性エラー', dateIssue);

  // A6 买卖残极度失衡（倍率 > 50 或 < 1）—— 数据可读性提示
  if (last.buy != null && last.sell != null && last.sell > 0) {
    const r = last.buy / last.sell;
    if (r >= 50 || r <= 0.5) {
      push('data', 'info', '倍率の極端値',
        `買残は売残の ${r.toFixed(1)} 倍（${last.ratio}倍）。` +
        `倍率だけでは需給の軽重は判断できません — 「買残消化日数」と「上場比」を確認してください。`);
    }
  }

  /* ========== B. 分析上の注意 ========== */

  // B1 样本数不足
  const n = rows.length;
  if (n < 20) {
    push('note', 'info', 'サンプル数が不足しています',
      `現在のデータ ${n} 期（JPX 方式和 2026-09-25 稼働分の日次データのみ）。` +
      `20日均量・中期の百分位・長期の高安値は算出できません。`);
  }

  // B2 13週データ未取得
  push('note', 'info', '13週データは未取得',
    'JPX の「銘柄別信用取引週末残高」は 2026-09-28 の制度変更以降、日次公表に統合され、' +
    '個票の週次実績がWebsite 上で公開されていません。' +
    'そのため 13週前比・26週/52週位置に真实的数値は表示せず「—」としています。');

  // B3 短期高安值（非中长期极值）
  if (n > 0 && n < 20) {
    const bmax = Math.max(...rows.map(r => r.buy || 0));
    const bmin = Math.min(...rows.map(r => r.buy || 0));
    if (last.buy != null && last.buy >= bmax) {
      push('note', 'info', `${n}営業日高値`,
        `現在の信用買残 ${toWan(last.buy)} 万株は直近 ${n} 営業日の最高値。` +
        `中长期の最高値ではありません。`);
    } else if (last.buy != null && last.buy <= bmin) {
      push('note', 'info', `${n}営業日安値`,
        `現在の信用買残 ${toWan(last.buy)} 万株は直近 ${n} 営業日の最安値。` +
        `中长期の最安値ではありません。`);
    }
  }

  // B4 BPS 未验证 → PBR 不可用
  if (ind && ind.borrowRate && !ind.borrowRate.bpsVerified) {
    push('note', 'info', 'PBR はデータ未検証',
      'BPS が财报実値（API 由来）を得ていないため、PBR 基準価格と PBR 区间は算出していません。' +
      '「現値 ÷ サイトPBR」からの逆算は時点ずれを含み、誤差 inflicted のため採用しません。');
  }

  return out;
}

/* =========================================================================
 * 6. 规则引擎 —— 方向与风险分离
 * -------------------------------------------------------------------------
 *  Risk（信用风险 0~100）：只回答「信用需給是否紧张」，不预测涨跌。
 *  Dir（方向 -100~+100）：回答多空倾向。
 *  「信用风险高」≠「股价一定跌」，故两者必须分开显示。
 * ========================================================================= */

const RISK_RULES = [
  { id: 'digest-veryhigh', w: 30,
    test: (i) => i.digest.days != null && i.digest.days >= 5,
    why: (i) => `買残消化日数 ${i.digest.days} 日（≥5日），按 ${i.digest.span}日均成交量需${i.digest.days}日才能消化，仓位偏重。` },
  { id: 'digest-high', w: 18,
    test: (i) => i.digest.days != null && i.digest.days >= 3 && i.digest.days < 5,
    why: (i) => `買残消化日数 ${i.digest.days} 日（3~5日），仓位偏重。` },
  { id: 'digest-normal', w: 10,
    test: (i) => i.digest.days != null && i.digest.days < 1,
    why: (i) => `買残消化日数 ${i.digest.days} 日（<1日），以成交量看买盘并不重。` },
  { id: 'down-accum', w: 28,
    test: (i) => i.quadrant.key === 'accumulateDown',
    why: (i) => `股价 ${i.quadrant.priceChg}% 与買残 ${i.quadrant.buyChg}% 反向，处于「下落中的信用買い增加」。` },
  { id: 'chasing', w: 16,
    test: (i) => i.quadrant.key === 'chasing',
    why: (i) => `股价 ${i.quadrant.priceChg}% 上涨同时買残 ${i.quadrant.buyChg}% 增加，上涨伴随杠杆买盘堆积。` },
  { id: 'long-surge', w: 20,
    test: (i) => i.long.chgN != null && i.long.chgN >= 25,
    why: (i) => `近${i.span}期買残激增 ${i.long.chgN}%，追高迹象明显。` },
  { id: 'short-build', w: 20,
    test: (i) => i.short.chgN != null && i.short.chgN >= 20 && i.short.aboveMaN === true,
    why: (i) => `近${i.span}期売残增加 ${i.short.chgN}% 并站上同周期均线，空头在建仓。` },
  { id: 'listed-high', w: 14,
    test: (i) => i.borrowRate.buyListed != null && i.borrowRate.buyListed >= 4,
    why: (i) => `買残占発行済株式数 ${i.borrowRate.buyListed}%，融资仓位占公司总股本比例偏高。` },
  { id: 'deleveraging', w: 10,
    test: (i) => i.quadrant.key === 'deleverage',
    why: (i) => `股价 ${i.quadrant.priceChg}% 下落同时買残 ${i.quadrant.buyChg}%，属信用整理。` },
];

const DIR_RULES = [
  { id: 'q-strong', w: 30, zone: 'up',
    test: (i) => i.quadrant.key === 'strong',
    why: (i) => `股价 ${i.quadrant.priceChg}% 上升同时買残 ${i.quadrant.buyChg}%，股价上涨而杠杆买盘在撤，属健康形态。` },
  { id: 'q-deleverage', w: 10, zone: 'up',
    test: (i) => i.quadrant.key === 'deleverage',
    why: (i) => `股价 ${i.quadrant.priceChg}% 回落同时買残 ${i.quadrant.buyChg}%，多为获利了结或被动整理。` },
  { id: 'q-accum', w: 30, zone: 'dn',
    test: (i) => i.quadrant.key === 'accumulateDown',
    why: (i) => `股价 ${i.quadrant.priceChg}% 下跌而買残 ${i.quadrant.buyChg}%，下跌中杠杆资金在接盘，短期偏空。` },
  { id: 'q-chase', w: 14, zone: 'dn',
    test: (i) => i.quadrant.key === 'chasing',
    why: (i) => `股价 ${i.quadrant.priceChg}% 上涨伴随買残 ${i.quadrant.buyChg}%，上涨质量存疑。` },
  { id: 'short-squeeze', w: 26, zone: 'up',
    test: (i) => i.ratioDecomp.cause === 'shortTiny' && i.ratio.value != null && i.ratio.value >= 8,
    why: (i) => `倍率 ${i.ratio.value}倍 主要来自「売残极少」而非買残堆积，軋空（ショートカバー）余力相对存在。` },
  { id: 'per-high', w: 12, zone: 'dn',
    test: (i) => i.per.now != null && i.per.now >= 25,
    why: (i) => `PER ${i.per.now}倍，估值不便宜。` },
  { id: 'div-good', w: 10, zone: 'up',
    test: (i) => i.dividend.yield != null && i.dividend.yield >= 3,
    why: (i) => `予想配当利回り ${i.dividend.yield}%，股息支撑较强。` },
];

function runRules(ind, val) {
  const rHits = [], dHits = [];
  for (const r of RISK_RULES) {
    let ok = false;
    try { ok = !!r.test(ind, val); } catch (e) { ok = false; }
    if (ok) rHits.push({ ...r, whyText: r.why(ind, val) });
  }
  for (const r of DIR_RULES) {
    let ok = false;
    try { ok = !!r.test(ind, val); } catch (e) { ok = false; }
    if (ok) dHits.push({ ...r, whyText: r.why(ind, val) });
  }

  /* 信用风险分 0~100，越高越紧张 */
  const risk = Math.max(0, Math.min(100, rHits.reduce((a, h) => a + h.w, 0)));
  let riskLabel, riskColor;
  if (risk >= 70)      { riskLabel = '高い';riskColor = '#ff5a6e'; }
  else if (risk >= 45) { riskLabel = 'やや高い';   riskColor = '#f5a524'; }
  else if (risk >= 25) { riskLabel = '中程度';     riskColor = '#fbbf24'; }
  else                 { riskLabel = '低い';       riskColor = '#22c55e'; }

  /* 方向分 -100~+100，正为偏多 */
  const dir = Math.max(-100, Math.min(100,
    dHits.reduce((a, h) => a + (h.zone === 'up' ? h.w : -h.w), 0)));
  let dirLabel, dirColor;
  if (dir >= 30)      { dirLabel = '強気';    dirColor = '#22c55e'; }
  else if (dir >= 10) { dirLabel = 'やや強気'; dirColor = '#4ade80'; }
  else if (dir > -10) { dirLabel = '中立';    dirColor = '#8b96ad'; }
  else if (dir > -30) { dirLabel = 'やや弱気'; dirColor = '#fbbf24'; }
  else                { dirLabel = '弱気';    dirColor = '#ff5a6e'; }

  return {
    risk, riskLabel, riskColor, riskHits: rHits,
    dir, dirLabel, dirColor, dirHits: dHits,
    quadrant: ind.quadrant,
  };
}

window.MA2 = {
  computeIndicators, detectAnomalies, runRules,
  decomposeRatio, quadrant, digestDays, absoluteRatioLevel,
  stat, chg, ma, slope, sd, pctPos, toWan,
};
