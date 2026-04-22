# PayAll 打分系统重设计方案

> 版本：v1 · 日期：2026-04-22 · 作者：Daniel
>
> 定位：替代 `src/engine/scoring.ts` 当前的 6 维线性加权，解决"高消费段失真、Bit2Go 硬编码、score_breakdown 与真实公式不一致、无 issuer reputation、无合规/连续性风险"等问题。保留"大规则"（对外可宣称的客观卡评级），同时让每个用户的排名真正个性化。

---

## 一、业务定位重读

PayAll 的产品形态是"加密卡聚合推荐平台"，不是发卡方，因此打分系统必须同时满足三件事：

1. **对外可宣称**：官网明示 "64.3% 用户使用推荐卡后返现更高"、"approval success rate 追踪"——这要求我们有一个**对所有用户都一致的卡客观评级**，而不是每个用户看到的数字都不一样。
2. **真个性化**：同一张 Crypto.com Visa，对"月花 $10k 的美国 cashback 党"和"月花 $500 的东南亚隐私党"，排名应该差距巨大。
3. **业务变现不污染公共信号**：Bit2Go 是自家卡，要 promote，但不能通过在通用打分里加 bonus 来做，否则推荐列表的公信力受损。

## 二、两层结构

把单一 `composite_score` 拆成三件事：

```
DisplayScore(u, c) = 100 × FitFraction(u, c) × MonetaryUplift(u, c) × SafetyFactor(u, c)

BenchmarkScore(c)   — 客观卡评级，所有用户一致，每周离线刷新，对外可展示
FitScore(u, c)      — 用户×卡 的拟合度，每次请求重算，个性化来源
PromotedLayer       — 业务位（Bit2Go 等），独立渠道，UI 明示"由 PayAll 推荐"
```

DisplayScore 是实际排序用的分。BenchmarkScore 不直接参与排序，但它是 SafetyFactor 的主要输入（IssuerReputation、ContinuityRisk 从它来），也是对外"cashback 最强 Top 10"这类榜单的依据。PromotedLayer 不进排序，走单独 UI 插位。

## 三、十个维度

### 客观基准层（与用户无关，每周更新，缓存在 `card_benchmarks` 表）

1. **Issuer Reputation (IRS)** ∈ [0, 1]
   - 输入：发卡年限、BIN sponsor 稳定性、合规/监管事件、历史停服/下架次数、第三方评测聚合。
   - 初版可用 `card.general_ratings / 100` 加上一组人工 issuer trust prior，后续用 `opening_results` 的真实通过率回补。
   - **护栏**：IRS < 0.40 的卡不进推荐池。

2. **Cashback Potential (CP)** ∈ [0, 1]
   - 输入：headline 返现率 × 覆盖 MCC 广度 × cap 宽松度 × 是否需 staking（需要 staking 的封顶 0.6）。
   - 公式：`CP = clamp( 0.6·headline_rate/maxHeadline + 0.25·mcc_breadth + 0.15·cap_generosity ) × (1 - stakingPenalty)`

3. **Fee Burden (FB)** ∈ [0, 1]（越低越好）
   - 输入：annual fee、monthly fee、topup fee、FX fee、ATM fee，全部按参考月花 $3k 折算成年成本。
   - 公式：`FB = clamp( annual_equivalent / referenceBudget )`，referenceBudget = $300/年。

4. **Regulatory / Continuity Risk (RCR)** ∈ [0, 1]（越低越好）
   - 输入：发卡方所在司法辖区监管严格度、BIN sponsor 近期重大事件、历史下架先验、牌照到期时间。
   - 加密卡这一项非常关键：Wirex、Nuri、Binance Card EU、Nexo US 都发生过，不能只看当下。
   - 初版可用 issuer 的 `continuity_prior` 表（人工维护），后续挂 webhook 监听公告。

5. **Approval Base Rate (ABR)** ∈ [0, 1]
   - 来源：`feedback.ts` 的 `opening_results`，按 `(card_id, country, kyc_status)` 分桶聚合，90 天滚动窗口，Bayesian Beta 先验。
   - 当桶内样本 < 20，回退到发卡商级先验。

### 用户个性化层（每次请求计算）

6. **Realized Cashback for User (RCU)** ∈ USD/月
   - **当前系统最大的缺失**。对用户的 `transaction_history` 按 MCC 分类统计，把卡的分级返现率套上去（不是只用 `cashback_max`），再按 monthly cap 截断。
   - `RCU = Σ over MCC: min(cap_mcc, user_spend_mcc × rate_card_mcc)`
   - 这才是 payall 宣称"64.3% 升级返现"的真正来源。

7. **Feature Fit (FF)** ∈ [0, 1]
   - 用户真正需要的硬功能（Apple Pay、虚拟卡、实体卡、ATM、指定加密 topup、跨境支持）中，该卡命中的加权比例。
   - 与当前 `computeFeatureCoverage` 不同之处：**不再把 priorities 当成 needs 双算**（priorities 走权重矩阵，不进 FF 分母）。

