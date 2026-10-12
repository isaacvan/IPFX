# Infinity daily entry cap

Stage 1 pauses new market and pending entries after a $14 daily gain (1.4% of $1,000). Existing positions remain manageable and retain their actual P&L. A cap hit is not a breach or next-month lockout.

The cap uses the existing equity-minus-UTC-day-start calculation, including floating profit. A service-only database routine records an observed hit per account and UTC day, so giving back profit cannot reopen entries until 00:00 UTC. Database insert guards also check current persisted quotes, including pending fills. No account balances, trade history, profit eligibility rules, targets or accepted Terms are rewritten.

IPFX Markets shows the server pause message beside the order buttons and disables new-entry buttons. Stage 1 reminds traders that 10 qualifying trading days and 14 elapsed calendar days are required, alongside the other progression conditions.

Validation: executable PGlite tests cover exactly $14, below $14, later equity recovery, midnight day scoping, market and pending entry rejection, unchanged actual profit, closed accounting slices, and client access denial. Engine type-check and inline scripts pass. Production migration rehearsed with rollback; deployed engine compared to origin/main before deployment. On 12 October the aggregate audit found two active Stage 1 accounts reaching $14 in closed daily profit and zero subsequent opens.

Do not reset a trader to $14 or penalise them solely for an existing position closing above the cap. A new maximum credited daily profit rule would need separate versioned publication for future runs.
