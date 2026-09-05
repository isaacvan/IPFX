// ============================================================
// IPFX Capital — alert dedup/cooldown/throttle engine (Phase 3)
//
// report §11: dedup key, cooldown, throttling, quiet hours, retry
// queue, acknowledgement, dead-letter queue, test mode. This module
// is the pure decision logic ("should this alert be suppressed, sent,
// or escalated right now") — actual delivery (email/SMS/push) is a
// separate adapter this module has no dependency on, so it stays
// testable without any network/provider mocking.
//
// NOT EXECUTED IN THIS ENVIRONMENT — see metrics.ts header note.
// ============================================================

export type AlertSeverity = "low" | "medium" | "high" | "critical";

export interface AlertInput {
  alertType: string;
  scope: string;               // e.g. trading_account:<uuid>
  severity: AlertSeverity;
  evidenceHash: string;        // normalized evidence hash, part of the dedup key per report §11.3
  recipientId: string;
  channel: "email" | "sms" | "push" | "in_app";
  testMode?: boolean;
}

export interface AlertRecord {
  dedupKey: string;
  severity: AlertSeverity;
  firstSentAt: Date;
  lastSentAt: Date;
  ackAt: Date | null;
  ackBy: string | null;
  retryCount: number;
  deadLettered: boolean;
}

export interface AlertPolicy {
  cooldownMinutesBySeverity: Record<AlertSeverity, number>;
  maxPerChannelPerHour: number;
  quietHoursUTC: { startHour: number; endHour: number } | null; // suppress non-critical during this UTC window
  ackEscalationMinutes: Record<"high" | "critical", number>;
  maxRetries: number;
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  cooldownMinutesBySeverity: { low: 240, medium: 60, high: 15, critical: 5 },
  maxPerChannelPerHour: 20,
  quietHoursUTC: { startHour: 22, endHour: 7 },
  ackEscalationMinutes: { high: 30, critical: 10 },
  maxRetries: 5,
};

/** report §11.3 — "alert_type + scope + severity_band + normalized evidence hash". */
export function dedupKey(a: Pick<AlertInput, "alertType" | "scope" | "severity" | "evidenceHash">): string {
  return `${a.alertType}|${a.scope}|${a.severity}|${a.evidenceHash}`;
}

export type SendDecision =
  | { action: "send" }
  | { action: "suppress_cooldown"; retryAfter: Date }
  | { action: "suppress_quiet_hours"; retryAfter: Date }
  | { action: "suppress_throttled" }
  | { action: "dead_letter"; reason: string };

function isInQuietHours(now: Date, quiet: AlertPolicy["quietHoursUTC"]): boolean {
  if (!quiet) return false;
  const h = now.getUTCHours();
  return quiet.startHour > quiet.endHour
    ? h >= quiet.startHour || h < quiet.endHour   // window wraps midnight
    : h >= quiet.startHour && h < quiet.endHour;
}

/**
 * Decide what to do with a candidate alert given the existing record
 * (or null if never sent) and how many alerts already went out on this
 * channel in the trailing hour. Pure function — no clock/DB access, so
 * the exact same inputs always produce the exact same decision
 * (required by the "repeated identical alerts deduplicated" acceptance
 * test).
 */
export function decideAlertSend(
  input: AlertInput,
  existing: AlertRecord | null,
  channelSentInTrailingHour: number,
  now: Date,
  policy: AlertPolicy = DEFAULT_ALERT_POLICY
): SendDecision {
  // Critical alerts always bypass quiet hours; everything else respects them.
  if (input.severity !== "critical" && isInQuietHours(now, policy.quietHoursUTC)) {
    const retryAfter = new Date(now);
    retryAfter.setUTCHours(policy.quietHoursUTC!.endHour, 0, 0, 0);
    if (retryAfter <= now) retryAfter.setUTCDate(retryAfter.getUTCDate() + 1);
    return { action: "suppress_quiet_hours", retryAfter };
  }

  if (existing) {
    const cooldownMs = policy.cooldownMinutesBySeverity[input.severity] * 60000;
    const elapsedMs = now.getTime() - existing.lastSentAt.getTime();
    // A severity increase always breaks cooldown (report §11.3: "muted
    // for the configured window unless severity increases").
    if (elapsedMs < cooldownMs && severityRank(input.severity) <= severityRank(existing.severity)) {
      return { action: "suppress_cooldown", retryAfter: new Date(existing.lastSentAt.getTime() + cooldownMs) };
    }
  }

  if (channelSentInTrailingHour >= policy.maxPerChannelPerHour) {
    return { action: "suppress_throttled" };
  }

  if (existing && existing.retryCount >= policy.maxRetries) {
    return { action: "dead_letter", reason: `max_retries_exceeded (${existing.retryCount})` };
  }

  return { action: "send" };
}

function severityRank(s: AlertSeverity): number { return { low: 0, medium: 1, high: 2, critical: 3 }[s]; }

/** report §11.3 — "unacked escalates after X minutes." Returns the
 * escalation target (e.g. a broader on-call channel) or null if the
 * alert doesn't require ack, has been acked, or hasn't timed out yet. */
export function shouldEscalateUnacked(record: AlertRecord, now: Date, policy: AlertPolicy = DEFAULT_ALERT_POLICY): boolean {
  if (record.ackAt) return false;
  if (record.severity !== "high" && record.severity !== "critical") return false;
  const minutesSinceSend = (now.getTime() - record.lastSentAt.getTime()) / 60000;
  return minutesSinceSend >= policy.ackEscalationMinutes[record.severity];
}