8. **Complementarity (CO)** ∈ [0, 1]
   - 对已持卡组合的 gap 填补：支付方式 gap、MCC 覆盖 gap、地区/跨境能力 gap、充值路径 gap。
   - 新用户默认 0.7（不再给 0.8 floor）；完全重复的卡给 0.1（不是现在的 0.3）。

9. **Location × Compliance Fit (LCF)** ∈ [0, 1]
   - 结合 `inferLocation` 结果 × 卡的 disallowed 列表 × 该国 ABR。不是二元，而是"可申请但历史通过率低"这种情况也要降权。

10. **Personal Friction (PF)** ∈ [0, 1]（越低越好）
    - KYC 档位 × 用户 `kyc_verified` 状态 × 用户自己的 `friction_budget` × 是否已在其他卡做过同类 KYC（复用概率）× 可用 topup route 数。

## 四、大规则 / 护栏（对所有用户不变）

1. **硬约束硬过滤**：不合规、disallowed 国家、is_deleted、已持有 → 直接剔除，不进打分。
2. **Issuer Reputation 最低门槛**：IRS < 0.40 不进推荐池，不管个性化分多高。
3. **Safety 是乘子，不是减项**：RCR、IRS、PF 以 `(1 - weight × risk)` 的乘法形式作用，任何一项极差都会把整体分压低，避免"高返现掩盖高风险"。
4. **Promoted slot 走单独渠道**：Bit2Go 这类自家卡不在 scoring.ts 里加 bonus，UI 出一个独立的 "Our pick" 位，明示来源。打分函数里 `if (card.id === 23)` 的硬编码必须删掉。
5. **Score breakdown 由代码产出**：`ScoreBreakdown` 从 scoring.ts 的中间变量直接反推，LLM 只负责写 `explanation` 的自然语言，不负责生成 `score` 数值。
6. **归一化用对数/logistic，不用硬上限**：Savings 走 `log1p`，而不是 `SAVINGS_CEILING_USD = 50` 的硬截断，避免高消费用户全部撞上限。
7. **排序稳定**：分数保留两位小数参与排序，tie-break 用确定性次序（按 card_id 升序）。

## 五、个性化权重矩阵

`FACTOR_MAP` 从 4 列扩成 10 列（每个 priority → 10 个维度权重）。举例（数值是初版，会按 A/B 迭代）：

| priority              | IRS  | CP   | FB   | RCR  | ABR  | RCU  | FF   | CO   | LCF  | PF   |
|-----------------------|------|------|------|------|------|------|------|------|------|------|
| cashback              | 0.05 | 0.10 | 0.10 | 0.05 | 0.05 | 0.40 | 0.10 | 0.05 | 0.05 | 0.05 |
| low_fees              | 0.05 | 0.10 | 0.30 | 0.05 | 0.05 | 0.20 | 0.10 | 0.05 | 0.05 | 0.05 |
| privacy / no_kyc      | 0.10 | 0.05 | 0.05 | 0.05 | 0.20 | 0.05 | 0.15 | 0.05 | 0.10 | 0.20 |
| high_spending_limit   | 0.15 | 0.10 | 0.10 | 0.15 | 0.10 | 0.15 | 0.15 | 0.05 | 0.05 | 0.00 |
| travel_perks          | 0.10 | 0.05 | 0.10 | 0.05 | 0.10 | 0.15 | 0.30 | 0.05 | 0.05 | 0.05 |
| wide_acceptance       | 0.15 | 0.05 | 0.05 | 0.10 | 0.10 | 0.10 | 0.25 | 0.10 | 0.05 | 0.05 |
| security              | 0.25 | 0.05 | 0.05 | 0.25 | 0.10 | 0.05 | 0.15 | 0.05 | 0.05 | 0.00 |
| multi_currency        | 0.10 | 0.05 | 0.05 | 0.05 | 0.05 | 0.15 | 0.35 | 0.10 | 0.05 | 0.05 |
| wechat_alipay         | 0.05 | 0.05 | 0.05 | 0.05 | 0.05 | 0.15 | 0.45 | 0.10 | 0.05 | 0.00 |
| atm_access            | 0.10 | 0.05 | 0.10 | 0.10 | 0.05 | 0.10 | 0.35 | 0.10 | 0.05 | 0.00 |

用户通常有多个 priority，每个带 weight（来自 LLM 的 preference profile），最终权重向量是这些行的加权线性组合，最后归一使 Σ = 1。

**护栏**：若 LLM 返回 FACTOR_MAP 之外的 factor（如 `quick_approval`、`crypto_topup`），落到 DEFAULT_WEIGHTS 并记警告日志——不能静默稀释。

## 六、合成公式

