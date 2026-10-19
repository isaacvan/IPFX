# Individual trader books: recommended mathematical specification

19 October 2026. This document specifies methods and limitations; it does not certify their implementation. No individual trader outcomes were inspected. Source identifiers R1–R9 refer to [RESEARCH.md](RESEARCH.md). Numerical workflow defaults are those in [PREREGISTRATION.md](PREREGISTRATION.md), read during this review. Any stricter validity conditions here are recommendations to the implementation owner, not an unrecorded alteration of that protocol.

## 0. Availability and implementation status

The implementation owner's [DATA_AUDIT.md](DATA_AUDIT.md) reports a frozen cutoff of 18 October 2026 23:10:53 UTC, 1,417 priceable trades and 190 priced people: 186 below 30 trades, four at 30–43, none at 100 or 200. Six shared entry dates, 11–16 October, do not provide full later regime coverage or ten independent daily observations. This snapshot supports no count-eligible reportable/actionable trader. These aggregate facts were read without inspecting individual outcomes.

All equations below are a **recommended specification** unless the implementation status explicitly confirms otherwise. In particular, a documented CS/e-process, full hierarchical posterior, FDR rule or markout formula does not prove the deployed code computes it. Coordination with Hypatia, the statistics implementation owner, on 19 October established the following work-in-progress status; these are owner-reported implementation intentions, not completed-code or test certification:

| Method | Confirmed status at this review cutoff |
| --- | --- |
| `ab_e8_trader_infer` / `ab_e8_trader_adjust` | Implementation in progress; final helper math/results not yet confirmed. A test file exists; that alone does not establish passing tests or a functional SQL migration. |
| Displayed totals versus inference sample | Owner intends to display published cash totals separately from inference on completed UTC close days; expose both counts and name the interval basis. |
| Clustered inference and population prior | Owner intends an approximate day-cluster calculation and a population prior with a matching point-in-time cutoff. Full integration of all uncertainty in (10) is not confirmed. |
| Family correction | Owner specifies BY across both directions and all supplied people, missing evidence p=1. Final eligibility handling and finite-sample/anytime validity are not certified here. |
| Prospective process | Owner is adding immutable registration/append with a fixed bound on **raw daily payoffs**, no clipping, externally enforced bound and complete days required. Historical data does not qualify. This is distinct from the optional clipped-target construction discussed below; neither is assumed operational. |
| Markouts, factor attribution, full posterior, power simulation, DSR/PBO | Formulas/requirements below are recommendations; implementation and verification not established by this review. Six-fill factor fitting remains unsupported. |

Do not fill an unavailable advanced statistic with a normal approximation under the advanced statistic's name. Require the implementation owner to version the final formulas, observation units, assumptions and local test results before claiming any of these advanced outputs are available. Displayed published totals, lag/embargo-eligible inference trades, completed-day trades and prospective evidence blocks may have different counts; report their cutoffs separately.

The audit records automatic approval review rejecting production credential retrieval under an earlier never-handle-credentials instruction. Service-role REST, deployed behavior and autonomous cron verification remain unverified. No live/deployed evidence is claimed by this document.

## 1. Define the claim before estimating it

Index trader by \(i\), trade by \(j\), and completed evidence block by \(d\). Fix the sizing rule, symbol mix policy, entry/exit availability rules, costs, and variant \(v\). For a stable distribution of eligible trades under that policy define

\[
g_i=E[G_{ij}],\quad c_i^A=E[K_{ij}^A],\quad c_i^B=E[K_{ij}^B],
\qquad \theta_i^A=g_i-c_i^A,\quad \theta_i^B=-g_i-c_i^B.
\]

These are mean dollars **per eligible trade** at the specified E8 size, not source-account returns, intrinsic permanent skill, or risk-adjusted alpha. Changing size, symbol weights, horizon, entry availability, or risk policy changes the estimand. A mean of R multiples and a ratio of total dollars to total risk are also different estimands. Mean return per active day is different from mean per trade.

For uncertain, correlated costs, infer \(G-K^A\) and \(-G-K^B\) jointly or model their joint distribution. Do not compare a posterior for gross edge to an uncertain sample cost treated as exact. Never prescribe a positive gross population mean because the brief expects one. Under a positive-cost symmetric model, both directions cannot have strictly positive expected net returns.

Descriptive historical net totals are known sums of simulated trade payoffs conditional on price and cost inputs. An interval around such a total must be named either (a) uncertainty in execution inputs, (b) an interval for \(n\theta\), the expected total of a comparable repeated sample, or (c) a predictive interval for future trading. These are not interchangeable and do not make observed cash P&L random after it is observed.

## 2. Price and reconcile each matched trade

