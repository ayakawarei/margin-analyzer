/* =========================================================================
 * 官方日次信用残通道（配合 server.py 使用）
 * -------------------------------------------------------------------------
 * JPX 自2026-09-28 起「銘柄別信用取引残高」改为每交易日 16:00 公表全銘柄数据，
 * 文件：{dir}/YYYYMMDD_mtall.pdf（YYYYMMDD = 申込日）
 * PDF 抓取受 CORS 限制，浏览器无法直连，故由本地服务解析后以 JSON 提供。
 * ========================================================================= */

const LOCAL_API = (location.protocol === 'file:')
  ? 'http://127.0.0.1:8848'          // 双击打开 HTML 时
  : `${location.protocol}//${location.host}`;  // 由服务托管时

async function fetchOfficialDaily(code, days = 15, fresh = false) {
  const url = `${LOCAL_API}/api/margin?code=${encodeURIComponent(code)}&days=${days}` +
              (fresh ? '&fresh=1' : '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.err || `本地服务返回 HTTP ${r.status}`);
    }
    const j = await r.json();
    if (!j.ok || !j.rows || !j.rows.length) {
      throw new Error(j.err || '本地服务未返回数据');
    }
    return j;
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError') throw new Error('本地服务响应超时（PDF 解析较慢，请稍后重试）');
    throw new Error(
      '无法连接本地服务。请先在同目录运行：python3 server.py'
    );
  }
}

/** 探测本地服务是否在线 */
async function pingLocal() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`${LOCAL_API}/api/health`, { signal: ctrl.signal });
    return r.ok;
  } catch (e) {
    return false;
  }
}

window.MA_OFFICIAL = { fetchOfficialDaily, pingLocal, LOCAL_API };