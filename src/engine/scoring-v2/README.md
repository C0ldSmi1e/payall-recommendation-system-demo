# scoring-v2 · 设计点 → 代码映射

每一条来自 `/scoring-redesign-proposal.md` 的设计点，都在这里列明落在哪个文件哪一个函数。本表是 review 时的 ground-truth：如果某条在这里列了代码位置但实际没实现，算 bug。

## 一、两层结构

| 设计点 | 代码位置 | 函数/符号 |
|---|---|---|
| DisplayScore = FitFraction × MonetaryUplift × SafetyFactor × 100 | `compose.ts` | `computeDisplayScore()` |
| BenchmarkScore(c) 不随用户变 | `benchmark.ts` | `computeBenchmarkScore()` |
| BenchmarkScore 可对外展示（缓存层） | `benchmark.ts` | `buildCardBenchmark()` + `benchmarkCache` |
| PromotedLayer 与打分分离 | `guardrails.ts` | `PROMOTED_CARD_IDS` + `tagPromoted()` |

## 二、十个维度

### 客观基准层（同用户无关）

| 维度 | 代码位置 | 函数 |
|---|---|---|
| IRS · Issuer Reputation | `benchmark.ts` | `computeIssuerReputation()` |
| CP · Cashback Potential | `benchmark.ts` | `computeCashbackPotential()` |
| FB · Fee Burden | `benchmark.ts` | `computeFeeBurden()` |
| RCR · Continuity Risk | `benchmark.ts` | `computeContinuityRisk()` |
| ABR · Approval Base Rate | `benchmark.ts` | `computeApprovalBaseRate()` |

### 用户个性化层

| 维度 | 代码位置 | 函数 |
|---|---|---|
| RCU · Realized Cashback | `fit.ts` | `computeRealizedCashback()` |
| FF · Feature Fit | `fit.ts` | `computeFeatureFit()` |
| CO · Complementarity | `fit.ts` | `computeComplementarity()` |
| LCF · Location/Compliance Fit | `fit.ts` | `computeLocationFit()` |
| PF · Personal Friction | `fit.ts` | `computePersonalFriction()` |

## 三、7 条护栏（对所有用户不变的"大规则"）

| # | 设计点 | 代码位置 | 实现 |
|---|---|---|---|
| G1 | 硬约束硬过滤 | `guardrails.ts` | `enforceHardConstraints()` |
| G2 | IRS < 0.40 最低门槛 | `guardrails.ts` | `enforceReputationThreshold()` + `MIN_REPUTATION = 0.40` |
| G3 | Safety 是乘子不是减数 | `compose.ts` | `computeDisplayScore()` 内部乘法合成 |
| G4 | Promoted slot 走独立渠道 | `guardrails.ts` | `tagPromoted()` + scoring 里**无** `card.id === 23` 硬编码 |
| G5 | score_breakdown 由代码产出 | `breakdown.ts` | `deriveScoreBreakdown()`；LLM 只填 `explanation` |
| G6 | log1p 归一不要硬上限 | `fit.ts` | `normalizeMonetaryUpliftLog()` |
| G7 | 稳定排序 | `index.ts` | `rescoreAndSortV2()` 用 `(score desc, card_id asc)` |

## 四、个性化权重矩阵

| 设计点 | 代码位置 | 符号 |
|---|---|---|
| 10 列 FACTOR_MAP | `factor-map.ts` | `FACTOR_MAP_V2` |
| priority → 10 维权重 | `factor-map.ts` | `mapPreferencesToWeightsV2()` |
| 未识别 factor 告警（不静默） | `factor-map.ts` | `mapPreferencesToWeightsV2()` → `onUnknownFactor` |
| 权重归一 Σ = 1 | `factor-map.ts` | `normalizeWeights()` |

## 五、合成公式

| 设计点 | 代码位置 |
|---|---|
| FitFraction = w.FF·FF + w.CO·CO + w.LCF·LCF | `compose.ts` → `computeFitFraction()` |
| MonetaryUplift = log1p(netUplift)/log1p(REF) | `fit.ts` → `normalizeMonetaryUpliftLog()` |
| SafetyFactor 多重乘法 | `compose.ts` → `computeSafetyFactor()` |
| BenchmarkScore 公式 | `benchmark.ts` → `computeBenchmarkScore()` |

## 六、反馈回写

| 设计点 | 代码位置 |
|---|---|
| `card_country_kyc_stats` 表（驱动 ABR） | `approval-rate.ts` → `approvalStatsStore` + `updateApprovalStats()` |
| Bayesian Beta 更新 | `approval-rate.ts` → `computePosterior()` |
| `issuer_trust_prior` 表（驱动 IRS 动态部分） | `issuer-trust.ts` → `issuerTrustStore` + `recordIssuerEvent()` |
| 种子数据 | `/data/issuer-prior.json` + `/data/approval-stats.json` |

## 七、Harness / 不变量 / 测试

| 设计点 | 代码位置 |
|---|---|
| 所有分数 ∈ [0,1] / [0,100] | `invariants.ts` → `assertRange01()`, `assertScore()` |
| 权重和 = 1 | `invariants.ts` → `assertWeightsSumTo1()` |
| 每次打分产出完整 trace | `types.ts` → `V2Trace` |
| 单元测试（每个维度 + 合成） | `tests/dimensions.test.ts`, `tests/compose.test.ts` |
| v1/v2 对比脚本 | `/src/eval/scoring-compare.ts` |

## 八、植入 pipeline

| 设计点 | 代码位置 |
|---|---|
| `SCORING_VERSION` 开关 | `/src/pipeline.ts` → `rescoreAndSortByVersion()` |
| 保留 v1 可回滚 | `/src/engine/scoring.ts` 不改动 |
| 在 MultiOutcomeCard 上挂 V2 trace | `types.ts` → `V2Trace` + `attachV2Trace()` |

## 九、自验证清单

执行 `bun test src/engine/scoring-v2` 应 100% 绿。
执行 `bun run src/eval/scoring-compare.ts` 应产出 `/data/v1-v2-compare.json`，并在标准输出打印：

- 前 10 张卡在 v1 vs v2 下的排名变化（per user）
- Bit2Go 在 v1 和 v2 下的平均排名（v2 下应该**不再**对所有用户都是第一）
- 分数分布直方图（v2 应该比 v1 分布更宽）
- 不同 priority 人格下 Top3 的差异（应明显不同）

如果 `SCORING_V2_STRICT=1`，出现任何 invariant 违反会抛异常；默认只打警告。