Let source direction \(s_j\in\{-1,+1\}\), lots \(q_j>0\), mid \(m=(a+b)/2\), half-spread \(h=(a-b)/2\), and \(v_j\) be USD per unit price change per lot under a documented linear contract/FX convention. Use the same benchmark entry and exit, \(e,x\), for the paired comparison:

\[
G_j=s_jq_jv_j(m_x-m_e),\qquad
S_j=q_jv_j(h_e+h_x),\qquad K_j=S_j+C_j+\Delta_j.
\]

\(C_j\) is the **round-turn** commission at that size; \(\Delta_j\) is additional execution slippage beyond the side quotes already used. A buy crosses the ask and a sell crosses the bid, at entry and exit. Net under equal directional cost assumptions is

\[
A_j=G_j-K_j,\quad B_j=-G_j-K_j,\quad A_j+B_j=-2K_j. \tag{1}
\]

More generally \(A_j+B_j=-(K_j^A+K_j^B)\) if gross exposures cancel. Asymmetric fills, fees or swaps invalidate equal costs; differing size, execution times, exits, or risk halts can also prevent gross cancellation. Do not force (1) by overwriting independently measured values. Report an explicit reconciliation residual and explain which matching condition failed.

For a synthetic arithmetic fixture, \(G=12,S=2,C=1,\Delta=1\) gives \(A=8,B=-16,A+B=-8\). At \(G=0\), both are \(-4\). This is algebra, not a statement about any person. Sum only the common priced universe for cent reconciliation. Keep original trade/lot order; alternating 0.06/0.07 lots must be assigned globally before grouping by trader, not restarted per row or filter. That alternation is a replay policy, not an optimal sizing rule.

For non-USD quote currency, calculate native contract P&L then apply the explicitly sourced conversion convention. If the model uses one exit FX multiplier, apply it to every component of the identity. Cashflows converted at different times, conversion spreads, nonlinear contracts, or fees in another currency require separate converted cashflows and an FX component. Missing FX/contract/fee evidence means unpriced or cost-incomplete, never a guessed contract multiplier. The index multipliers in the brief require local instrument evidence; exchange futures specifications are not proof of an E8 CFD multiplier.

Calculate at higher precision and round at the ledger's declared aggregation boundary. Require residual within the documented cent-rounding tolerance; do not silently round each component differently. Keep a count of omitted trades and net eligibility, not just a sum of the priced winners/losers.

### Execution benchmark and shortfall

For an order leg \(\ell\), with order direction \(d_\ell\) (+1 buy, −1 sell), executable side quote \(Q_\ell\), fill \(P_\ell\), and its own size/value multiplier,

\[
\Delta_\ell=q_\ell v_\ell d_\ell(P_\ell-Q_\ell).
\]

Positive is unfavorable; negative improvement is permitted. Entry and exit each contribute once. Report missing legs rather than calling an entry-only residual round-turn slippage. A modeled round trip is not a real fill.

Decision-mid implementation shortfall of a leg decomposes as

\[
qv\,d(P-m_{\rm decision})=
qv\,d(m_{\rm delayed}-m_{\rm decision})+qv h_{\rm delayed}
+qv\,d(P-Q_{\rm delayed}). \tag{2}
\]

The first term is signed latency movement, the second spread, and the third residual fill error. Delayed-mid \(G\) plus delayed-side spread already incorporates the first two through the chosen benchmarks. Do not add the entire decision-to-fill shortfall again. Market movement during latency need not always be adverse and can correlate with the leader's signal.

## 3. Availability clocks, variants and risk

Quote selection is the first valid E8 quote **at or after** the named target timestamp within a preregistered maximum lag, with checks for crossed/stale quotes and market closure. Store actual quote timestamp and target-to-quote gap. A five-second markout supported only by a quote sixty seconds later is unavailable at five seconds. No interpolation or carry-forward across an unbounded gap; any permitted tolerance is labeled. Use quote coverage counts at each horizon and stress cell.

The primary sensitivity grid is entry delay 1/2/5/15 seconds, exit delay fixed at five seconds, and additional adverse slippage 0/1/2 ticks **per leg**. For tick size \(\tau_s\), the equal-size round-turn stress is \(2k\tau_s qv\). Use minimum tick, not an ambiguous pip. The legacy 2s/5s, zero additional slippage replay is the reconciliation baseline and an optimistic quote benchmark. It is not an estimated zero cost of real execution and the grid is not a probability interval.

Separate source event time, first observed entry message, route decision, request duration, and fill time. Opening at source-open+2s is achievable only if the entry information was available in time. A ledger's **closed-result** publication lag is not evidence for that entry clock. For historical result features require

\[
t_{\rm decision}>
\max(t_{\rm actual\ publication},t_{\rm close}+120\mathrm{s})+30\mathrm{s}, \tag{3}
\]

