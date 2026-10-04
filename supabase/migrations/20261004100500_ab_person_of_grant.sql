-- Fix: the service role could not execute ab_person_of, so every view built on it (ab_person_signals,
-- treasury_open_accounts) failed for the Edge Functions. The classifier ignored the error and therefore
-- never saw integrity signals (investigation hold, critical flags) or Stage 2 progress. It now fails loudly.
grant execute on function public.ab_person_of(uuid) to service_role;
