// Ingestion must distinguish unknown evidence from a measured zero.
export function requiredNumber(value: unknown, label: string): number {
  if ((typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) throw new Error(`INVALID_NUMBER:${label}`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`INVALID_NUMBER:${label}`);
  return number;
}

export function isFreshEvidence(asOf: unknown, now: number, maxAgeMs: number): boolean {
  if (typeof asOf !== "string" || !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
  const timestamp = Date.parse(asOf);
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= maxAgeMs;
}

export function tradeStage(trade: Record<string, unknown>, snapshots: Array<Record<string, unknown>>): number {
  const opened = Date.parse(String(trade.opened_at));
  if (!Number.isFinite(opened)) return 0;
  const eligible = snapshots.filter((row) => Date.parse(String(row.effective_at)) <= opened)
    .sort((a, b) => Date.parse(String(b.effective_at)) - Date.parse(String(a.effective_at)));
  if (eligible.length > 1 && eligible[0].effective_at === eligible[1].effective_at) return 0;
  const snapshotStage = (eligible[0]?.rules as Record<string, unknown> | undefined)?.stage;
  const explicit = trade.detector_stage;
  if (explicit !== null && explicit !== undefined) {
    const stage = requiredNumber(explicit, "detector_stage");
    return Number.isInteger(stage) && stage > 0 && (snapshotStage === undefined || snapshotStage === stage) ? stage : 0;
  }
  const stage = snapshotStage;
  return typeof stage === "number" && Number.isInteger(stage) && stage > 0 ? stage : 0;
}

export function canonicalEvidence(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("NONFINITE_EVIDENCE");
  if (value instanceof Date || (value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw new Error("NONPLAIN_EVIDENCE");
  if (["function", "symbol", "bigint"].includes(typeof value)) throw new Error("UNSUPPORTED_EVIDENCE");
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalEvidence(item)}`).join(",")}}`;
  if (value === undefined) throw new Error("UNDEFINED_EVIDENCE");
  return JSON.stringify(value);
}

/** A present JSON object does not prove the applicable contractual rule set. */
export function verifiedRuleSnapshot(trade: Record<string, unknown>, snapshots: Array<Record<string, unknown>>,
  binding: { accountId: string; challengeType: string }): Record<string, unknown> | null {
  const opened = Date.parse(String(trade.opened_at));
  const eligible = snapshots.filter((row) => row.trading_account_id === binding.accountId && Date.parse(String(row.effective_at)) <= opened)
    .sort((a, b) => Date.parse(String(b.effective_at)) - Date.parse(String(a.effective_at)));
  const row = eligible[0];
  if (!row || (eligible[1] && Date.parse(String(eligible[1].effective_at)) === Date.parse(String(row.effective_at)))) return null;
  const rules = row.rules as Record<string, unknown> | undefined;
  if (!rules || rules.challenge_type !== binding.challengeType || !row.config_version_id ||
    !Number.isInteger(rules.stage) || Number(rules.stage) <= 0 || tradeStage(trade, eligible) !== rules.stage ||
    !['static','trailing_intraday','trailing_eod'].includes(String(rules.drawdown_mode)) ||
    !['MIDNIGHT_UTC','BROKER_ROLLOVER','ACCOUNT_TIMEZONE'].includes(String(row.anchor_mode)) ||
    !['EQUITY','BALANCE'].includes(String(row.loss_measure))) return null;
  try {
    for (const key of ['max_daily_loss_fraction','max_total_loss_fraction']) {
      const fraction = requiredNumber(row[key], key);
      if (fraction <= 0 || fraction >= 1) return null;
    }
    if (requiredNumber(row.day_anchor_amount, 'day_anchor_amount') <= 0 || requiredNumber(rules.starting_balance, 'starting_balance') <= 0) return null;
  } catch { return null; }
  return row;
}

export interface EvidenceBinding { accountId: string; policyId: string; inputSha256: string; now: number; maxAgeMs: number }
/** Only explicit provisioned parents establish challenge-stage continuity. */
export function resolveAccountLineage<T extends Record<string, unknown>>(account: T, accounts: T[]): T[] {
  const byId = new Map(accounts.map((row) => [String(row.id), row]));
  if (byId.size !== accounts.length) throw new Error('DUPLICATE_ACCOUNT_ID');
  const lineage: T[] = [];
  const visited = new Set<string>();
  let current: T | undefined = account;
  while (current) {
    const id = String(current.id);
    if (visited.has(id)) throw new Error('ACCOUNT_LINEAGE_CYCLE');
    visited.add(id);
    if (current.user_id !== account.user_id || current.challenge_type !== account.challenge_type) throw new Error('ACCOUNT_LINEAGE_OWNER_OR_CHALLENGE');
    const stage = requiredNumber(current.stage, 'lineage_stage');
    if (!Number.isInteger(stage) || stage <= 0) throw new Error('ACCOUNT_LINEAGE_STAGE');
    if (lineage.length > 0) {
      const child = lineage[lineage.length - 1];
      const terminalFunding = stage === Number(child.stage) && child.phase === 'funded' && current.phase === 'evaluation';
      if ((!terminalFunding && stage >= Number(child.stage)) || current.status !== 'passed') throw new Error('ACCOUNT_LINEAGE_UNPASSED_OR_NONINCREASING');
    }
    lineage.push(current);
    if (!current.funded_from_account_id) break;
    const parent = byId.get(String(current.funded_from_account_id));
    if (!parent) throw new Error('ACCOUNT_LINEAGE_MISSING_PARENT');
    current = parent;
  }
  return lineage.reverse();
}
/** Fresh evidence must be bound to the same inputs, account and policy. */
export function verifyBoundEvidence(row: Record<string, unknown> | null, binding: EvidenceBinding): boolean {
  if (!row || row.trading_account_id !== binding.accountId || row.policy_id !== binding.policyId ||
    !/^[a-f0-9]{64}$/i.test(binding.inputSha256) || row.input_sha256 !== binding.inputSha256 ||
    typeof row.audit_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(row.audit_sha256) ||
    typeof row.verified_by !== 'string' || !row.verified_by.trim() ||
    !isFreshEvidence(row.as_of_at, binding.now, binding.maxAgeMs) ||
    !Number.isFinite(Date.parse(String(row.source_cutoff_at))) || Date.parse(String(row.source_cutoff_at))>Date.parse(String(row.as_of_at))) return false;
  return true;
}

/** Upstream MTM audit, never inferred from the closed-trade equity curve. */
export function verifyRiskEvidence(row: Record<string, unknown> | null, binding: EvidenceBinding): boolean {
  if (!verifyBoundEvidence(row, binding) || !row || row.reconciled !== true || row.complete_history !== true ||
    row.open_positions_marked !== true || row.cash_flows_reconciled !== true || row.rule_breach !== false ||
    !Number.isFinite(Date.parse(String(row.expires_at))) || Date.parse(String(row.expires_at)) <= binding.now ||
    !row.rule_snapshot_id || typeof row.evidence_reference !== 'string' || !row.evidence_reference.trim()) return false;
  try {
    const equity = requiredNumber(row.equity, 'equity');
    const floor = Math.max(requiredNumber(row.daily_floor, 'daily_floor'), requiredNumber(row.total_floor, 'total_floor'));
    const stressedLoss = requiredNumber(row.stressed_open_loss, 'stressed_open_loss');
    return equity > floor && stressedLoss >= 0 && equity - stressedLoss > floor;
  } catch { return false; }
}

/** An aggregate source/destination PnL ratio alone cannot verify replicable edge. */
export function verifyCopyEvidence(row: Record<string, unknown> | null, binding: EvidenceBinding): boolean {
  if(!row || !row.provenance || typeof row.provenance!=='object') return false;
  const p=row.provenance as Record<string,unknown>;
  if(!verifyBoundEvidence({...p,trading_account_id:row.trading_account_id,as_of_at:row.as_of_at},binding) ||
    p.matched_ideas_complete!==true || p.risk_normalised!==true ||
    typeof p.provider_permission_reference!=='string' || !p.provider_permission_reference.trim() ||
    typeof p.reserve_review_reference!=='string' || !p.reserve_review_reference.trim() ||
    !isFreshEvidence(row.as_of_at,binding.now,300000) || Date.parse(String(p.expires_at))<=binding.now ||
    !Number.isFinite(Date.parse(String(p.expires_at)))) return false;
  try {return requiredNumber(p.net_edge_lower90_bps,'copy_lower_edge')>0;}catch{return false;}
}

// Keyset pagination avoids silently accepting Supabase's default row cap.
// A hard operational bound fails the account/run rather than scoring a prefix.
export async function readAllPages<T extends { id: string }>(
  page: (after: string | null, limit: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  maxRows = 100000,
): Promise<T[]> {
  const rows: T[] = [];
  let after: string | null = null;
  while (true) {
    const result = await page(after, 500);
    if (result.error) throw result.error;
    const batch = result.data ?? [];
    if (batch.length === 0) return rows;
    if (rows.length + batch.length > maxRows) throw new Error("DETECTOR_INPUT_LIMIT_EXCEEDED");
    const last = batch[batch.length - 1].id;
    if (last === after) throw new Error("DETECTOR_PAGINATION_NOT_ADVANCING");
    rows.push(...batch);
    after = last;
    // Do not assume a short page is EOF: server row limits may be below 500.
  }
}
