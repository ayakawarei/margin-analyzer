# 更新日志 · CHANGELOG

本文件的格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。这里的版本号对应仓库里的 **Git tag**（`git tag -l`），不代表 GitHub Release；发布说明以 tag 与本文件为准。

## v0.2.0 — 2026-10-07 · `bf846f0`

数据正确性、评级可信度、缓存并发安全与 refresh 性能的集中修复版。**当前稳定基线**（tag `v0.2.0`，commit `bf846f0`）。

### 修复

- **统一比较窗口（unified comparison window）**：价格涨跌幅与买残变化改用同一个 `comparisonWindow`（同一 `from`/`to`），不再出现「价格取 A 区间、买残取 B 区间」；缺价时结果为 `null`，不偷偷扩大窗口。
- **禁止未来价格（no future-price look-ahead）**：价格对齐严格同日优先，缺失时只向**过去**找最近交易日，绝不接受 `priceDate > marginDate`（旧实现会先找 +1 日）。每行记录 `marginDate` / `priceDate` / `isSameDate` 供审计；无同期价格时四象限为 `unknown`。
- **拆并股 fail-safe（split/merge fail-safe）**：读取 Yahoo `events.splits` 精确命中 → `confirmed`；取不到事件数据时遍历比较窗口内**所有相邻 pair** 做启发式判定（买残跳变 > 50% 且复权价变动 < 20%）→ `suspected`。命中即停止方向判定，等级降为 `unknown`，首页给出明确警示。不做数值修正。
- **无数据状态（unknown data state）**：买卖残双空、无同期价格、公司行动命中时，信用ポジション与评级一律 `unknown`（⚪ 判定不能），不再在无依据时显示绿色「軽い」或假绿结论。
- **分母可信度门禁（denominator confidence gating）**：分母带 `{value, type, date, source, stable, confidence, diffPct, usableAsHardTrigger}`；`high`（乖离 ≤20%）/ `unverified`（无法验证）可作为评级硬触发，`low`（乖离 >20%）/ `na` **不得**作为硬触发，只展示并标注「分母可信度不足」。
- **原子写与并发缓存安全（atomic / concurrent cache safety）**：per-date lock、唯一 `.tmp` + `os.replace` 原子替换、PDF 完整性校验（`%PDF` 头 + `%%EOF` 尾 + 最小体积）；下载失败 / 不完整 / 解析异常的结果不写入缓存；`generation` 机制保证旧请求不覆盖新缓存；新增 `schemaVersion` / `parserVersion` / `sourceFingerprint` 版本闸门，解析逻辑变更后旧 JSON 自动失效重解析。
- **refresh 性能（refresh performance fix）**：一次用户主动刷新只刷新一次上游索引 —— 前端仅 `a=0` 带 `fresh=1`，服务端另有 generation + TTL（fresh 120s / 普通 600s / 失败负缓存 30s）+ single-flight 兜底；`fresh=1` 只重解析内容真的变了的 PDF（按来源指纹判断），不再无条件重解析全部公表日。**上游请求次数 3 → 1，单轮耗时 ~350s → ~1s。**

### 其他

- 信息层级重构：PER / PBR 移出信用评分（`VALUATION_SIGNALS` 不计分），内部分数只出现在「判定ロジック」默认折叠区，首页极简。
- 评级结论唯一来源 `creditVerdict`，`buildWhy` 只引用 `reasonFacts`，避免结论与依据矛盾。
- 删除「去杠杆」风险 +10（方向侧保留），避免方向反转时反向加风险分。
- 上游刷新失败时明确报错 / 降级：无数据 → 502 + `err`；有旧数据 → 200 + `stale=true` + `freshServed=false`，页面显示「缓存数据」告警，不伪装成 fresh。
- 前端失败路径补竞态守卫（`mySeq`），切换股票时清空图表，避免旧股票的失败覆盖新结果。
- Ganan 週次源元数据（週次 / `periodUnit=週`）如实传到详情页；footer 修正「JPX 上場比分母 = 上場株式数（非発行済）」。
- `/api/health` 不再抓取 JPX（探测改为显式 `probe=1`），避免健康检查超时导致整页降级；新增 `upstream` 抓取计数便于排查。

### 测试

新增 `test_correctness.mjs`（113 断言）、`test_cache_concurrency.py`（45）、`test_refresh_round.py`（51，A/B/C/D）；`verify_ui.py` 增加 refresh 上游次数断言（65 断言，预算恢复为 120s）。

## [未打标签的早期迭代]

- 截图复刻与基础界面、信用倍率分解、买残消化日数、股价 × 买残四象限。
- 数据源由 Yahoo 免费接口切到本地 JPX 日次后端（`server.py` + `official.js`），Ganan 作为週次回退。
- 单文件打包（`build.py`）与一致性检查。

这些迭代未打标签，`v0.2.0` 之前的提交只作为历史参考。
