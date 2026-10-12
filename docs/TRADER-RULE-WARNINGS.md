# Infinity rule warnings in IPFX Markets

Warnings supplement existing enforcement; they do not create strikes, breaches or rule changes.

The engine supplies the saved account loss floors, fixed drawdown/daily-loss allowances, configured stop-loss deadline and server time. The browser uses these to show persistent messages above the chart:

- Daily-loss and drawdown room: amber at 30% allowance remaining; red at 10%. The actual floor, remaining dollars and consequence are shown. Drawdown uses the fixed allowance even when a trailing peak rises.
- An open position missing its stop: countdown from the configured deadline, red in the last 10 seconds. No deadline is invented if the control is off.
- Existing stop-loss strikes: one strike prompts a reminder, the penultimate strike is red. These warnings do not add strikes.
- Daily profit: reminder from 80% of the daily cap. Reaching it pauses entries and is explicitly not a breach.
- Best-day concentration: reminder from 80% of the saved share limit; it explicitly affects progression rather than automatic account failure.
- Profit target met but minimum meaningful days unmet: show the actual qualifying-day count and saved minimum.
- Order-ticket risk preview: amber from 80% of the live per-trade risk allowance; existing oversized-order rejection remains.

Persistent warnings stay visible until the condition clears. A new severity announces once per account/condition/level per 30 minutes in this browser session; severity escalation is immediate. Different nonurgent notices are spaced by at least 10 seconds. User content is inserted as text, not HTML. Practice accounts and other programmes do not receive Infinity warnings.

These are browser reminders based on the most recent server account state. They update with state refreshes; the stop countdown also updates every second. They cannot guarantee an exit before a fast market movement. Existing close controls remain available.

Validation: seven behavioral tests cover actual warning thresholds, rising trailing floors, missing values, configurable stop deadlines, strike severity, profit-cap semantics, progression reminders and notification suppression. Relevant existing cap/risk/breach/syntax tests pass (28 total). A synthetic desktop browser preview verified the rendered messages and layout without trading or using any real customer identity.

## Prominent warnings and per-stage checklist

Critical notices now open a centered red acknowledgement dialog. The amber/red banner stays above the chart after dismissal. If the stage review is already open, urgent messages are shown inside it. Existing position-management controls remain reachable through a dedicated button; the rule review list scrolls independently of those actions.

On first visit to an active Infinity evaluation stage, the trader must tick each saved-rule reading acknowledgement before the normal trading interface accepts new entries. Acknowledgements are local browser UX state, not new contractual acceptances or a security boundary. They are keyed by account and stable rule text, so a new stage or changed rule text requires a fresh review, while live P&L changes do not. Managing existing positions is not gated. All actual risk, entry and promotion rules continue to be enforced on the server.

The order ticket also has a live pass checklist. Read-only checkboxes show eligible closed profit (excluding under-60-second winning profit), elapsed days, qualifying trading days, qualifying trades, exposure sessions, best-day consistency, any profitable-day quota, flat positions, account standing and overall server verification. Manual acknowledgements cannot mark these as complete. Rule values come from the account's saved contract, including the Stage 2 variants. Stage 4 has no invented progression checklist.

Validation: 36 relevant tests pass, engine type-check passes, and the desktop browser fixture verified that Continue stays disabled with one of 14 acknowledgement items unchecked and enables only when all are checked. The displayed pass checklist remained 2/9 verified after all reading boxes were ticked. Both stage-review and critical-risk dialogs were inspected at desktop size; the position-management button remains visible while reading.
