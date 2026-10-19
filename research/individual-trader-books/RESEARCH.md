# Individual trader books: evidence and source audit

Implementation policy check on 19 October 2026: E8's [official Classic/Perpetual trading policy](https://help.e8markets.com/en/articles/6929927-trading-policies-and-prohibited-trading-strategies) states the more-than-50%-under-one-minute restriction and prohibition on hedging across accounts. This supports a Classic-market hold-time review flag; it does not establish written permission for copying external IPFX participants. Product-specific policies and actual account permissions remain separate evidence.

Research reviewed 19 October 2026. This is a methods recommendation, not a report of individual trader performance. No individual outcomes or production database were inspected for this document. The six-fill count, account constraints, instrument specifications, and execution delays below are supplied by the brief; they have not been independently audited here. Aggregate coverage was subsequently checked against the implementation owner's [DATA_AUDIT.md](DATA_AUDIT.md). Implementation and deployment are outside this research assignment.

Read together with [METHODS.md](METHODS.md) and the implementation owner's [PREREGISTRATION.md](PREREGISTRATION.md). The latter's numerical gates are operational choices. Neither a paper nor this review establishes that 200 trades or ten days is sufficient to infer skill.

## 1. Evidence vocabulary

| Label | Meaning and necessary provenance |
| --- | --- |
| EMPIRICAL | An observed finding in the stated study population; external validity to Infinity/E8 is unestablished. |
| THEORY | A mathematical conclusion under a paper's assumptions. It is not an estimated coefficient or demonstrated trading edge here. |
| IDENTITY | Accounting or algebra conditional on matching executions, units, and policies. |
| MEASURED | A local observation with source, timestamp, units, coverage, and sample count. A quote is not an executed fill. |
| FITTED | A parameter estimated from observations; disclose fitting window, dependence, uncertainty, and validation. |
| ASSUMED | A prior, threshold, proxy, scenario, or structural simplification; disclose alternatives and sensitivity. |
| UNKNOWN / UNAVAILABLE | Evidence or a required input is absent. This must not become zero, a successful check, or a measured estimate. |

The supplied files are `../codex-inputs/reverse-copy-economics.txt` and `../codex-inputs/ren-kang-copy-trading-and-price-efficiency.txt`, with paths relative to the repository root. They reside outside this repository. Page references below refer to the extraction's `=== PAGE n ===` markers. The economics extraction contains some duplicated introductory material and damaged currency typesetting; the author's live article was also checked.

## 2. Supplied research and what it warrants

### R1. Phoenix Technologies: reversal economics