using the implementation protocol's current lower bound and embargo. Actual late publication always dominates the fixed delay. Freeze tie ordering. Neither a median lag nor a backfilled timestamp establishes point-in-time availability.

Maintain separate variants for (a) copy source exit after observation/delay, (b) a fixed horizon from the executable entry, and (c) an executable independent bracket. A fixed horizon uses its own exit quote, spread, fee, swap status and label maturity. Never use the maximum favorable excursion as an attainable fixed exit.

If an initial stop is observed before entry, nominal source-stop risk is

\[
R_j=q_jv_j|p_{\rm entry}-p_{\rm stop}|,\quad
G_j^{(R)}=G_j/R_j,\quad A_j^{(R)}=A_j/R_j.
\]

Missing, invalid or zero-distance stops give NULL R. A source stop does not become the reverse stop. Swapping known source stop/target gives the reverse stop at the source target only for the explicitly defined bracket variant, and only if that level is on the correct side of the delayed reverse entry. Copying discretionary exit messages does not establish this bracket risk.

For nominal risk budget \(r\), adverse reverse stop distance \(D_B\), and linear costs excluded for clarity,

\[
q_B=0.01\left\lfloor\frac{r}{0.01vD_B}\right\rfloor. \tag{4}
\]

Enforce actual min/max lots, margin and a fee/slippage allowance; below minimum means skip, not round upward. If \(D_B\) is unavailable, risk-preserving B is unavailable. Stop gaps mean (4) preserves a planned exposure, not a hard realized-loss bound. Compare 1:1 B and risk-preserving B separately; (1) does not apply to their unequal dollar sizes. For spread multiples define the denominator explicitly, e.g. \(G_j/S_j\) using **round-turn** spread dollars; NULL if zero. Do not mix this with price move divided by entry full spread, and distinguish a mean of ratios from a ratio of sums.

Swaps/financing can have either sign. Show known cashflows separately. Unknown overnight costs prevent a fully net claim; zero must not mean unknown. Hard equity limits require unrealized P&L marked to executable closeout prices, the contract's reset clock, margin policy, halts and liquidation costs. Minute sampling can miss an intraminute breach; report unresolved path risk.

## 4. Markouts and dealer interpretation

Anchor on executable copied entry time \(t_e\) and retain a separately named source-entry curve if useful. For \(h\in\{5,30,60,300,900,3600\}\) seconds,

\[
M_j(h)=s_j[m(t_e+h)-m(t_e)],\qquad
M_j^{\$}(h)=q_jv_j M_j(h). \tag{5}
\]

Report price units, \(M_j(h)/(a_e-b_e)\) in entry full-spread multiples, and \(M_j^{\$}(h)/R_j\) where risk is available. Entry spread is fixed as the denominator along a curve. Dollar/R conversions need the stated FX convention. Each horizon has its own valid numerator, denominator, count, mature count and missingness reason. Do not condition the fixed-horizon sample on the source position remaining open: that would select on the future. A horizon beyond the data boundary is not mature. Show actual-source-exit and delayed-copy-exit points separately from fixed horizons.

Positive client-signed markout means an adverse mid movement for a dealer retaining the opposite exposure. Dealer P&L additionally includes collected spread, hedge policy, inventory netting, fees, and financing. A reverse market order pays spread instead of collecting it. Thus neither \(-M\) nor the label B-book alone is an actual internalisation profit calculation.

R8's *Detecting Toxic Flow* instead studies an opportunity within a window. For example a buy label uses

\[
\mathbf1\{\exists u\in[t,t+H]:b(u)>a(t)\}.
\]

That is distinct from (5) and from an observed exit; using the best price in the interval as realized profit introduces hindsight. Label any such opportunity diagnostic accordingly. A positive markout need not imply private information or cover E8 round-turn costs. Markout horizons overlap across trades; day/block dependence and horizon multiplicity remain. Curves are descriptive unless simultaneous bands or preregistered primary-horizon testing are provided.

## 5. Sampling uncertainty with clustered trades

For generic payoff \(Y_{ij}\), gross or directional net, let \(n_i\) be trades, \(D_i\) distinct completed days, \(\bar Y_i=n_i^{-1}\sum_jY_{ij}\), and

\[
U_{id}=\sum_{j\in d}(Y_{ij}-\bar Y_i),\qquad
\widehat{\operatorname{Var}}_{CR1}(\bar Y_i)
=\frac{D_i}{D_i-1}\frac{\sum_dU_{id}^2}{n_i^2}. \tag{6}
\]

This intercept-only cluster estimate permits arbitrary dependence **within** a day but relies on sufficient independent/weakly dependent day clusters. It is undefined at one day. A t interval using \(D_i-1\) degrees of freedom is an approximation, not an exact correction with a handful of clusters. Zero observed variance is not proof of zero uncertainty.

