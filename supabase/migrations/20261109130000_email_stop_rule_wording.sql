-- Emails: a stop can now be moved either way (see 20261109120000_infinity_v2_allow_stop_widening.sql), so the stored
-- wording must not say "never widen". Only the exact sentences below are replaced; everything else is untouched.
update public.email_templates set
  body_html = replace(body_html, 'You can tighten it, never widen it.', 'You can move it either way, as long as the trade keeps one and the risk stays inside your limit.'),
  body_text = replace(body_text, 'You can tighten it, never widen it.', 'You can move it either way, as long as the trade keeps one and the risk stays inside your limit.')
where key = 'infinity_comeback';

update public.email_templates set
  body_html = replace(replace(body_html, 'Why can''t I widen my stop?', 'Can I move my stop?'),
    'Your risk is measured from your opening stop. Moving it further away would hide your real risk. You can always tighten it or move it to break-even.',
    'Yes, either way, as long as the trade keeps a stop. If you widen it, the new stop must still fit inside your per-trade risk limit, and your recorded risk on the trade grows to match.'),
  body_text = replace(replace(body_text, 'Why can''t I widen my stop?', 'Can I move my stop?'),
    'Your risk is measured from your opening stop. Moving it further away would hide your real risk. You can always tighten it or move it to break-even.',
    'Yes, either way, as long as the trade keeps a stop. If you widen it, the new stop must still fit inside your per-trade risk limit, and your recorded risk on the trade grows to match.')
where key = 'infinity_v2_launch';
