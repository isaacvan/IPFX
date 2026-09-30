// The real-capital mirror may only consume evidence bound to the detector's
// current assessment. Synthetic shadow fills are useful for testing plumbing,
// but cannot establish destination profitability or copyability.
export interface BrokerCopyEvidence {
  id: string;
  as_of_at: string;
  matched_ideas: number | null;
  copyability_lower80: number | null;
  downside_capture: number | null;
  provider_authorised: boolean;
  provenance: Record<string, unknown> | null;
}

export interface BoundCopyAssessment {
  copy_review_id: string | null;
  as_of_at: string;
  state: string;
  probability_status: string;
}

const recent = (timestamp: string, nowMs: number, maxAgeMs: number): boolean => {
  const at = Date.parse(timestamp);
  return Number.isFinite(at) && at <= nowMs && nowMs - at <= maxAgeMs;
};

export function brokerCopyEvidenceReady(
  evidence: BrokerCopyEvidence | null,
  assessment: BoundCopyAssessment | null,
  tier: string,
  targetId: string,
  nowMs: number,
): boolean {
  if (!evidence || !assessment || evidence.id !== assessment.copy_review_id ||
      !recent(evidence.as_of_at, nowMs, 5 * 60_000) ||
      !recent(assessment.as_of_at, nowMs, 15 * 60_000) ||
      !evidence.provider_authorised) return false;
  const p = evidence.provenance;
  if (p?.origin !== "provider_reconciliation_v1" ||
      p?.provider_order_ids_verified !== true ||
      p?.destination_net_pnl_reconciled !== true ||
      p?.authorised_target_id !== targetId ||
      typeof p?.provider_permission_reference !== "string" ||
      p.provider_permission_reference.trim().length < 8 ||
      typeof p.evidence_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.evidence_sha256)) return false;
  const count = Number(evidence.matched_ideas);
  const lower = Number(evidence.copyability_lower80);
  const downside = Number(evidence.downside_capture);
  const minimum = tier === "FULL" ? 300 : tier === "PARTIAL" ? 200 : tier === "MICRO" ? 100 : Infinity;
  if (evidence.matched_ideas === null || evidence.copyability_lower80 === null || evidence.downside_capture === null ||
      !Number.isInteger(count) || count < minimum || !Number.isFinite(lower) || lower < (tier === "MICRO" ? 0.75 : 0.80) ||
      !Number.isFinite(downside) || downside > (tier === "FULL" ? 1.05 : tier === "PARTIAL" ? 1.10 : 1.20)) return false;
  return ["PROFITABILITY_CONFIRMED", "LIVE_REVIEW_REQUIRED"].includes(assessment.state) &&
    assessment.probability_status === "CALIBRATED";
}