If residual dependence crosses days, preregister longer blocks or, with enough days, use a calendar-ordered HAC meat

\[
\widehat V_{HAC}(\bar Y_i)=n_i^{-2}
\left[\sum_dU_{id}^2+2\sum_{\ell=1}^{L}w_\ell
\sum_{d=\ell+1}^{D_i}U_{id}U_{i,d-\ell}\right],
\quad w_\ell=1-\ell/(L+1). \tag{7}
\]

Do not choose bandwidth by the desired sign/significance. Fix treatment of inactive calendar days. Resample contiguous calendar blocks jointly across all traders to preserve common shocks and serial dependence; an IID trade bootstrap does neither. Overlapping/overnight positions can link days and may require larger blocks. Ten days is an operational floor, not validation of asymptotic inference. When day support is too thin, display a descriptive estimate with unavailable/unreliable inferential precision.

For the same matched sample, covariance matters:

\[
\operatorname{Var}(\bar G-\bar K)=\operatorname{Var}(\bar G)
+\operatorname{Var}(\bar K)-2\operatorname{Cov}(\bar G,\bar K),
\]

with a plus sign on the covariance for \(-\bar G-\bar K\). Estimate net variances directly from paired observations or jointly model both components. Execution parameter uncertainty is additional to (6).

## 6. Hierarchical estimates and honest EB intervals

As a transparent conditional working model, take raw gross estimate \(x_i\), sampling variance \(s_i^2\), and

\[
x_i\mid g_i\sim N(g_i,s_i^2),\qquad g_i\mid\mu,\tau\sim N(\mu,\tau^2).
\]

For **fixed known** hyperparameters and sampling variance,

\[
w_i=\frac{\tau^2}{\tau^2+s_i^2},\quad
m_i=\mu+w_i(x_i-\mu),\quad
v_i=\frac{\tau^2s_i^2}{\tau^2+s_i^2}. \tag{8}
\]

A conditional normal credible interval is \(m_i\pm1.96\sqrt{v_i}\). If costs \(c_i\) are fixed known and equal for both directions,

\[
P(g_i>c_i\mid x_i)=\Phi((m_i-c_i)/\sqrt{v_i}),\quad
P(g_i<-c_i\mid x_i)=\Phi((-c_i-m_i)/\sqrt{v_i}). \tag{9}
\]

These are model-conditional probabilities. If \(\tau=0\), the apparent point posterior in (8) is conditional on a fixed population mean, not proof every individual's edge is known. A zero fitted variance or absent day variance must not yield artificial certainty.

**Recommended uncertainty treatment:** Fit a hierarchical likelihood that includes day/common effects and execution uncertainty, and integrate over \(\mu,\tau\), noise scales, day effects and cost parameters. With all such unknowns denoted \(H\),

\[
\operatorname{Var}(g_i\mid\mathcal D)=
E_H[\operatorname{Var}(g_i\mid H,\mathcal D)]
+\operatorname{Var}_H[E(g_i\mid H,\mathcal D)]. \tag{10}
\]

Plug-in EB omits the second term and usually fixes estimated \(s_i^2\) as well. Label it **conditional EB approximation**, not a fully calibrated 95% posterior interval. If a full model is not implementable, publish raw clustered results, conditional EB with explicit caveats, and sensitivity to prior center/scale and costs. Resampling entire common-day panels and refitting everything is an approximate sensitivity/uncertainty analysis when enough blocks exist, not an exact Bayesian posterior or a cure for six days.

A joint normal approximation for \((g_i,c_i)\) would give
\(\operatorname{Var}(\theta_i^A)=V_g+V_c-2V_{gc}\) and
\(\operatorname{Var}(\theta_i^B)=V_g+V_c+2V_{gc}\).
More generally compute posterior probabilities from joint draws of gross and costs; do not insert the same cost point estimate into every draw. Draw shared execution parameters once per posterior scenario for all affected traders, preserving their common uncertainty. For a future total of \(n'\) independent trades in a simplified model, predictive variance includes \(n' E[\sigma^2\mid\mathcal D]+n'^2\operatorname{Var}(\theta\mid\mathcal D)\), with dependence adding covariance terms. Multiplying an edge interval by \(n'\) gives an expected-total interval only.

Pooling groups and scale should be set before individual outcomes. Pooling heterogeneous symbols/risks without controls can shrink unlike quantities together. A common market factor is not automatically execution error. Exchangeability, normal likelihood, stable edge and enough independent days are assumptions to test and disclose. EB probabilities are neither frequentist p-values nor sequential evidence.

## 7. A valid bounded-observation sequential construction

### 7.1 Preconditions and target

