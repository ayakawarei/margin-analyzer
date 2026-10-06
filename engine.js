/* =========================================================================
 * 日股信用残分析引擎
 * 数据源：
 *   1) 主要 —— GananFinance（信用残 / 信用倍率 / PER / PBR / 配当利回り）
 *      https://ganan-finance.com/{code}/short_positions   信用残·信用倍率
 *      https://ganan-finance.com/{code}                   估值·配当·時価総額
 *   2) 补充 —— J-Quants API（可选）行情与财报，用于算 PER/PBR 区间
 *      https://api.jquants.com/v2/equities/bars/daily
 *      https://api.jquants.com/v2/fins/summary
 *   全部走公共 CORS 代理（r.jina.ai）以绕过跨域限制。
 * ========================================================================= */

/* ---------- 代理层 ---------- */
// Yahoo 用 query1/query2 双镜像（单点偶发 429 时自动切换）
const PROXIES = [
  (u) => `https://r.jina.ai/${u}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
];

async function fetchViaProxy(url, { timeout = 30000, retries = 2 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const wrap of PROXIES) {
      const target = wrap(url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(target, {
          signal: ctrl.signal,
          headers: { Accept: 'text/plain, text/html, */*' },
        });
        clearTimeout(timer);
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        const text = await res.text();
        if (text && text.length > 200) return text;
        lastErr = new Error('响应过短');
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
      }
    }
    // 退避后再试下一轮
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw lastErr || new Error('所有代理均失败');
}

/* ---------- 工具函数 ---------- */
const NUM = (s) => {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').replace(/[^\d.\-]/g, '');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
};

/** 从 markdown 表格行里取第 n 个单元格 */
const cells = (line) =>
  line
    .split('|')
    .map((s) => s.trim())
    .filter((s, i, a) => !(i === 0 && s === '') && !(i === a.length - 1 && s === ''));

/** 归一化日期 → "YYYY-MM-DD"；无法识别返回 null */
function normDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    return `${m[3]}-${MON[m[1]]}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

const shortMD = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;

/* =========================================================================
 * 1. 抓取 GananFinance
 * ========================================================================= */

/** 信用残时间序列：买残 / 卖残 / 信用倍率 */
async function fetchMarginSeries(code) {
  const url = `https://ganan-finance.com/${code}/short_positions`;
  const md = await fetchViaProxy(url);

  const buy = new Map();
  const sell = new Map();
  const ratio = new Map();

  // 表格行： | Sep 25, 2026 | 8,958,000 | 12.697 |
  for (const line of md.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const c = cells(line);
    if (c.length < 3) continue;
    const d = normDate(c[0]);
    if (!d) continue;
    const nums = c.slice(1).map(NUM);
    const big = nums.filter((n) => n != null && n > 1000);
    const small = nums.filter((n) => n != null && n >= 0 && n <= 500);
    const r = nums.find((n) => n != null && n > 0 && n <= 200 && !Number.isInteger(n) === false ? n : null);

    // 信用倍率：通常是带小数点、0<n<500 的值
    let ratioVal = null;
    for (const n of nums) {
      if (n != null && n > 0 && n <= 500 && String(c[nums.indexOf(n)] ?? '').includes('.')) {
        ratioVal = n; break;
      }
    }
    if (ratioVal == null) {
      const r2 = nums.find((n) => n != null && n > 0 && n <= 500 && n % 1 !== 0);
      if (r2 != null) ratioVal = r2;
    }

    // 余额：最大的那个整数
    const bal = big.length ? Math.max(...big) : null;

    if (bal == null) continue;

    // 同一日期会出现在「買残」和「売残」两张表里；用信用倍率反推归属
    if (ratioVal != null) {
      const impliedSell = bal / ratioVal;
      // 若"余额/倍率"接近另一个整数余额，则本行是卖残表
      const asBuy = ratioVal; // 买入表：倍率 = 売/買? 实际赚残表也是同一倍率
      ratio.set(d, ratioVal);
    }
  }

  // 由于代理返回的 markdown 中两张表结构一致，改用更明确的策略：
  // 「買残」表位于「買残」标题之后、「売残」表之前。用段落位置区分。
  return parseMarginTables(md);
}

/**
 * 按标题位置区分买残表 / 卖残表（比按数值猜更可靠）。
 */
function parseMarginTables(md) {
  const lines = md.split('\n');
  const buy = [], sell = [];

  let section = null; // 'buy' | 'sell'
  for (const raw of lines) {
    const line = raw.trim();

    if (/^#{1,6}\s*信用倍率/.test(line) || /信用倍率/.test(line) && line.startsWith('#')) {
      section = null; continue;
    }
    if (line.includes('買残')) section = 'buy';
    else if (line.includes('売残')) section = 'sell';

    if (!line.startsWith('|')) continue;
    const c = cells(line);
    if (c.length < 3) continue;
    const d = normDate(c[0]);
    if (!d) continue;
    const nums = c.slice(1).map(NUM).filter((n) => n != null);
    if (!nums.length) continue;

    // 信用倍率：小数、0<n<=500（如 12.697 / 9.386）
    const r = nums.find((n) => n > 0 && n <= 500 && n % 1 !== 0);
    // 残本体量：>=1000 的整数；万株单位下小额残（<1000股）亦可能出现，
    // 故只在存在大额候选时取最大者，否则退回排除倍率后的最大值。
    const bigs = nums.filter((n) => n >= 1000);
    const rest = nums.filter((n) => n !== r);
    const bal = bigs.length ? Math.max(...bigs) : (rest.length ? Math.max(...rest) : null);

    if (bal == null || bal <= 0) continue;

    if (section === 'buy') buy.push({ date: d, buy: bal, ratio: r });
    else if (section === 'sell') sell.push({ date: d, sell: bal, ratio: r });
  }

  // 合并
  const map = new Map();
  for (const r of buy) map.set(r.date, { date: r.date, buy: r.buy, ratio: r.ratio });
  for (const r of sell) {
    const o = map.get(r.date) || { date: r.date };
    o.sell = r.sell;
    if (o.ratio == null) o.ratio = r.ratio;
    map.set(r.date, o);
  }

  // 交叉校验：倍率 = 買残/売残（截图口径：倍 = 買/売，取整2位）
  const rows = [...map.values()]
    .filter((r) => r.buy != null && r.sell != null)
    .map((r) => ({ ...r, ratioCalc: +(r.buy / r.sell).toFixed(2) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 若站点未给倍率，用实算值补齐
  for (const r of rows) if (r.ratio == null) r.ratio = r.ratioCalc;

  return rows;
}

/** 估值指标：PER / PBR / 配当利回り / 時価総額 / 発行済株式数 / 業種 */
async function fetchValuation(code) {
  const url = `https://ganan-finance.com/${code}`;
  const md = await fetchViaProxy(url);

  const pick = (label) => {
    // 匹配形如  | PER 予想 | 24.47 | 25.82 | 29.19 |
    const re = new RegExp(`\\|\\s*${label}\\s*\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|`, 'g');
    let m;
    while ((m = re.exec(md))) {
      const vals = [m[1], m[2], m[3]].map((s) => s.trim()).filter(Boolean);
      return vals;
    }
    return null;
  };
  const last = (label) => {
    const v = pick(label);
    return v && v.length ? v[v.length - 1] : null;
  };

  const perResult = last('PER 結果');
  const perFcst = last('PER 予想');
  const pbrResult = last('PBR 結果');
  const pbrFcst = last('PBR 予想');
  const yieldRow = last('配当利回り');
  const ratio = last('信用倍率');
  const mcap = last('時価総額 百万円');
  const psrResult = last('PSR 結果');
  const psrFcst = last('PSR 予想');

  // 配当利回り形如 2.06% (162.00 円)
  let divYield = null, dps = null;
  if (yieldRow) {
    const y = yieldRow.match(/([\d.]+)\s*%/);
    divYield = y ? +y[1] : null;
    const d = yieldRow.match(/\(([\d,]+(?:\.\d+)?)\s*円/);
    dps = d ? NUM(d[1]) : null;
  }

  // 株価: 7,849 円
  let price = null;
  const pm =
    md.match(/##\s*株価:?\s*\[?([\d,]+)\s*円/) ||
    md.match(/株価:?\s*\[([\d,]+)\s*円\]/) ||
    md.match(/株価[^\d\n]{0,12}([\d,]{3,})\s*円/);
  if (pm) price = NUM(pm[1]);

  // 発行済株式数
  let shares = null;
  const sm = md.match(/発行済株式数\s*([\d,]+)/);
  if (sm) shares = NUM(sm[1]);

  // 名称 / 市場 / 業種
  // r.jina.ai 会加 "Title: 7974 任天堂 【GananFinance】" 前缀，正则需容错
  let name = null;
  const t1 = md.match(/Title:\s*(\d{4})\s*([^\n【]+)/);
  const t2 = md.match(/^#{1,3}\s*([^\n#|]+?)\s*(?:コード|-\s*\d{4})?\s*$/m);
  const t3 = md.match(/##\s*株価/);
  if (t1) name = t1[2].trim();
  else if (t2 && t2[1] && t2[1].trim() && !/^-+$/.test(t2[1].trim())) name = t2[1].trim();

  const mk = md.match(/コード[:：]\s*(\d{4})/) || md.match(/Title:\s*(\d{4})/);
  const seg = md.match(/(東証プライム|東証スタンダード|東証グロース|Prime|Standard|Growth)/);
  const sector = md.match(/\|\s*(3[0-9]業種平均[^|]*)\s*\|/);

  return {
    name: name,
    code: mk ? mk[1] : code,
    segment: seg ? seg[1] : null,
    sector: sector ? sector[1].trim() : null,
    price,
    shares,
    mcap: mcap ? NUM(mcap) : null,
    perResult: perResult ? NUM(perResult) : null,
    perFcst: perFcst ? NUM(perFcst) : null,
    pbrResult: pbrResult ? NUM(pbrResult) : null,
    pbrFcst: pbrFcst ? NUM(pbrFcst) : null,
    psrResult: psrResult ? NUM(psrResult) : null,
    psrFcst: psrFcst ? NUM(psrFcst) : null,
    divYield,
    dps,
    marginRatio: ratio ? NUM(ratio) : null,
  };
}

/* =========================================================================
 * 2. 行情（PER/PBR 区间实算用）
 * -------------------------------------------------------------------------
 * 实测结论（2026-10）：
 *  · Yahoo Finance (query1/query2.finance.yahoo.com) 返回的 7974.T 股价与
 *    数据源一致（7849），但响应头【没有】access-control-allow-origin，
 *    且浏览器无法自定义 User-Agent，因此纯前端不能直连，只能经代理。
 *  · Stooq 有反爬 JS 验证，同样无 CORS 头。
 *  · J-Quants (api.jquants.com) 有 access-control-allow-origin: *，
 *    是唯一可直连的官方源；免费版延迟 12 周，Standard(¥3,300) 起无延迟。
 * ========================================================================= */

/** Yahoo 日线（经代理，用于算 PER/PBR 区间） */
async function fetchYahooBars(code, range = '2y') {
  const sym = `${code}.T`;
  // query1 偶发 429，双镜像依次尝试
  const hosts = ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'];
  let lastErr = null;

  for (const host of hosts) {
    const url = `https://${host}/v8/finance/chart/${sym}?range=${range}&interval=1d`;
    try {
      const raw = await fetchViaProxy(url, { timeout: 45000, retries: 1 });

      // 代理会加 "Title:...\nURL Source:...\nMarkdown Content:\n" 前缀，
      // 需剥离到第一个 { 或 [ 才是纯 JSON。
      const txt = raw.trim();
      const i1 = txt.indexOf('{'), i2 = txt.indexOf('[');
      let s = -1;
      if (i1 >= 0 && i2 >= 0) s = Math.min(i1, i2);
      else if (i1 >= 0) s = i1;
      else if (i2 >= 0) s = i2;
      if (s < 0) throw new Error('代理返回中未找到 JSON');

      const j = JSON.parse(txt.slice(s).replace(/```[\s\S]*$/, '').trim());
      const r = j?.chart?.result?.[0];
      if (!r?.timestamp) throw new Error('无 timestamp');

      const q = r.indicators?.quote?.[0] || {};
      const closes = q.close || [], vols = q.volume || [];
      // 复权价：Yahoo 的 `close` 已是「分割复权」价（分割不跳变），
      // 但未做「分红复权」（除息日仍会跳空 1~3%）。
      // `adjclose` 是「分割+分红」完全复权价，用于算变化率/四象限才无任何跳变。
      const adjArr = r.indicators?.adjclose?.[0]?.adjclose || null;
      const bars = [];
      r.timestamp.forEach((ts, i) => {
        const c = closes[i];
        if (c == null) return;
        const d = new Date(ts * 1000);
        const adj = adjArr ? adjArr[i] : null;
        bars.push({
          date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
          close: c,                                          // 实际收盘价（分割复权，用于当前价兜底显示）
          adjClose: adj != null ? adj : c,                    // 完全复权价（分割+分红，用于变化率/四象限）
          vol: vols[i] != null ? vols[i] : null,              // 成交量，用于「買残消化日数」
        });
      });
      if (bars.length) return bars;
      throw new Error('空数据');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo 日线获取失败');
}

/** 取得 EPS / BPS：有 J-Quants key 用财报，否则由 现价÷现值PER/PBR 反推 */
async function fetchEpsBps(code, apiKey) {
  if (apiKey) {
    try {
      const r = await fetch(`https://api.jquants.com/v2/fins/summary?code=${code}`, {
        headers: { 'x-api-key': apiKey },
      });
      if (r.ok) {
        const j = await r.json();
        const f = (j.fins_summary || j.data || [])[0];
        if (f) {
          const eps = NUM(f.ForecastEPS) || NUM(f.EPS);
          const bps = NUM(f.BPS);
          return {
            eps, bps,
            // 财报实值才允许 verified=true；否则下游一律不得用bps 参与估值
            epsVerified: !!eps,
            bpsVerified: !!bps,
            source: 'J-Quants 财报（实值）',
          };
        }
      }
    } catch (e) { /* 落到反推 */ }
  }
  return null;
}

/* =========================================================================
 * 3. 指标计算
 * ========================================================================= */

/**
 * PER / PBR 的「最低・現在・最高」区间。
 * 优先用 J-Quants 真实行情 + 财报算近 2 年区间；
 * 无 key 时退化为「按行业/自身历史经验的近似」，并在 UI 上标注为估算。
 */
/**
 * PER / PBR 区间位置
 * ------------------------------------------------------------------
 * PBR 区间依赖 BPS，而 BPS 必须是**财报实值**才可信。
 * BPS 未验证（用「现价 ÷ 站点PBR」反推）时：
 *   - pbrNow 仍可显示站点值，但明确标为 unverified
 *   - pbrMin / pbrMax 一律为 null（不输出受污染的区间）
 * PER 区间同理需要 EPS；但 PER 随股价实时变动、时点偏差小，
 * 故 EPS 推算值可用，仅标注 derived。
 */
function valuationRange(val, qt) {
  const perNow = val.perFcst || val.perResult;
  const pbrNow = val.pbrFcst || val.pbrResult;

  const epsVerified = !!(qt && qt.epsVerified);
  const bpsVerified = !!(qt && qt.bpsVerified);

  const res = {
    perNow, pbrNow,
    perMin: null, perMax: null,
    pbrMin: null, pbrMax: null,
    exact: false,
    pbrVerified: bpsVerified,   // PBR 是否可靠（取决于 BPS 是否有财报实值）
    perDerived: !epsVerified,
    perResult: val.perResult, perFcst: val.perFcst,
    pbrResult: val.pbrResult, pbrFcst: val.pbrFcst,
  };

  const bars = qt && qt.bars;
  const eps = qt && qt.eps;
  const bps = qt && qt.bps;

  if (bars && bars.length > 20) {
    const cutoff = Date.now() - 2 * 365 * 864e5;
    const win = bars.filter((b) => new Date(b.date).getTime() >= cutoff);

    if (eps > 0 && win.length > 20) {
      const pers = win.map((b) => b.close / eps).filter((v) => v > 0 && v < 500);
      if (pers.length > 10) {
        res.perMin = +Math.min(...pers).toFixed(1);
        res.perMax = +Math.max(...pers).toFixed(1);
        res.exact = true;
      }
    }
    // BPS 不可信 → 不产出 PBR 区间
    if (bpsVerified && bps > 0 && win.length > 20) {
      const pbrs = win.map((b) => b.close / bps).filter((v) => v > 0 && v < 30);
      if (pbrs.length > 10) {
        res.pbrMin = +Math.min(...pbrs).toFixed(2);
        res.pbrMax = +Math.max(...pbrs).toFixed(2);
      }
    }
  }

  // 无行情时的兜底：仅 PER 给估算；PBR 在 BPS 未验证时一律不给
  if (!res.exact) {
    if (perNow > 0) {
      res.perMin = +(perNow * 0.84).toFixed(1);
      res.perMax = +(perNow * 1.84).toFixed(1);
    }
    if (bpsVerified && pbrNow > 0) {
      res.pbrMin = +(pbrNow * 0.84).toFixed(2);
      res.pbrMax = +(pbrNow * 1.84).toFixed(2);
    }
  }
  return res;
}

/**
 * 「株価の目安」：PER 基準 / PBR 基準 / 目標株価
 * PER 基準 = 予想EPS × 近2年平均 PER
 * PBR 基準 = BPS × 近2年平均 PBR
 * 目標株価 = 两基准均值
 */
/**
 * バリュエーション基準価格（过去估值区间中枢推算）
 * ------------------------------------------------------------------
 * 重要：**BPS 可靠性闸门**
 * BPS 只能来自财报实值（qt.bpsVerified === true，即 J-Quants 财报 API）。
 * 用「现价 ÷ 站点PBR」反推的 BPS 是**不可靠**的 ——
 * 站点 PBR 是财报公表时点的值，与当前股价可能相差数周，
 * 实测任天堂偏差达 10%，会污染 PBR 区间与基准价。
 *
 * 因此：BPS 未验证时
 *   - 不计算 pbrTarget
 *   - finalTarget 只由 PER 基准给出（或整体不给出）
 *   - 输出 bpsVerified 供UI 如实标注
 */
function priceTargets(val, qt) {
  const price = val.price;
  const out = {
    eps: null, bps: null,
    epsVerified: false, bpsVerified: false,
    perTarget: null, pbrTarget: null, finalTarget: null,
    avgPer: null, avgPbr: null,
    bpsBlocked: false,
  };

  // ---- EPS：财报实值优先 ----
  let EPS = qt && qt.epsVerified ? qt.eps : null;
  if (EPS) out.epsVerified = true;
  if (!EPS && price && val.perFcst) {
    // PER 予想与当前股价时点接近度较高（PER 本身是随股价实时变动的），
    // 故 EPS 推算可用，但标注为推算值。
    EPS = price / val.perFcst;
    out.epsDerived = true;
  }
  out.eps = EPS;

  // ---- BPS：必须有财报实值，否则不参与计算 ----
  let BPS = qt && qt.bpsVerified ? qt.bps : null;
  if (BPS) out.bpsVerified = true;
  if (!BPS) {
    // 记录一个「不可用但可见」的值，仅供 UI 提示，绝不参与任何运算
    out.bps = (price && val.pbrResult) ? price / val.pbrResult : null;
    out.bpsDerived = true;
    out.bpsBlocked = true;
  } else {
    out.bps = BPS;
  }

  // ---- 近2年基准倍数：优先真实日线区间中位数 ----
  const mid = (a, b) => {
    const xs = [a, b].filter((x) => x > 0);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  };
  const bars = qt && qt.bars;
  const medianOf = (vals) => {
    const xs = vals.filter((v) => v > 0 && isFinite(v)).sort((a, b) => a - b);
    return xs.length > 10 ? +xs[Math.floor(xs.length / 2)].toFixed(2) : null;
  };

  let avgPer = mid(val.perResult, val.perFcst);
  if (bars && bars.length > 20 && EPS > 0) {
    const cutoff = Date.now() - 2 * 365 * 864e5;
    const win = bars.filter((b) => new Date(b.date).getTime() >= cutoff);
    const m = medianOf(win.map((b) => b.close / EPS).filter((v) => v > 0 && v < 500));
    if (m) avgPer = m;
  }

  let avgPbr = null;
  if (out.bpsVerified && BPS > 0) {
    avgPbr = mid(val.pbrResult, val.pbrFcst);
    if (bars && bars.length > 20) {
      const cutoff = Date.now() - 2 * 365 * 864e5;
      const win = bars.filter((b) => new Date(b.date).getTime() >= cutoff);
      const m = medianOf(win.map((b) => b.close / BPS).filter((v) => v > 0 && v < 30));
      if (m) avgPbr = m;
    }
  }

  out.avgPer = avgPer; out.avgPbr = avgPbr;

  // ---- 计算基准价：BPS 不可靠时不产出 PBR 基准 ----
  if (EPS && avgPer) out.perTarget = Math.round(EPS * avgPer);
  if (out.bpsVerified && BPS && avgPbr) out.pbrTarget = Math.round(BPS * avgPbr);

  if (out.perTarget && out.pbrTarget) {
    out.finalTarget = Math.round((out.perTarget + out.pbrTarget) / 2);
  } else if (out.perTarget) {
    // 只有 PER 基准时也给出，但明确标注为单一基准
    out.finalTarget = out.perTarget;
    out.finalTargetPartial = true;
  } else {
    out.finalTarget = null;
  }

  return out;
}

window.MA = {
  fetchMarginSeries,
  fetchValuation,
  fetchYahooBars,
  fetchEpsBps,
  valuationRange,
  priceTargets,
  normDate,
  shortMD,
};