**Verified source:** Phoenix Technologies Team, *Reverse Copy Trading: Does Copying the Opposite of a Losing Strategy Work?*, 14 August 2026, [author's article](https://thortradecopier.com/blog/reverse-copy-trading-inverse-strategy). Supplied extraction read in full.

**IDENTITY:** At equal size, matched entry/exit benchmarks, and equal round-turn costs, `A = G - K`, `B = -G - K`, hence `A + B = -2K`. With different costs the sum is `-(K_A + K_B)`; unequal sizes or exit policies need a more general reconciliation. Reversing a negative **net** result does not establish positive reverse expectancy. The threshold concerns the gross edge relative to the receiver's costs.

**ASSUMED / practitioner advice:** The article's minimum sample sizes and claims about how most retail traders lose are not population estimates supported by a study in the article. Retain 30/100/200 as conservative workflow gates only. Its 486-trade illustration measures a $10 gross edge with standard deviation about $110; it does not establish a profitable reverse trade after $16.50 cost. Positive reverse expectancy requires a positive margin above that cost.

**Useful operational reasoning:** Swapped brackets change nominal stop risk, passive orders change fill selection, and hard loss limits can destroy an otherwise positive average payoff. These motivate explicit variants and path simulation. They do not quantify E8 fill quality, legal permission, stop guarantees, or the prevalence of a profitable reverse signal.

### R2. Ren and Kang: copy errors and price efficiency

**Verified identity:** Shiting Ren and Junqing Kang, *Copy Trading and Price Efficiency*, [SSRN 4943691](https://ssrn.com/abstract=4943691), [DOI](https://doi.org/10.2139/ssrn.4943691). SSRN search metadata identifies an April 30, 2025 version. The supplied 80-page extraction was read, including extensions and proofs. Direct SSRN full-text access returned 403/unavailable during this review; the supplied text is the full-text evidence used here. Its revision date was not independently established and it should not be represented as a verified journal publication.

**THEORY:** A static competitive rational expectations model with informed and liquidity leaders, followers, Gaussian shocks, CARA preferences, and biased beliefs about error precision. The supplied paper's Equation (4), extracted page 12, is

\[
X^j_t=\Phi_t\{X_{\mathrm{leader}}+\alpha\delta+
\sqrt{1-\alpha^2}\,\eta_j\},\qquad
\delta,\eta_j\sim N(0,\tau_\delta^{-1}).
\]

The shocks are common and idiosyncratic **position errors**. With independent equal-variance shocks, the correlation of the errors of two followers is **\(\alpha^2\)**, not \(\alpha\). This is not a fitted equation for dollar slippage. A local latency/volatility/spread regression is an engineering hypothesis inspired by the factor structure, not the paper's empirical result.

The hump shape requires particular error and belief conditions: Corollary 1 also permits increasing or decreasing efficiency; Section 3.3 discusses a different outcome with rational beliefs. Section 5.4's alternative error placement even produces an N-shaped fee/efficiency relationship. Section 3.4.3 proposes empirical tests; it does not report a completed causal test of those predictions. The outcome is market price informativeness, not a guaranteed follower profit curve.

**Recommendation:** Track concentration and common execution exposures. With six supplied fills, do not estimate trader-specific loadings, a latent factor covariance matrix, separate class/hour effects, or causal crowding impact. Any common-error decomposition is an attribution diagnostic only. Do not define performance, an edge score, or a candidate ranking by removing common costs; retain those costs in all net performance and decision quantities.

## 3. Verified primary academic sources

### R3. Persistent day-trader skill

Barber, Lee, Liu and Odean (2014), *The Cross-Section of Speculator Skill: Evidence from Day Trading*, **Journal of Financial Markets 18**, 1–24. [Published paper on author's site](https://faculty.haas.berkeley.edu/odean/papers/Day%20Traders/The%20Cross-Section%20of%20Speculator%20Skill.pdf); [DOI](https://doi.org/10.1016/j.finmar.2013.05.006).

**EMPIRICAL:** Taiwan equities, 1992–2006. Ranking on earlier performance predicts subsequent performance; fewer than 1% predictably earn positive abnormal returns after fees. This is not the fraction profitable in any single sample, nor a calibrated prior probability for Infinity traders. Prior poor performers also lose before fees, so the paper does not support the universal claim that losses are only friction. Adopt its ranking/holding separation and gross/net distinction; do not transfer its rates to another venue, contract, or population.

### R4. Skill, luck, and low power

Barras, Scaillet and Wermers (2010), *False Discoveries in Mutual Fund Performance: Measuring Luck in Estimated Alphas*, **Journal of Finance 65(1)**, 179–216. [Author's manuscript and appendix](https://scaillet.ch/pdfs/FDR.pdf); [published identity](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.2009.01527.x).

**EMPIRICAL / METHOD:** Population decomposition and selection using multiple-test ideas in US equity mutual funds. Alpha is defined relative to a factor model. Its estimated zero-alpha mass is not a theorem about retail FX, and a population estimator is not interchangeable with a valid finite-sample per-person q-value.

Andrikogiannopoulou and Papakonstantinou (2019), *Reassessing False Discoveries in Mutual Fund Performance: Skill, Luck, or Lack of Power?*, **Journal of Finance 74(5)**, 2667–2688. [Accepted paper, institutional repository](https://kclpure.kcl.ac.uk/ws/files/107976569/ReassessingFalseDiscoveries.pdf); [publisher](https://onlinelibrary.wiley.com/doi/10.1111/jofi.12784).

**SIMULATION EVIDENCE:** Low signal relative to noise can lead the BSW population estimator to classify genuinely nonzero alphas as zero. This challenges an interpretation of nondiscovery as no skill; it does not invalidate FDR control as an error criterion. Report power and minimum detectable effects. The [BSW reply in its authors' institutional repository](https://archive-ouverte.unige.ch/unige%3A195340) further shows that the magnitude of the issue depends on parameter choices and sample period. No paper justifies turning an insignificant mean into `COST_BLED`.

### R5. Dependence and multiple testing

Benjamini and Yekutieli (2001), *The Control of the False Discovery Rate in Multiple Testing under Dependency*, **Annals of Statistics 29(4)**, 1165–1188. [Author-hosted published paper](https://www.math.tau.ac.il/~yekutiel/papers/dep_annals.pdf); [DOI](https://doi.org/10.1214/aos/1013699998).

**THEORY:** Ordinary BH needs independence or appropriate positive regression dependence (PRDS). Sharing market days does not establish PRDS, especially for opposing directional hypotheses. BY's harmonic correction handles arbitrary dependence given valid marginal p-values. It cannot repair incorrect standard errors, hindsight selection, or invalid repeated-look p-values. Default to BY across **both** directions and the entire frozen family. Storey-style estimates of the null proportion need additional assumptions and adequate information; do not label an unvalidated adaptive estimate a dependence guarantee.

Wang and Ramdas (2022), *False Discovery Rate Control with E-values*, **JRSS B 84(3)**, 822–852. [Author's paper](https://sas.uwaterloo.ca/~wang/papers/2021Wang-Ramdas-JRSSB.pdf); [published article](https://academic.oup.com/jrsssb/article/84/3/822/7056146); [arXiv 2009.02824](https://arxiv.org/abs/2009.02824).

**THEORY / optional alternative:** e-BH permits arbitrary dependence for valid e-values. A current or validly stopped e-process supplies such a value; its running maximum generally does not. Use one preregistered multiplicity method and state its guarantee. A set's FDR target is an expectation of false-discovery proportion, not a posterior error probability for each trader or a realized percentage known in this sample.

### R6. Monitoring and shrinkage

Howard, Ramdas, McAuliffe and Sekhon (2021), *Time-uniform, Nonparametric, Nonasymptotic Confidence Sequences*, **Annals of Statistics 49(2)**, 1055–1080. [Primary preprint, arXiv 1810.08240](https://arxiv.org/abs/1810.08240); [published DOI](https://doi.org/10.1214/20-AOS1991).

**THEORY:** Confidence sequences cover their stated target simultaneously through time under specified stochastic conditions. Continuous refresh alone does not justify an anytime claim. [METHODS.md](METHODS.md) supplies an elementary bounded-observation construction with a proof and an explicit conditional-mean target. Fixed-time normal intervals, a repeated t-test, and a drawdown threshold are not substitutes. Clipping creates a different target; bounds chosen from the observed maximum are invalid.

Efron and Morris (1973), *Stein's Estimation Rule and Its Competitors—An Empirical Bayes Approach*, **JASA 68(341)**, 117–130. [DOI](https://doi.org/10.1080/01621459.1973.10481350); [author's institutional bibliography](https://profiles.stanford.edu/bradley-efron). Bibliographic identity verified; full 1973 article was unavailable through the browser. The conjugate formulas in METHODS are derived explicitly, rather than claimed as a transcription of that article.

**THEORY / MODEL CHOICE:** Pooling can reduce estimation error in the model's regime. Normality, exchangeability, a fixed trader mean, and a population prior are assumptions here. Estimated prior parameters, daily sampling variances, common market exposure, and execution costs are uncertain. Plug-in EB intervals omit those sources of uncertainty. Use integrated hierarchical uncertainty or a clearly labeled conditional EB approximation and sensitivity analysis. Neither the brief nor the literature establishes a positive gross population mean for this population.

### R7. Selection and backtest overfitting

Bailey and López de Prado (2014), *The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting, and Non-normality*. [Author's July 31, 2014 paper](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf). Bailey, Borwein, López de Prado and Zhu, *The Probability of Backtest Overfitting*, [author's February 27, 2015 revision](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf). The latter URL verifies a 2015 manuscript revision; do not infer journal publication year from it.

**METHODS:** DSR adjusts a Sharpe benchmark for selection and return shape; PBO studies in-sample winners' out-of-sample rank across specified splits and trials. Both require the actual strategy search history. They are not valid by setting the number of trials to the number of traders while ignoring tested filters, horizons, and costs. A few days do not support stable skewness/kurtosis or many meaningful splits. Prioritize frozen rules and prospective evaluation; withhold unstable DSR/PBO numbers.

White (2000), *A Reality Check for Data Snooping*, **Econometrica 68**, 1097–1126. [Primary published paper](https://users.ssc.wisc.edu/~behansen/718/White2000.pdf); [DOI](https://doi.org/10.1111/1468-0262.00152). Hansen (2005), *A Test for Superior Predictive Ability*, [author's SSRN manuscript record](https://papers.ssrn.com/sol3/Delivery.cfm?abstractid=264569). Romano and Wolf (2005), *Stepwise Multiple Testing as Formalized Data Snooping*, **Econometrica 73**, 1237–1282, [published paper](https://www.ssc.wisc.edu/~bhansen/718/RomanoWolf2005.pdf).

**THEORY / METHODS:** Reality Check and SPA address the best of a searched family against a benchmark; SPA improves power against irrelevant alternatives. Romano–Wolf stepdown targets familywise error and uses joint dependence. These answer different questions from FDR. Their resampling assumptions and sufficient time blocks must hold; they are not automatic finite-sample cures for six dates. Keep a complete variant log and use chronological evaluation with common-day blocks for any eventual resampling.

### R8. Toxicity: the arXiv IDs checked

| Brief ID | Actual primary source and version checked | What it supports; what it does not |
| --- | --- | --- |
| `2312.05827` | Cartea, Duran-Martin and Sánchez-Betancourt, **Detecting Toxic Flow**. [Abstract and version history](https://arxiv.org/abs/2312.05827); [v2 full text](https://arxiv.org/html/2312.05827v2), revised 16 January 2026; first submitted 10 December 2023. | Empirical FX prediction using client information and PULSE online learning. Section 3 defines toxicity by a profitable unwind becoming possible **at any time within a window**. It is not a fixed-horizon mid markout, actual client exit result, or proof a client is informed. |
| `2407.04510` | Barzykin, Boyce and Neuman, **Unwinding Toxic Flow with Partial Information**. [Abstract and history](https://arxiv.org/abs/2407.04510); [v2 full text](https://arxiv.org/html/2407.04510v2), revised 15 September 2026; first submitted 5 July 2024. | Partial-information stochastic control of aggregate inventory, toxicity and externalisation, with impact and feedback. Section 4.1 supplies institutional FX motivation; control performance comparisons are model scenarios. It is not an empirical per-trader copy/reverse validation on E8. |

Both IDs are relevant to the broad topics in the brief. The limitation is the interpretation, not an unrelated-paper mismatch. Pin versions because the current papers were revised after their original arXiv years. In particular, internalising client flow as a dealer is economically different from opening a reverse market order and paying the spread.

### R9. VPIN and execution costs

Easley, López de Prado and O'Hara (2012), *Flow Toxicity and Liquidity in a High-frequency World*, **Review of Financial Studies 25(5)**, 1457–1493. [Primary manuscript record](https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID2008486_code58370.pdf?abstractid=1695596); [publisher](https://academic.oup.com/rfs/article-abstract/25/5/1457/1569929?login=false).

**EMPIRICAL / METHOD:** VPIN aggregates volume imbalance in volume time. It is not a per-client markout or a calibrated probability that an Infinity trader is skilled. Andersen and Bondarenko's [primary research presentation on perfect trade classification](https://www.fieldsinstitute.ca/programs/scientific/13-14/finance/Andersen.pdf) challenges VPIN's interpretation and incremental predictive content. This is contested evidence, not a reason to add a VPIN score to a sparse dataset. Use directly defined signed markouts first.

Almgren and Chriss, *Optimal Execution of Portfolio Transactions*, [primary December 2000 manuscript](https://www.smallake.kr/wp-content/uploads/2016/03/optliq.pdf). **THEORY:** Execution involves temporary and permanent impact and a cost/risk tradeoff. That distinction informs cost accounting, but the paper does not calibrate retail E8 CFDs. An impact model needs size, depth, participation, and order/fill observations; six fills cannot identify these coefficients. Decision-price implementation shortfall and a delayed quote replay should be reported as different benchmarks to prevent double-counting latency moves.

## 4. Local evidence register and recommended use

The frozen export described in DATA_AUDIT has cutoff **18 October 2026 23:10:53 UTC**: 1,417 priceable trades across six entry dates, 11–16 October, and 190 priced people. Of those people, **186 have fewer than 30 priced trades; four have 30–43; none has 100 or 200**. These are aggregate statements supplied by the implementation audit, not an independent reanalysis of individual outcomes. No person passes the reporting/actionability count gates in that snapshot. Six shared dates do not establish ten independent daily observations or full later regime coverage. These counts describe that frozen snapshot and must not be hardcoded as current live coverage.

DATA_AUDIT records that the production CLI query stalled, and that automatic approval review rejected credential retrieval for service-role REST checks because of the earlier never-handle-credentials instruction. No credential workaround or live verification is claimed here. Production REST access, deployed behavior, owner-session evidence, and autonomous cron successes remain unverified; local methods/tests and a saved frozen fixture cannot establish them.

| Proposed input or output | Current evidential status for this review | Recommended treatment |
| --- | --- | --- |
| Six real fills; 2s entry/5s exit delays | Supplied brief, not independently measured here; unclear whether six fills means six executions or six complete round trips | Preserve raw matching IDs and distinguish legs, orders, trips and independent days. No precise tail estimate or class regression. |
| E8 quote replay, spreads, commission, contract sizes, FX | Local observations/models to audit in implementation | Source every conversion and fee. Separate executable side quotes from mid attribution. Missing is unpriced. |
| 0/1/2 ticks per side; 1/2/5/15s entry delay | ASSUMED stresses | Keep fixed exit delay explicit; no claim these bracket a 95% execution interval. Base zero additional slippage means an optimistic quote benchmark. |
| Common error factor; crowding penalty | ASSUMED specification; no reliable fit from six fills | Display exposure and scenario costs, never inferred causal dollar impact or a skill correction. |
| Normal–normal EB | FITTED conditional model when enough days exist | Disclose prior/sampling/cost uncertainty, pooling group and model checks. No automatic positive-gross prior. |
| Day clustering; tail and stability diagnostics | Approximate estimation / descriptive checks | Hundreds of trades in a few days remain a few clusters. Unknown regime coverage blocks stability claims. |
| Anytime evidence | THEOREM conditional on bounds, filtration, target and null | Unavailable until assumptions and prospective observation protocol are satisfied; clipped evidence must be named as such. |
| `COST_BLED` | A substantive equivalence claim | Require support that both expected nets are nonpositive under the named costs; otherwise label insufficient/undetermined. |
| Swaps, margin, permission, breach risk | UNKNOWN until independently documented | Unknown costs or coarse path coverage block an actionable claim. Account loss gates do not bound trade returns. |

## 5. Recommendations to the implementation owner

1. Build transparent paired cost accounting first; preserve the unfiltered baseline for reconciliation and keep sizing/exit variants separate.
2. Publish raw estimates, conditional EB summaries, and dependence-aware evidence as different outputs. Suppress unsupported probabilities and q-values instead of fabricating precision.
3. Freeze the inference unit, roster, both directional hypotheses, stress policy, availability clocks, clipping/bounds, and reset budget before prospective collection. Use METHODS' explicit validity conditions.
4. Treat six fills as execution observations and a collection plan. Report scenario uncertainty now; fit a common-factor model only after obtaining repeated matched observations across symbols, conditions, and days.
5. Require prospective snapshots and mature labels. Historical reconstruction after exploratory filters is descriptive, even if its replay is technically free of look-ahead.
6. Report null simulation error rates **and** planted-edge power under shared market shocks, clustered days, costs, missingness and behavior change. A null check cannot validate empirical skill.

No individual trader classifications, independently calibrated parameters, production reconciliation, tests of deployed code, or deployment results are claimed by this research review. METHODS distinguishes recommended advanced inference from implementation support confirmed by its owner.