Use a prospective stream \(X_d\) for a **named direction, policy and evidence unit**, with a filtration \(\mathcal F_d\) representing information actually released by step \(d\). Assume a deterministic, preregistered bound
\(-B\le X_d\le B\), and set \(\mu_d=E[X_d\mid\mathcal F_{d-1}]\).
No independence or normality is required for the construction below. Its conditional-mean assumptions must hold in this filtration.

One defensible unit is the total net payoff of a fixed calendar cohort released after **all** its required horizon/exit labels mature. Allow arbitrary intraday dependence inside that cohort. Do not update on each overlapping trade as if it were a fresh independent observation, or reorder trades by realized holding time to release early winners first. Define sequential release and missingness rules before collection. If intermediate information is used to change bets or inclusion, it belongs in the filtration and the conditional null must remain valid with it. Merely renaming dependent trades 'days' does not establish that null.

Dollar market returns, gap-prone stops, and the E8 daily equity gate do not give an almost-sure finite bound on a trade or a cohort. Two honest options are:

1. A genuinely enforced and justified bound on the measured payoff, including execution and gaps. A stop order or observed historical maximum does not suffice.
2. Preregister \(B\) and define \(X_d=\operatorname{clip}(Y_d,-B,B)\). Then the claim concerns the **clipped cohort payoff**, not raw per-trade or raw daily expectancy. Report clipping frequency, raw tails and raw sums separately.

Clipping can change the sign of the mean: a synthetic payoff of +1 with probability 0.99 and −200 with probability 0.01 has raw mean −1.01, but clipping to [−1,1] gives mean +0.98. An actual raw-bound breach invalidates the raw bounded model; enlarging its bound after seeing the breach does not repair past evidence. A tail-bias bound established separately could connect targets through
\(E[Y]-E[X]=E[Y-X]\); without one, no raw-return guarantee follows. If these conditions are unavailable, show `anytime_valid = false`, withhold its p/q evidence and block actionability. Do not silently substitute a normal-theory 'mixture SPRT'.

### 7.2 Confidence sequence with an elementary proof

For a direction-level error budget \(\alpha\), define

\[
\alpha_d=\frac{6\alpha}{\pi^2d^2},\quad
\bar X_D=D^{-1}\sum_{d=1}^D X_d,\quad
b_D=B\sqrt{\frac{2\log(2/\alpha_D)}{D}},
\qquad C_D=[\bar X_D-b_D,\bar X_D+b_D]\cap[-B,B]. \tag{11}
\]

For each deterministic \(D\), conditional Hoeffding's lemma for increments of range \(2B\) and exponential Markov inequality give

\[
P\!\left(\left|\sum_{d=1}^D(X_d-\mu_d)\right|
\ge B\sqrt{2D\log(2/\alpha_D)}\right)\le\alpha_D.
\]

Union bounding over \(D\ge1\), since \(\sum_D\alpha_D=\alpha\), proves simultaneous coverage of
\(\bar\mu_D=D^{-1}\sum_{d=1}^D\mu_d\).
Thus (11) is an anytime-valid CS for the **average past conditional mean**. It becomes a CS for a fixed mean only under the extra condition \(\mu_d=\mu\) for all \(d\). Under drift, positivity of past-average conditional mean does not ensure a positive next-day mean. The conservative width grows as \(\sqrt{\log D/D}\); R6 offers sharper methods under their specified conditions. Replacing \(B\) by an observed SD/max without a new proof is invalid.

### 7.3 Nonnegative e-process and running evidence

For the stronger directional null
\(H_0:E[X_d\mid\mathcal F_{d-1}]\le0\) **at every step**, and a fixed \(\lambda>0\),

\[
E_D(\lambda)=\exp\!\left\{\lambda\sum_{d=1}^D X_d
-\tfrac12\lambda^2B^2D\right\},\quad E_0=1. \tag{12}
\]

Conditional Hoeffding's lemma bounds each multiplicative increment's conditional expectation by one under \(H_0\). Hence this is a nonnegative supermartingale. A fixed mixture remains valid, e.g.

\[
E_D=\frac1{16}\sum_{k=0}^{15}E_D(2^{-k}/B),\qquad
p_D^{\rm any}=\min\{1,1/\max_{0\le d\le D}E_d\}. \tag{13}
\]

Use log-sum-exp for numerical stability and preserve the saved state. Ville's inequality gives \(P_{H_0}(\exists D:E_D\ge1/u)\le u\), so (13) is a valid running anytime p-value. The grid is an **assumed design choice**, not optimized after observing evidence. Predictable adaptive betting is possible with an appropriate proof; it is not permission to select the best observed \(\lambda\) without a correction.