```typescript
// 1. FitFraction: 用户想要的功能/匹配程度
const fitFraction = clamp(
  w.FF * FF + w.CO * CO + w.LCF * LCF
);

// 2. MonetaryUplift: 去掉费用后的净增益，对数归一
const netUplift = RCU - FB_user - currentBestCashbackUsd;
const monetaryUplift = Math.log1p(Math.max(0, netUplift))
                     / Math.log1p(REFERENCE_UPLIFT_USD);  // e.g. $200/mo

// 3. SafetyFactor: 多重安全乘子
const safetyFactor =
    (1 - w.RCR * RCR)
  * (1 - w.IRS * (1 - IRS))       // 注意：IRS 越高越安全
  * ABR                            // approval probability 直接乘
  * (1 - w.PF * PF);

// 4. BenchmarkScore: 对外展示，不参与排序
const benchmarkScore = 100 *
  (0.30*IRS + 0.30*CP + 0.20*(1-FB) + 0.15*(1-RCR) + 0.05*ABR);

// 5. DisplayScore: 实际排序
const displayScore = Math.round(100 *
  fitFraction * monetaryUplift * safetyFactor * 100) / 100;
```

**分布验证**：跑 100 个用户 × 全卡库，期望 `displayScore` p95 > 80，p50 ≈ 50，p10 ≈ 20，比当前全部挤在 30–70 有更好分辨率。

## 七、Score Breakdown（对用户透明）

由代码而非 LLM 产出。每个维度输出一行：

```typescript
interface ScoreBreakdown {
  dimension: "realized_cashback" | "issuer_reputation" | "fee_burden"
           | "approval_probability" | "feature_fit" | "continuity_risk"
           | "complementarity" | "personal_friction";
  label: string;               // i18n 可读名
  score: number;               // 0-100
  weight: number;              // 该用户下的权重
  contribution: number;        // score × weight，反推回 displayScore
  explanation: string;         // 短句，可由 LLM 填自然语言，但 score 数值不动
}
```

UI 上 `contribution` 之和应 ≈ displayScore（在乘法形式下要做对应的拆解，具体见附录 A）。这样用户点 "Why this score" 时看到的每一项都能对上排名。

## 八、反馈回写（让打分越用越准）

反馈事件落两个表：

**`card_country_kyc_stats`**（驱动 ABR）
- 键：(card_id, country_code, kyc_bucket)
- 字段：approvals, rejections, 90d rolling，Bayesian Beta(α, β) 先验。
- 每次 `opening_results` 写入触发更新。

**`issuer_trust_prior`**（驱动 IRS 动态部分）
- 键：issuer
- 字段：总申请数、总通过率、停服事件、用户客诉数（来自 dislike 语义分类）。

**个性化 calibration**（可选 Phase 2）
- 对每个用户做 RCU 的实际回收率学习：如果用户实际拿到的 cashback 持续低于预测的 70%，该用户下的 RCU 预测乘以修正系数。

## 九、迁移路径

**Phase 0（本周，可回滚）**
- 删除 `perception.ts` 里 Bit2Go 硬编码的 +0.05。
- `SAVINGS_CEILING_USD = 50` → log1p 归一。
- `score_breakdown` 改由 scoring.ts 输出，LLM 只填 explanation。
- `computeFeatureCoverage` 停止双算 priorities。
- `RISK_WEIGHT` 从常量改为 per-user 权重。

**Phase 1（1–2 周）**
- 新建 `card_benchmarks` 表，离线算 IRS / CP / FB / RCR。
- `computeSavings` → `computeRealizedCashback`，按 MCC 套分级返现。
- `FACTOR_MAP` 扩到 10 列。
- 新 scoring pipeline 与老的并行跑，dark launch。

**Phase 2（3–4 周）**
- `feedback.ts` 增加 `card_country_kyc_stats` + `issuer_trust_prior` 两张表。
- ABR 接入 scoring。
- Bit2Go 迁移到独立 Promoted slot UI。
- A/B 对比新旧公式下 top3 重合度、用户点击率。

**Phase 3（5–8 周，按 guideline）**
- Multi-head outcome 预测（把 p_apply_success、p_topup_success、p_first_spend_success、retention90 分别建头）。
- Contextual bandit + LP 进 serving 层。

## 十、回滚策略

新旧公式共存至少一个月，通过环境变量 `SCORING_VERSION=v1|v2` 切。若新公式在：
- Top3 点击率下降 > 5%
- Bit2Go impression share 下降 > 20%（分开看，因为这就是我们想调整的）
- p95 displayScore 分布异常

的任一指标上触发回滚。

---

## 附录 A：乘法分解回显示分

当 `DisplayScore = 100 × a × b × c` 时，给用户看的"每个维度贡献多少"要转成加法视图。做法：取 `log` 后各自占比。

```
log(displayScore/100) = log(a) + log(b) + log(c)
contribution_i = log(factor_i) / log(displayScore/100) × displayScore
```

这样 3 个 contribution 和 ≈ displayScore，可视化上和加法模型一致。

## 附录 B：示例人格及其 Top 卡变化

（跑数据后填入。预期：同一张 Crypto.com Visa 在 "cashback_US_heavy" 人格下 score ≈ 85，在 "no_kyc_SEA" 人格下 score < 30。）

## 附录 C：公平性检查

- 对每张卡，在 10 个代表性人格下跑一遍，确认没有卡永远是第一（除非真的全面碾压）。
- 对自家 Bit2Go，打分应落在 benchmark 层的正常分位——如果它排名第一，那是因为 IRS + RCU 真的高，而不是因为硬编码。
