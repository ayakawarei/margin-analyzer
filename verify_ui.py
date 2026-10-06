"""verify_ui.py —— 用真实浏览器验收首页信息层级（285A / 6920 / 7974）

检查项（对应用户 2026-10-06 的四条验收要求）：
  1. 首页没有内部评分数字（无「方向 xx / 100」「风险 xx / 100」）
  2. PER 不再影响信用需给方向（对照 audit 中是否出现 per-high 触发）
  3. 判定ロジック只存在于「信用残詳細」Tab，首页 Tab 中不可见
  4. 首页仍能回答 好坏 / 原因 / 轻重 / 关注点
"""
import json
import os
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:8848/'
CODES = ['285A', '6920', '7974']


def find_chromium():
    """复用本机已缓存的 Chromium，不重复下载。
    本机 playwright 包期望 1234，但缓存里只有 1208 —— 直接指定可执行文件。"""
    cache = Path.home() / 'Library/Caches/ms-playwright'
    cands = []
    if cache.is_dir():
        # 优先 headless shell（更快），回退完整 Chromium
        for pat in ('chromium_headless_shell-*/chrome-headless-shell-mac*/chrome-headless-shell',
                    'chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium'):
            cands += sorted(cache.glob(pat), reverse=True)
    # 也接受环境变量覆盖
    env = os.environ.get('CHROMIUM_PATH')
    if env:
        cands.insert(0, Path(env))
    for c in cands:
        if c.exists():
            return str(c)
    return None


# 首页禁止出现的内部评分模式
FORBIDDEN = [
    (r'方向.{0,12}[-+]?\d+\s*/\s*100', '方向内部分数'),
    (r'リスク.{0,12}\d+\s*/\s*100', '风险内部分数'),
    (r'方向（多空倾向）', '方向依据标题'),
    (r'信用需給リスク', '风险维度标题'),
    (r'评分内部贡献', '旧标题'),
]

results = []