The null in (12) is not merely 'long-run unconditional mean ≤0'. It excludes positive conditional drift at any step. Rejecting it shows evidence against that null for the named bounded stream; it does not establish permanent skill or unbounded raw profitability. If the product's claim instead concerns (11)'s average conditional target, use that CS and its proof rather than claiming these two nulls are identical.

Do not call \(\max_{d\le D}E_d\) an e-value for e-BH. It supports (13) through Ville, but its expectation need not be at most one. For e-BH use current \(E_D\) or an appropriately stopped process. Repeatedly clearing losing history, choosing favorable start dates, or resetting after behavior change requires a new registered hypothesis and a global budget. For example allocate epoch \(r\) a budget proportional to \(6/(\pi^2r^2)\); the sum across epochs must stay within the chosen lifetime budget. Retain old failures and versions.

## 8. Multiple traders, both directions and eligibility

Fix a roster of \(M\) people and primary variant before outcomes; the family has \(m=2M\) directional hypotheses. Extra selected horizons, sizing rules or favorable stress cells enlarge it. Missing/invalid evidence is p=1 internally for a registered hypothesis, accompanied by an unavailable reason in the UI. Do not fit an EB z-score and call its normal tail an anytime p-value.

For valid p-values \(p_{(1)}\le\cdots\le p_{(m)}\), define \(H_m=\sum_{k=1}^m1/k\). BY adjusted values and the rejection rule are

\[
q^{BY}_{(r)}=\min\left(1,\min_{k\ge r}\frac{mH_m}{k}p_{(k)}\right),
\quad r^*=\max\{r:p_{(r)}\le r\alpha/(mH_m)\}. \tag{14}
\]

Reject ranks \(1,\ldots,r^*\); ties need deterministic handling. These are **BY adjusted p-values**, often informally shown as q-values, not Storey estimates or posterior false-skill probabilities. BY controls \(E[V/(R\vee1)]\) under arbitrary dependence when the marginal p-values are valid for the stated nulls. CR1/HAC p-values are approximate and fixed-time; BY does not turn them into finite-sample anytime evidence. For roughly 190 people and two directions the family is about 380, not 190; use the actual registered count, never the number of interesting rows.

If (13) is valid, it remains superuniform at any common dashboard stopping time, since a small value then implies a small value sometime. BY applied to these values supports FDR at that **reported set and time**. It does not automatically control the union of changing candidate sets across arbitrary new rosters, epochs, model versions or all historical alerts. Snapshot FDR is not a guarantee that every displayed candidate is correct or that the realized false fraction is ≤5%.

**Eligibility and post-filtering:** Removing discoveries after BY can increase the false proportion. To claim FDR for final candidates, place all predetermined eligibility checks (sample support, stability, tail, compatibility, relevant posterior/CS checks if used) **before** correction by replacing failed hypotheses' p-values with 1 while retaining the entire \(m\)-hypothesis family, then run BY. This replacement cannot increase the chance a null p-value is small, even when the gate uses data. Do not shrink \(m\) to the passing rows. A later additional selected subset needs a separate guarantee or explicit labeling; display filters must not redefine the FDR family. The target/null of the evidence must still match the claimed candidate meaning; a clipped-day null does not become raw per-trade profitability after BY.

An alternative, **not an extra favorable test**, is e-BH (R5). Sort valid current/stopped e-values descending and choose the largest \(r\) with \(e_{[r]}\ge m/(\alpha r)\). Replace ineligible e-values with zero while retaining \(m\). The expected-null-evidence condition gives arbitrary-dependence FDR. Changing between BY and e-BH based on the observed winners is another selection. Default to the preregistered BY path.

## 9. Power and sample-size gap

The heuristic in R1,

\[
n_{\rm precision}\approx z^2\sigma^2/\delta^2, \tag{15}
\]

is an IID fixed-time precision calculation at a **prespecified** effect margin \(\delta\). For detecting a positive net margin with one-sided level \(\alpha_*\) and desired power \(1-\beta\), a normal approximation is

\[
n_{\rm power}\approx
\frac{(z_{1-\alpha_*}+z_{1-\beta})^2\sigma_{net}^2}{\delta_{net}^2},
\quad MDE\approx(z_{1-\alpha_*}+z_{1-\beta})\sigma_{net}/\sqrt n. \tag{16}
\]

For copy \(\delta_{net}=g-c_A\); for reverse \(\delta_{net}=-g-c_B\). A gross negative edge smaller than costs gives no positive reverse margin; do not return a finite 'more trades until profitable' figure. If using current observed effect for illustration, label it an unstable conditional projection subject to winner selection, not observed/post-hoc power. Prefer an ex ante effect grid and a variance sensitivity range. Round required counts upward and display \(\max(0,\lceil n_{\rm power}\rceil-n)\) only when assumptions/units are meaningful.

