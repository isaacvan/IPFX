import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";
import {
  collapseTradeIdeas, evaluateTrader,
  type ChallengeType, type DetectorContext, type DetectorPolicy, type RawDetectorTrade,
} from "../_shared/trader-detector.ts";
import { canonicalEvidence, isFreshEvidence, readAllPages, requiredNumber, tradeStage, resolveAccountLineage, verifiedRuleSnapshot, verifyRiskEvidence, verifyCopyEvidence } from "../_shared/trader-detector-input.ts";

const WORKER_VERSION = "challenge-detector-2.1.0";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalEvidence(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function policyFromRow(row: Record<string, unknown>): DetectorPolicy {
  const thresholds = row.thresholds as Record<string, unknown>;
  const challengeType = row.challenge_type as ChallengeType;
  if (thresholds.inferenceUnit !== 'UTC_TRADING_DAY') throw new Error('UNSUPPORTED_POLICY_INFERENCE_UNIT');
  const required = (name: string): number => {
    return requiredNumber(thresholds[name], `policy:${challengeType}:${name}`);
  };
  return {
    key: `${challengeType}_detector`, version: Number(row.version), challengeType,
    inferenceUnit: 'UTC_TRADING_DAY', minStageDays: required('minStageDays'), minRegimeDays: required('minRegimeDays'),
    calibrated: row.status === "VALIDATED",
    minPotentialEss: required("minPotentialEss"), minPotentialDays: required("minPotentialDays"),
    minPotentialProbability: required("minPotentialProbability"), minConfirmedEss: required("minConfirmedEss"),
    minConfirmedDays: required("minConfirmedDays"), minConfirmedProbability: required("minConfirmedProbability"),
    minConfirmedEdgeBps: required("minConfirmedEdgeBps"), minConfirmedStage: required("minConfirmedStage"),
    minPositiveStages: required("minPositiveStages"), minRegimes: required("minRegimes"),
    maxSymbolHhi: required("maxSymbolHhi"), maxBestIdeaShare: required("maxBestIdeaShare"),
    maxDrawdownFraction: required("maxDrawdownFraction"), maxTailLossMultiple: required("maxTailLossMultiple"),
    maxPortfolioCorrelation: required("maxPortfolioCorrelation"), minCopyIdeas: required("minCopyIdeas"),
    minCopyability: required("minCopyability"), priorMeanBps: required("priorMeanBps"),
    priorStdBps: required("priorStdBps"),
  };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  const cronSecret = Deno.env.get("TRADER_DETECTOR_CRON_SECRET");
  const supplied = request.headers.get("x-detector-secret");
  if (!cronSecret || supplied !== cronSecret) return json({ error: "unauthorised" }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "server configuration missing" }, 503);
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const asOf = new Date().toISOString();
  const claim=await db.rpc('trader_detector_claim_scan');
  if(claim.error) return json({error:'scan lease unavailable'},503);
  if(!claim.data) return json({status:'SCAN_ALREADY_RUNNING'},409);
  const lease=claim.data;

  const { data: run, error: runError } = await db.from("trader_detector_run_log")
    .insert({ status: "RUNNING", worker_version: WORKER_VERSION }).select("id").single();
  if (runError || !run) {
    await db.rpc('trader_detector_finish_scan',{p_lease_token:lease.lease_token,p_after_account_id:lease.after_account_id});
    return json({ error: "run log unavailable" }, 503);
  }

  const errors: Array<{ accountId?: string; error: string }> = [];
  let assessmentsWritten = 0;
  let alertsQueued = 0;

  try {
    const recovery = await db.rpc('trader_detector_recover_abandoned_runs', {p_timeout_minutes:15});
    if (recovery.error) throw recovery.error;
    const [policyResult, accounts] = await Promise.all([
      db.from("trader_detector_policy_versions").select("*").in("status", ["SHADOW_UNCALIBRATED", "VALIDATED"]),
      readAllPages<Record<string, any> & { id: string }>((after, limit) => {
        let query = db.from("trading_accounts").select("id,user_id,starting_balance,status,challenge_type,stage,phase,funded_from_account_id,created_at")
          .in("status", ["active", "passed", "breached"]).lte("created_at", asOf).order("id").limit(limit);
        if (after) query = query.gt("id", after);
        return query;
      }),
    ]);
    if (policyResult.error) throw policyResult.error;

    const policies = new Map<ChallengeType, { id: string; policy: DetectorPolicy }>();
    for (const row of policyResult.data ?? []) {
      if (policies.has(row.challenge_type)) throw new Error("MULTIPLE_CURRENT_POLICIES");
      policies.set(row.challenge_type as ChallengeType, { id: row.id, policy: policyFromRow(row) });
    }
    // Every account remains visible, including failures. Separate attempts are
    // never pooled into invented multi-stage evidence without verified lineage.
    const eligible = accounts.filter((account) => ['infinity','traditional','futures','pac'].includes(account.challenge_type) &&
      (!lease.after_account_id || account.id>lease.after_account_id));
    const targets=eligible.slice(0,50);
    let processed=0;
    let nextCursor=lease.after_account_id;

    for (const account of targets) {
      if(processed>0 && Date.now()-Date.parse(asOf)>40000) break;
      const accountId = String(account.id);
      try {
        const challengeType = account.challenge_type as ChallengeType;
        const policyEntry = policies.get(challengeType);
        if (!policyEntry) throw new Error(`NO_CURRENT_POLICY:${challengeType}`);
        const siblings = accounts.filter((candidate) => candidate.user_id === account.user_id);
        const lineage = resolveAccountLineage(account, accounts);
        const lineageIds = lineage.map(row => String(row.id));
        const balances = new Map(lineage.map(row => [String(row.id), requiredNumber(row.starting_balance,'starting_balance')]));
        const startingBalance = requiredNumber(account.starting_balance, "starting_balance");
        if (startingBalance <= 0) throw new Error("INVALID_STARTING_BALANCE");
        const [tradeRows, flags, copyResult, pacResult, stateResult, snapshots, contractResult] = await Promise.all([
          readAllPages<Record<string, any> & { id: string }>((after, limit) => {
            let query = db.from("trades").select("id,account_id,symbol,side,pnl,pnl_basis,detector_stage,opened_at,closed_at,commission,financing,execution_shortfall,decision_price,market_regime,detector_data_version")
              .in("account_id", lineageIds).eq("status", "closed").lte("closed_at", asOf).order("id").limit(limit);
            if (after) query = query.gt("id", after);
            return query;
          }),
          readAllPages<Record<string, any> & { id: string }>((after, limit) => {
            let query = db.from("trade_safety_flags").select("id,reason,status").in("account_id", lineageIds).eq("status", "open").order("id").limit(limit);
            if (after) query = query.gt("id", after);
            return query;
          }),
          db.from("trader_detector_copyability_snapshots").select("*").eq("trading_account_id", accountId)
            .order("as_of_at", { ascending: false }).limit(1).maybeSingle(),
          challengeType === "pac"
            ? db.from("trader_detector_pac_validations").select("*").eq("trading_account_id", accountId).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          db.from("trader_detector_states").select("state,state_since,assessment_id").eq("trading_account_id", accountId).maybeSingle(),
          readAllPages<Record<string, any> & { id: string }>((after, limit) => {
            let query = db.from("a_book_rule_snapshots").select("*").in("trading_account_id", lineageIds).lte("effective_at", asOf).order("id").limit(limit);
            if (after) query = query.gt("id", after);
            return query;
          }),
          db.from("account_qualification_contracts").select("*").eq("account_id", accountId).maybeSingle(),
        ]);
        if (copyResult.error) throw copyResult.error;
        if (pacResult.error) throw pacResult.error;
        if (stateResult.error) throw stateResult.error;
        if (contractResult.error) throw contractResult.error;

        const costComplete = tradeRows.filter((trade) => trade.commission !== null && trade.financing !== null && trade.execution_shortfall !== null).length;
        const decisionComplete = tradeRows.filter((trade) => trade.decision_price !== null).length;
        const regimeComplete = tradeRows.filter((trade) => Boolean(trade.market_regime)).length;
        const denominator = Math.max(1, tradeRows.length);
        const dataQuality = Math.max(0, 1 - 0.25 * (1 - costComplete / denominator) -
          0.15 * (1 - decisionComplete / denominator) - 0.10 * (1 - regimeComplete / denominator));

        const rawTrades: RawDetectorTrade[] = tradeRows.map((trade) => {
          if (!['buy', 'sell'].includes(trade.side) || !trade.symbol || !Number.isFinite(Date.parse(trade.opened_at)) ||
            !Number.isFinite(Date.parse(trade.closed_at)) || Date.parse(trade.closed_at) < Date.parse(trade.opened_at)) throw new Error(`INVALID_TRADE:${trade.id}`);
          return {
          id: trade.id, accountId: trade.account_id, stage: tradeStage(trade, snapshots.filter(row=>row.trading_account_id===trade.account_id)),
          symbol: trade.symbol, side: trade.side, openedAt: new Date(trade.opened_at), closedAt: new Date(trade.closed_at),
          pnl: requiredNumber(trade.pnl, "pnl"), startingBalance: balances.get(trade.account_id) ?? 0,
          pnlBasis: ['NET_AFTER_COSTS','GROSS_BEFORE_COSTS'].includes(trade.pnl_basis) ? trade.pnl_basis : undefined,
          commission: trade.commission === null ? undefined : requiredNumber(trade.commission, "commission"),
          financing: trade.financing === null ? undefined : requiredNumber(trade.financing, "financing"),
          executionShortfall: trade.execution_shortfall === null ? undefined : requiredNumber(trade.execution_shortfall, "execution_shortfall"),
          regime: trade.market_regime,
        }; });
        const ideas = collapseTradeIdeas(rawTrades);
        const sourceCutoff = tradeRows.length ? new Date(Math.max(...tradeRows.map(trade=>Date.parse(trade.closed_at)))).toISOString() : String(account.created_at);
        const inputSha256 = await sha256({workerVersion:WORKER_VERSION,account,lineage,siblings,policy:policyEntry.policy,
          trades:tradeRows,flags,snapshots,contract:contractResult.data,sourceCutoff});
        const [forecastResult,riskResult] = await Promise.all([
          db.from('trader_detector_forecasts').select('*,calibration:trader_detector_calibrations(*)')
            .eq('trading_account_id',accountId).eq('policy_id',policyEntry.id).eq('input_sha256',inputSha256)
            .lte('predicted_at',asOf).gt('expires_at',asOf).order('predicted_at',{ascending:false}).limit(1).maybeSingle(),
          db.from('trader_detector_risk_reviews').select('*').eq('trading_account_id',accountId)
            .eq('policy_id',policyEntry.id).eq('input_sha256',inputSha256).lte('as_of_at',asOf)
            .gt('expires_at',asOf).order('as_of_at',{ascending:false}).limit(1).maybeSingle(),
        ]);
        if(forecastResult.error) throw forecastResult.error;
        if(riskResult.error) throw riskResult.error;
        const forecast=forecastResult.data;
        const calibration=forecast?.calibration;
        const forecastVerified=!!(policyEntry.policy.calibrated && forecast && calibration &&
          calibration.policy_id===policyEntry.id && Date.parse(forecast.source_cutoff_at)===Date.parse(sourceCutoff) &&
          Date.parse(calibration.approved_at)<=Date.parse(forecast.predicted_at) && Date.parse(calibration.expires_at)>Date.parse(asOf));
        const riskVerified=verifyRiskEvidence(riskResult.data,{accountId,policyId:policyEntry.id,inputSha256,
          now:Date.parse(asOf),maxAgeMs:300000}) && Date.parse(riskResult.data.source_cutoff_at)===Date.parse(sourceCutoff);
        const criticalReasons = new Set(["data_tampering", "cross_account_hedge", "stale_feed_exploit"]);
        const copyFields = ['shadow_ideas','fill_rate','reject_rate','median_slippage_bps','p95_latency_ms','source_net_pnl','destination_net_pnl','portfolio_correlation'];
        const copy = copyResult.data && isFreshEvidence(copyResult.data.as_of_at, Date.parse(asOf), 24 * 3600000) &&
          copyFields.every((key) => copyResult.data[key] !== null && Number.isFinite(Number(copyResult.data[key]))) ? copyResult.data : null;
        const pac = pacResult.data && pacResult.data.reviewed_by &&
          isFreshEvidence(pacResult.data.reviewed_at, Date.parse(asOf), 90 * 86400000) ? pacResult.data : null;
        const ruleSnapshotVerified = tradeRows.length > 0 && tradeRows.every(trade=>verifiedRuleSnapshot(trade,snapshots,{accountId:trade.account_id,challengeType})!==null);
        const context: DetectorContext = {
          challengeType, currentStage: requiredNumber(account.stage, "account_stage"), accountStatus: account.status as DetectorContext["accountStatus"],
          ruleSnapshotVerified, tradeStageVerified: rawTrades.length > 0 && rawTrades.every((trade) => trade.stage > 0),
          markToMarketRiskVerified: riskVerified, calibrationEvidenceVerified: forecastVerified,
          calibratedProbability: forecastVerified ? requiredNumber(forecast.probability,'forecast_probability') : undefined,
          calibratedForecastId: forecastVerified ? forecast.id : undefined,
          dataQuality, unresolvedSevereFlags: flags.length,
          unresolvedCriticalFlags: flags.filter((flag) => criticalReasons.has(String(flag.reason))).length,
          ruleBreach: account.status === "breached", regimeDataAvailable: regimeComplete / denominator >= 0.8,
          calibrationPassed: policyEntry.policy.calibrated,
          providerAuthorised: Boolean(copy?.provider_authorised), reserveCapacityAvailable: Boolean(copy?.reserve_capacity_available),
          portfolioCorrelation: copy ? requiredNumber(copy.portfolio_correlation, "portfolio_correlation") : null,
          copyabilityVerified:verifyCopyEvidence(copy,{accountId,policyId:policyEntry.id,inputSha256,now:Date.parse(asOf),maxAgeMs:300000}),
          copyability: copy ? {
            shadowIdeas: requiredNumber(copy.shadow_ideas, "shadow_ideas"), fillRate: requiredNumber(copy.fill_rate, "fill_rate"), rejectRate: requiredNumber(copy.reject_rate, "reject_rate"),
            medianSlippageBps: requiredNumber(copy.median_slippage_bps, "median_slippage_bps"), p95LatencyMs: requiredNumber(copy.p95_latency_ms, "p95_latency_ms"),
            sourceNetPnl: requiredNumber(copy.source_net_pnl, "source_net_pnl"), destinationNetPnl: requiredNumber(copy.destination_net_pnl, "destination_net_pnl"),
          } : null,
          pacValidation: challengeType === "pac" ? {
            strategyDisclosed: Boolean(pac?.strategy_disclosed), trackRecordVerified: Boolean(pac?.track_record_verified),
            outOfSampleReplicated: Boolean(pac?.out_of_sample_replicated), stressTestPassed: Boolean(pac?.stress_test_passed),
          } : undefined,
        };
        const assessment = evaluateTrader(ideas, context, policyEntry.policy);
        const evidence = { workerVersion: WORKER_VERSION, account, siblings, policy: policyEntry.policy, context,
          trades: tradeRows, flags, snapshots, contract: contractResult.data, copy: copyResult.data, pac: pacResult.data, sourceCutoff,
          forecast:forecastResult.data,risk:riskResult.data };
        // Optional context properties are omitted, never converted into invented numeric evidence.
        const serializableEvidence=JSON.parse(JSON.stringify(evidence));
        const evidenceHash = await sha256(serializableEvidence);

        const assessmentRecord = {
          trading_account_id: accountId, user_id: account.user_id, policy_id: policyEntry.id,
          as_of_at: asOf, source_cutoff_at: sourceCutoff, state: assessment.state,
          probability_status: assessment.metrics.probabilityStatus,
          probability_edge_positive: assessment.metrics.probabilityEdgePositive,
          posterior_mean_bps: assessment.metrics.posteriorMeanBps, posterior_sd_bps: assessment.metrics.posteriorSdBps,
          lower_90_bps: assessment.metrics.lower90Bps, independent_idea_count: assessment.metrics.independentIdeas,
          effective_sample_size: assessment.metrics.effectiveSampleSize, active_trading_days: assessment.metrics.activeTradingDays,
          data_quality: dataQuality, copyability_score: assessment.metrics.copyabilityScore,
          metrics: assessment.metrics, gates: assessment.gates, reasons: assessment.reasons,
          evidence_sha256: evidenceHash, live_enabled: false,
          input_sha256:inputSha256,forecast_id:forecastVerified?forecast.id:null,risk_review_id:riskVerified?riskResult.data.id:null,
          copy_review_id:context.copyabilityVerified?copy.id:null,
          calibrated_future_probability:forecastVerified?requiredNumber(forecast.probability,'forecast_probability'):null,
        };
        const commit = await db.rpc("trader_detector_commit_assessment", {
          p_assessment: assessmentRecord, p_expected_assessment_id: stateResult.data?.assessment_id ?? null,
        });
        if (commit.error) throw commit.error;
        if (commit.data?.inserted) assessmentsWritten++;
        alertsQueued += Number(commit.data?.alerts_queued ?? 0);
      } catch (error) {
        const message = error instanceof Error ? error.message : typeof error==='object' && error!==null && 'message' in error ? String(error.message) : String(error);
        errors.push({ accountId, error: message });
        const failure=await db.rpc('trader_detector_record_failure',{p_account_id:accountId,p_as_of_at:asOf,p_error:message});
        if(failure.error) errors.push({accountId,error:'FAILURE_STATUS_WRITE_FAILED'});
      }
      processed++;
      nextCursor=accountId;
    }

    if(processed===eligible.length) nextCursor=null;
    const released=await db.rpc('trader_detector_finish_scan',{p_lease_token:lease.lease_token,p_after_account_id:nextCursor});
    if(released.error) throw released.error;

    const finalStatus = errors.length === 0 ? "COMPLETE" : assessmentsWritten > 0 ? "PARTIAL" : "FAILED";
    const completion=await db.from("trader_detector_run_log").update({
      finished_at: new Date().toISOString(), status: finalStatus, accounts_seen: processed,
      assessments_written: assessmentsWritten, alerts_queued: alertsQueued, errors,
    }).eq("id", run.id);
    if(completion.error) throw completion.error;
    return json({ status: finalStatus, accountsSeen: processed, nextAccountCursor:nextCursor, assessmentsWritten, alertsQueued, errors },errors.length?503:200);
  } catch (error) {
    await db.rpc('trader_detector_finish_scan',{p_lease_token:lease.lease_token,p_after_account_id:lease.after_account_id});
    const message = error instanceof Error ? error.message : String(error);
    await db.from("trader_detector_run_log").update({ finished_at: new Date().toISOString(), status: "FAILED", errors: [{ error: message }] }).eq("id", run.id);
    return json({ error: message }, 500);
  }
});
