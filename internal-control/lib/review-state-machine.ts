// ============================================================
// IPFX Capital — review state machine (Phase 1)
//
// Implements report §4.3/§4.4 exactly: the state set, the allowed
// transitions, and the two hard invariants the report treats as
// non-negotiable:
//   1. Only a human (decidedBy = a real user id) may produce a
//      'rejected' outcome — a model/flag can never call
//      transition() into 'rejected' on its own.
//   2. The appeal reviewer must be a different person than whoever
//      made the original decision (assertIndependentReviewer).
//
// This module is pure state-transition logic — no DB access. The
// caller (an edge function or server action) is responsible for
// loading current state, calling transition(), and persisting both
// the new state AND a review_event/audit_event row transactionally.
//
// NOT EXECUTED IN THIS ENVIRONMENT — see metrics.ts header note.
// ============================================================

export type ReviewState =
  | "active" | "objective_met" | "pending_review" | "in_review" | "needs_more_data"
  | "compliance_escalation" | "approved" | "rejected" | "appeal_requested"
  | "appeal_in_review" | "appeal_upheld" | "appeal_overturned";

// report §4.4 — the exact allowed edges. Anything not listed here is
// refused by transition(), which is the actual enforcement point.
const ALLOWED_TRANSITIONS: Record<ReviewState, ReviewState[]> = {
  active: ["objective_met"],
  objective_met: ["pending_review"],
  pending_review: ["in_review"],
  in_review: ["needs_more_data", "approved", "rejected", "compliance_escalation"],
  needs_more_data: ["in_review"],
  compliance_escalation: ["approved", "rejected"],
  approved: [],
  rejected: ["appeal_requested"],
  appeal_requested: ["appeal_in_review"],
  appeal_in_review: ["appeal_upheld", "appeal_overturned"],
  appeal_upheld: [],
  appeal_overturned: [],
};

export type TransitionActor =
  | { kind: "human"; userId: string }
  | { kind: "model"; modelVersion: string }
  | { kind: "system_clock" }; // deadline-driven automatic transitions only (objective_met, or the configured deadline-expiry outcome)

export interface TransitionRequest {
  from: ReviewState;
  to: ReviewState;
  actor: TransitionActor;
  reasonCode?: string;
}

export interface TransitionResult {
  ok: boolean;
  error?: string;
  event?: { fromState: ReviewState; toState: ReviewState; transition: string; timestamp: string };
}

/** report §4.3 reason-code rule: NOT_ELIGIBLE_CAPITAL_INTERNAL must
 * never appear as the reason for an eligibility rejection — it is a
 * separate internal-allocation status. Mirrors the DB trigger
 * fn_block_capital_reason_on_eligibility() in internal-control-core.sql
 * so the same rule is enforced at both the application and data layer
 * (defense in depth, not "the DB will catch it anyway"). */
const CAPITAL_ONLY_REASON_CODE = "NOT_ELIGIBLE_CAPITAL_INTERNAL";

/**
 * The single enforcement point for every review-state change.
 * Throws nothing — returns a discriminated result so callers must
 * handle the failure path explicitly rather than risk an uncaught
 * exception silently skipping the audit write.
 */
export function transition(req: TransitionRequest): TransitionResult {
  const allowed = ALLOWED_TRANSITIONS[req.from] ?? [];
  if (!allowed.includes(req.to)) {
    return { ok: false, error: `illegal_transition: ${req.from} -> ${req.to} is not permitted` };
  }

  // Invariant 1 (report §4.1 / §4.3): only a human may reject.
  if (req.to === "rejected" && req.actor.kind !== "human") {
    return { ok: false, error: "human_required: a model or system actor may never produce a 'rejected' outcome" };
  }
  if (req.to === "compliance_escalation" && req.actor.kind === "model") {
    // A model MAY surface evidence that triggers escalation, but the
    // escalation transition itself must be confirmed by a human per
    // report §4.1 ("a model may generate flags... only a human may
    // issue a rejection, unless there is an explicit deterministic
    // rule violation with complete evidence and a human confirmation
    // step") — escalation is the queue INTO that human step, not a
    // verdict, but we still require a human hand to move the case.
    return { ok: false, error: "human_required: compliance_escalation must be confirmed by a human reviewer, not entered directly by a model" };
  }
  if (req.reasonCode === CAPITAL_ONLY_REASON_CODE && req.to === "rejected") {
    return { ok: false, error: "invalid_reason_code: NOT_ELIGIBLE_CAPITAL_INTERNAL cannot justify an eligibility rejection" };
  }

  return {
    ok: true,
    event: { fromState: req.from, toState: req.to, transition: `${req.from}->${req.to}`, timestamp: new Date().toISOString() },
  };
}

/** report §4.6 — "the same reviewer must not decide the appeal." */
export function assertIndependentReviewer(originalDecidedBy: string, appealDecidedBy: string): TransitionResult {
  if (originalDecidedBy === appealDecidedBy) {
    return { ok: false, error: "independence_violation: the appeal reviewer must differ from the original decision's reviewer" };
  }
  return { ok: true };
}

// ---- report §4.4 time-bound configuration (read from
// review_policy_config at runtime — these are DEFAULTS matching the
// seed data in internal-control-core.sql, used only if the config
// table is unavailable, e.g. in a unit test) ----
export const DEFAULT_REVIEW_POLICY = {
  reviewTargetBusinessDays: 10,
  reviewMaxExtensionBusinessDays: 20,
  needsMoreDataMaxPauseBusinessDays: 10,
  appealWindowBusinessDays: 10,
  // report flags this as [LEGAL: counsel must confirm]. Defaulted to
  // the safer "pending_review" (no auto-approval) until that sign-off
  // is recorded in review_policy_config.legal_signoff_ref — see
  // internal-control-core.sql's review_policy_config seed comment.
  deadlineExpiryDefaultOutcome: "pending_review" as ReviewState,
};

function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

/** report §4.4 — the review case's due date, from objective_met_at. */
export function computeReviewDueDate(objectiveMetAt: Date, policy = DEFAULT_REVIEW_POLICY): Date {
  return addBusinessDays(objectiveMetAt, policy.reviewTargetBusinessDays);
}

/** report §4.6 — appeal window expiry from the rejection decision date. */
export function computeAppealExpiry(rejectedAt: Date, policy = DEFAULT_REVIEW_POLICY): Date {
  return addBusinessDays(rejectedAt, policy.appealWindowBusinessDays);
}