For exchangeable within-day dependence with \(k\) trades/day and correlation \(\rho\), a planning approximation is design effect \(1+(k-1)\rho\); unequal cluster size and serial dependence need more complete simulation. A calculation in day units cannot be labeled additional trades without an assumed future frequency. BY's rank-one level \(\alpha/(mH_m)\) is a conservative planning threshold; actual rank is unknown, so do not promise the observed BY hurdle persists. Anytime monitoring has a different boundary and should be planned by simulating that actual procedure, not by relabeling (16).

Report simulation power for positive/negative planted gross effects (including ±0.1R and ±0.3R where R exists), cost scenarios, cluster counts, persistence, shared market/day shocks, rare losses, missingness and behavior changes. Apply the **whole** gate/FDR/monitoring procedure. For replication \(b\), record \(V_b/(R_b\vee1)\); average it to estimate FDR. Give Monte Carlo uncertainty and include all-null and mixed-null configurations. Null false-positive rate alone is not FDR or power. No numerical simulation results are asserted in this document.

## 10. Copy-error factors with six supplied fills

R2's position-error equation is reproduced in RESEARCH. A possible **future local statistical specification**, in normalized unfavorable ticks per order leg, is

\[
\epsilon_\ell=\beta^\top z_\ell+b_{\mathrm{symbol},\mathrm{timeblock}}+u_\ell,
\quad
z_\ell=(1,\sigma_{\rm past}\sqrt{L_\ell}/\tau_s,
\mathrm{spread}_{\rm past}/\tau_s,\mathrm{size},\ldots). \tag{17}
\]

Here \(L\) is latency and \(\sigma\) is price volatility per square-root second. Their square-root scaling is dimensional reasoning under a diffusion approximation, not an empirically established adverse mean. A signed price change may have zero mean while its variance grows with latency. The common component can create cross-order covariance; for latent factor \(f\) with loadings \(\gamma_i\), a model would give \(\operatorname{Cov}(\epsilon_i,\epsilon_k)=\gamma_i^\top\operatorname{Var}(f)\gamma_k\) plus any correlated residual. That equation assumes the residual structure rather than proving it.

With **six fills in total**, (17) is underidentified or extremely unstable once class effects, loadings, residual variance, tails and time effects are included. Six independent fills are not six independent days, six round turns, or six observations per symbol class. No reliable common/idiosyncratic variance split, class quantile, gold-versus-FX law, hour-of-week adjustment, or causal crowding effect follows. Dense quote jumps provide a market-movement proxy; they do not create additional executed-fill observations. Request duration is only one component of total latency.

Current recommendation: show matched raw residuals and their support, separate benchmark gaps, and the fixed tick/delay grid. Any conservative prior is ASSUMED; conservatism does not make it measured or a verified tail bound. A Bayesian fit with six observations must retain strong prior sensitivity and cannot justify an actionable correction. A 0/1/2-tick grid may miss larger losses and is not a stress guarantee.

If later supported, maintain decision-time training windows, freeze coefficients before held-out fills, and evaluate residual bias, coverage, adverse tails and common-time dependence on later orders. Use the same fitted parameter draw for all simultaneous orders in sensitivity simulations. Report common/idiosyncratic attribution strictly as an execution diagnostic; it is not performance, a corrected edge, or a candidate ranking. All performance estimates, comparisons and copy/reverse decisions retain the complete applicable costs. A separately repriced scenario must state its execution assumptions and include all costs under those assumptions.

## 11. Evidence classes and regime/tail checks

Keep one primary class plus independent flags, tier, reasons and missing inputs. Suggested precedence is: unsupported/basic sample -> `INSUFFICIENT_DATA`; with adequate sample, `STOPPED_TRADING`, `E8_INCOMPATIBLE`, `TAIL_RISK`, `UNSTABLE` take precedence over favorable candidate classes; otherwise eligible directional discoveries become `COPY_CANDIDATE` or `REVERSE_CANDIDATE`; demonstrated nonpositive nets on both sides become `COST_BLED`; remaining undetermined cases return `INSUFFICIENT_DATA`. Attach inactivity/compatibility flags even when sample insufficiency wins precedence. This ordering is a recommendation to freeze centrally.

The protocol's <30, 30–99 provisional, ≥100 reportable, ≥200 potentially actionable bands are **policy**, not theorem. Fewer than 30 trades gets no verdict; provisional/reportable estimates cannot be displayed as actionable. The ≥10 completed-day floor, both chronological halves positive **net** in the chosen direction, q≤0.05 and valid sequential support are necessary operational gates but not collectively sufficient if targets/costs/regimes are unsupported. Unknown stability is not stable. No class authorizes routing.