exe = find_chromium()
print('chromium:', exe)

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=exe) if exe else pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1280, 'height': 1400})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text)
            if m.type == 'error' else None)

    for code in CODES:
        page.goto(URL, wait_until='domcontentloaded')
        page.fill('#inp', code)
        page.click('button.primary')
        # 等 Hero 徽章不再是「読み込み中」
        try:
            page.wait_for_function(
                "() => { const b=document.getElementById('hBadge');"
                " return b && !b.textContent.includes('読み込み中'); }",
                timeout=90000)
        except Exception as e:
            results.append({'code': code, 'fatal': 'badge timeout: ' + str(e)})
            continue
        page.wait_for_timeout(1200)

        d = page.evaluate("() => window.__lastD ? {"
                         "  code: window.__lastD.code,"
                         "  grade: window.__lastD.verdict.grade,"
                         "  badge: window.__lastD.verdict.badge,"
                         "  suffix: window.__lastD.verdict.suffix,"
                         "  pos: window.__lastD.verdict.position.label,"
                         "  per: window.__lastD.ind.per.now,"
                         "  quad: window.__lastD.ind.quadrant.key,"
                         "  digest: window.__lastD.ind.digest.days,"
                         "  listed: window.__lastD.ind.borrowRate.buyListed,"
                         "  ratio: window.__lastD.ind.ratio.value,"
                         "  dirHits: window.__lastD.verdict.audit.dirItems.map(x=>x.id),"
                         "  riskHits: window.__lastD.verdict.audit.riskItems.map(x=>x.id),"
                         "  valExcluded: window.__lastD.verdict.audit.valuationExcluded.map(x=>x.id)"
                         "} : null")

        # ---- 首页可见文本 ----
        home_text = page.evaluate(
            "() => { const p=document.getElementById('tab0');"
            " return p ? p.innerText : ''; }")

        # ---- 判定ロジック：应在 tab1，且 details 默认关闭 ----
        logic = page.evaluate("""() => {
          const card = document.getElementById('verdictCard');
          if (!card) return {exists:false};
          const det = card.querySelector('details');
          const tab1 = document.getElementById('tab1');
          return {
            exists: true,
            inTab1: !!(tab1 && tab1.contains(card)),
            hasDetails: !!det,
            open: det ? det.open : null,
            title: card.querySelector('h3') ? card.querySelector('h3').textContent.trim() : '',
            summary: det && det.querySelector('summary') ? det.querySelector('summary').textContent.trim() : '',
            // 展开后的内容（先展开再读）
            inner: det ? det.innerText : '',
          };
        }""")

        # 展开后读内部内容，验证折叠区确实装得下评分明细
        if logic.get('hasDetails'):
            page.evaluate("() => { const d=document.querySelector('#verdictCard details');"
                          " if (d) d.open = true; }")
            page.wait_for_timeout(300)
            logic['inner'] = page.evaluate(
                "() => { const d=document.querySelector('#verdictCard details');"
                " return d ? d.innerText : ''; }")
            # 复位为折叠
            page.evaluate("() => { const d=document.querySelector('#verdictCard details');"
                          " if (d) d.open = false; }")

        # ---- 首页图表数量（只应 1 张：c4） ----
        charts = page.evaluate("""() => {
          const p = document.getElementById('tab0');
          if (!p) return [];
          return Array.from(p.querySelectorAll('div')).filter(e => /^c\\d/.test(e.id)).map(e => e.id);
        }""")

        # ---- 四个问题是否都有答案 ----
        # 「原因」= Hero 徽章下方那句自然语言结论（hWhy），而不是页面上随便哪个词
        why_txt = page.evaluate(
            "() => { const e=document.getElementById('hWhy');"
            " return e ? e.innerText.trim() : ''; }")
        has = {
            '好坏': bool(re.search(r'短期信用需給：', home_text)),
            '信用ポジション': '信用ポジション' in home_text,
            '原因': len(why_txt) >= 15 and '。' in why_txt,
            '轻重': '買残消化日数' in home_text and '発行済' in home_text,
            '倍率': '信用倍率' in home_text,
            '关注点': '注目' in home_text,
            '同期株価': '信用残同期株価' in home_text,
            '買残变化': '信用買残' in home_text,
        }
        # KPI 数量
        kpi_n = page.evaluate("() => document.querySelectorAll('#hKpis .kpi').length")

        # 禁止项扫描
        violations = []
        for pat, label in FORBIDDEN:
            m = re.search(pat, home_text)
            if m:
                violations.append(f'{label}: {m.group(0)[:50]}')

        # 首页是否出现百分比形式的内部分数（xx / 100）
        m100 = re.findall(r'[-+]?\d+\s*/\s*100', home_text)

        results.append({
            'code': code,
            'data': d,
            'home_len': len(home_text),
            'violations': violations,
            'slash100': m100,
            'charts': charts,
            'kpi_n': kpi_n,
            'has': has,
            'why': why_txt,
            'logic': {k: v for k, v in logic.items() if k != 'inner'},
            'logic_inner_len': len(logic.get('inner', '')),
            'logic_has_scores': bool(re.search(r'[-+]?\d+\s*/\s*100', logic.get('inner', ''))),
            'logic_has_excluded': '不参与' in logic.get('inner', ''),
            'home_text': home_text,
        })

    # 首页截图（第一只股票）
    page.goto(URL, wait_until='domcontentloaded')
    page.fill('#inp', '7974')
    page.click('button.primary')
    page.wait_for_timeout(6000)
    page.screenshot(path='/tmp/home_7974.png', full_page=True)
    # 详细页 + 展开判定ロジック
    page.click('button.tab[data-t="1"]')
    page.wait_for_timeout(1500)
    page.evaluate("() => { const d=document.querySelector('#verdictCard details');"
                  " if (d) { d.open = true; d.scrollIntoView(); } }")
    page.wait_for_timeout(900)
    page.screenshot(path='/tmp/detail_7974_logic.png', full_page=True)

    browser.close()

print(json.dumps({'results': results, 'js_errors': errors}, ensure_ascii=False, indent=2))