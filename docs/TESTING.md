# 测试与验收 · TESTING

全部测试命令、覆盖范围与打包一致性检查。技术口径见 [TECHNICAL.md](TECHNICAL.md)，安装与用法见 [README.md](../README.md)。

## 一键跑完

修改 `index.html`、`engine.js`、`engine2.js` 或 `official.js` 后需要重新打包，再跑测试：

```bash
python3 build.py
python3 build.py --check
node test_ratio.mjs
node test_audit.mjs
node test_digest.mjs
node test_audit2.mjs
node test_layer.mjs
node test_correctness.mjs
python3 test_parse.py
python3 test_cache_concurrency.py
python3 test_refresh_round.py
python3 verify_ui.py      # 浏览器验收，失败时返回非 0
```

`build.py` 用**字面量替换**内联本地脚本，避免打包时改变 JavaScript 中的美元符号；`--check` 只检查一致性、不写文件。无需 npm 或前端构建依赖。

## 打包一致性

```bash
python3 build.py            # 生成 日股信用残分析.html
python3 build.py --check    # 校验成品是否与四个源脚本一致（不一致则非 0 退出）
```

成品是发布入口，有意纳入版本控制：**改了源码必须重新打包并一起提交**。

## JS 测试（Node 18+）

| 文件 | 覆盖内容 |
| --- | --- |
| `test_ratio.mjs` | 倍率、股数分母、规则回归 |
| `test_audit.mjs` | 审计输出与规则贡献 |
| `test_digest.mjs` | 买残消化日数回归（20 / 5~19 / <5 样本降级） |
| `test_audit2.mjs` | verdict 与文案一致性 |
| `test_layer.mjs` | 信息层级与「估值 / 信用需給」作用域隔离 |
| `test_correctness.mjs` | **数据正确性核心项**：统一比较窗口、禁止 look-ahead（`priceDate ≤ marginDate`）、1 拆 4 不得触发 `long-surge`、无数据时仓位必须 `unknown`、低可信分母不得触发硬评级、去杠杆不加风险分、`verdict` 与文案不得矛盾、corporate action 全窗口扫描与 confirmed / suspected |

## Python 测试

| 文件 | 覆盖内容 |
| --- | --- |
| `test_parse.py` | PDF 解析回归（固定使用本地 `.cache/20261002_mtall.pdf`，缺失时显示 `SKIP`） |
| `test_cache_concurrency.py` | 多线程缓存安全：同一 PDF 并发下载、不得解析半写文件、失败结果不入缓存、旧请求不得覆盖新缓存；缓存版本闸门（schemaVersion / parserVersion / sourceFingerprint） |
| `test_refresh_round.py` | refresh 上游请求次数回归（A/B/C/D，见下） |

### `test_refresh_round.py` 的 A~D

- **A**：模拟 `run(true)`，a=0 无数据 → fallback a=1 ⇒ 上游 index fetch 只执行 **1 次**（含并发 4 × `fresh=1` 的 single-flight）。
- **B**：fallback 到 a=2（前两次都无数据）⇒ 仍然只抓 1 次上游。
- **C**：普通 `run(false)` 行为不变（结果一致、命中进程缓存时完全不触碰上游、最新日缺失仍回退前一公表日）；warm cache 的 `fresh=1` 不得重解析未变化的 PDF，PDF 真变了才只解析变化的那一天。
- **D**：上游首次失败必须明确报错 / 降级 —— 无数据时返回 502 + `err`；有旧数据时 200 + `stale=true` + `freshServed=false`；上游恢复后能重新变回 fresh。

## 浏览器验收 `verify_ui.py`

真实 Chromium（Playwright），**含断言与非 0 退出码**，失败或出现 JS 错误即 `exit 1`。

```bash
python3 verify_ui.py        # 需要先启动本地服务（默认 http://127.0.0.1:8848）
```

覆盖场景：

1. **多股票切换**（285A / 6920 / 7974 / 3905）：状态码一致、首页无内部评分与 `/100` 分数、恰好 1 张图 + 3 个 KPI、badge 与 grade 一致、`reasonFacts` 非空、改善时文案不矛盾、`unknown` 档不显示绿色「軽い」。
2. **快速连续查询（竞态）**：最终状态必须等于最后请求的股票，页面显示的代码一致。
3. **行情缺失**：非法代码查询后不得残留上一只股票的名称、代码与图表。
4. **refresh**：120s 预算内完成（实测 warm cache 约 5.6s），且**一次 refresh 上游索引抓取 ≤ 1 次**（读取 `/api/health` 的 `upstream.indexFetches` 前后差值）；comparison 仍自洽、仓位档位合法。
5. **数据源切换**：JPX official / Ganan 週次两种模式的来源标注如实（`isOfficial`、`frequency`、`periodUnit=週`）。
6. **公司行动**：`caAffected` 时 status ∈ {confirmed, suspected}，且文案措辞与状态对应（「を検出」vs「可能性があります」）；未触发时 status = `none`。
7. **首页无内部分数 / 无矛盾文案 / 无未来价格**：`priceDate ≤ marginDate`。

> 不要用「把 timeout 调大」代替修性能问题：`verify_ui.py` 的 refresh 预算是 120s，不是 420s。若它超时，先查 `/api/health` 的 `upstream.parses` 是否异常升高。

## 注意事项

- `test_parse.py` 需要本地 `.cache/20261002_mtall.pdf`，缺失时跳过而非失败。
- `verify_ui.py` 依赖本机已缓存的 Playwright Chromium（`~/Library/Caches/ms-playwright`），不重复下载。
- 通过这些测试**不代表**上游抓取、PDF 全字段或整个算法均已完成审计。