`COST_BLED` requires affirmative support, not \(|\hat g|<\hat c\) alone. With known symmetric cost and a suitable gross interval \([L,U]\), containment \([L,U]\subseteq[-c,c]\) supports both nets being nonpositive under that model. With uncertain/asymmetric costs require joint bounds or simultaneous upper bounds on both directional net means below zero. Name interval type and coverage; adjust for selection/monitoring if used for a formal population claim. A null nondiscovery remains undetermined.

For each direction report chronological halves, weeks, sessions and volatility terciles defined by past-only cutoffs. No observations in a cell means unavailable. Inspect changing trade size/frequency, inactivity (protocol default 14 days), restarts and stopped/breached accounts without dropping them from the denominator. Reset prospective evidence for a predefined change while retaining prior history and multiplicity budgets; never select a fresh window because it looks better.

Tail diagnostics should include raw maximum loss, loss-size SD/CV when defined, skewness/kurtosis with a small-sample warning, and both favorable-tail and adverse-tail concentration. Define a stable denominator, e.g.

\[
T_3^+=\frac{\sum_{\text{largest 3}}\max(s_vG_j,0)}
{\sum_j\max(s_vG_j,0)},\qquad s_v=+1\ (A),\ -1\ (B). \tag{18}
\]

NULL if the denominator is zero. The protocol's >50% favorable-gross share is a review trigger, not a universal risk law. A top-three share of **net total** is unstable or meaningless when the total is near zero/negative; keep any such requested metric separately labeled. A reverse book reliant on rare source losses can fail the account before its rare gain; simulate its actual order path and loss gate.

## 12. Prospective evaluation, portfolio and verification contract

For each entry save the eligible history cutoff, full roster, both directional evidence values, EB/hyperparameter version, cost inputs, regime definitions, bounds, gates, selected class and reasons **before** the trade decision. Only use labels satisfying (3) and horizon maturity. Updating a prior, variance, population denominator, slippage coefficient, threshold, symbol mapping or volatility cut with future data is look-ahead even if the last trade feature is lagged.

Use immutable decision snapshots for later performance. Historical reconstruction after known exploratory filters is descriptive; prospective saved decisions evaluate what was actually known. Report subsequent observations, selected-direction net, active exposure, reversals of class and attrition. Overlapping training/evaluation and stopped traders need explicit denominators. A future-mutation audit must alter outcomes and every fitted upstream dependency, then confirm earlier decisions remain unchanged. Delaying only P&L while fitting priors on the whole sample fails this audit.

Per-trader uncapped dollar sums are additive only before shared constraints. The portfolio is an event-ordered simulation of a single account, with shared lot sequence, margin, fees, equity, daily reset and maximum drawdown, crowding and halts. For selected set \(S\), marginal contribution is \(V(S)-V(S\setminus\{i\})\); it need not equal standalone P&L or sum across traders. Count same-symbol/side overlap and gross/net exposure with units and timestamps. Such crowding exposure is observable; edge lost **because of** own crowding requires an impact/counterfactual model not identified by six fills.

Optional later strategy-search diagnostics must retain the full trial log. DSR compares a measured Sharpe to a selection-adjusted benchmark using sample length and return shape; it is not a raw-edge test and unknown effective trial count prevents a defensible number. PBO selects the best in-sample strategy in each registered split, measures its relative out-of-sample rank \(\omega\) (larger is better), and estimates \(P(\log[\omega/(1-\omega)]\le0)\). Without enough meaningful time blocks/trials this is unavailable. Reality Check/SPA test best-versus-benchmark; Romano–Wolf stepdown controls familywise error. None replaces prospective trading evaluation or automatically controls directional trader FDR.

Required implementation checks, **not claimed as run here**:

- Hand-worked symmetric/asymmetric cost fixtures, negative fill improvements, non-USD conversion, cents, missing legs, global lot alternation and unequal-size variants.
- Fixed-horizon markout coverage/maturity, correct client/dealer sign, and a path that crosses profitable quotes inside a window but is negative at its endpoint, distinguishing R8's toxicity label.
- CR1 undefined at one cluster; EB hyperparameter/cost uncertainty; no artificial certainty from zero variance; no normal-tail p-value labeled anytime.
- Bounded null streams with shared shocks and optional looks; (11) coverage of its actual conditional target; (13) crossing errors; invalid bounds and clipping/raw-sign counterexamples.
- Both directions, whole roster, BY monotonic adjusted values, gates applied before correction, unavailable evidence, resets, low-power alternatives and mixed-null FDR with Monte Carlo uncertainty.
- Future-mutation audits covering priors/regimes/cost fits/roster; exclusions and missingness reconciliation; shared-account halts; parameter provenance and version history.

Account constraints, pricing evidence, source entry availability and sparse-fill calibration still require the implementation owner's audit. Honest output can be unavailable inference and no actionable candidates; it cannot be a precise unsupported probability.
