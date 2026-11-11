// Automatic approval of a free Infinity application (owner decision, 11 Nov 2026).
//
// Before this, every application waited for a person to press Yes: 732 were approved and 17 refused, and the
// average wait was 14 hours. Now the account is issued the moment the application is submitted, and the identity
// documents are checked afterwards. The identity check stays "pending" until a person has looked at it, so:
//   - a payout still needs a verified identity (unchanged), and
//   - rejecting the identity check later stops the account (admin-console set_kyc_status).
//
// The only applications still held for a person are the ones a machine can tell are wrong.
// Pure function: no database access, so it is tested directly.

export const AUTO_APPROVAL_NOTE = "Approved automatically. Identity documents are checked after approval.";
export const IDENTITY_STOP_REASON = "identity_check_rejected";

const MIN_AGE_YEARS = 18;

function ageOn(dateOfBirth, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateOfBirth ?? ""));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const birth = new Date(Date.UTC(y, mo - 1, d));
  if (birth.getUTCFullYear() !== y || birth.getUTCMonth() !== mo - 1 || birth.getUTCDate() !== d) return null;
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) age--;
  return age;
}

// Returns null when the application can be approved now, or a short reason when a person must look first.
export function autoApprovalHold({ enabled = true, challengeType, kycStatus, docTypes, dateOfBirth, now = new Date() } = {}) {
  if (!enabled) return "auto_approval_off";
  if (challengeType !== "infinity") return "not_infinity";            // paid programmes keep their manual review
  if (!["pending", "verified"].includes(String(kycStatus ?? ""))) return "identity_check_not_open"; // rejected or never uploaded
  if (!new Set(docTypes ?? []).has("id_front")) return "no_id_photo";
  const age = ageOn(dateOfBirth, now);
  if (age === null) return "date_of_birth_missing";
  if (age < MIN_AGE_YEARS) return "under_18";
  if (age > 100) return "date_of_birth_implausible";
  return null;
}
