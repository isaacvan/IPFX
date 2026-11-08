-- Shorter, punchier subject for the come-back email; the preheader now carries the free / no-minimum-days / payout points.
update public.email_templates set
  subject = 'You asked. We changed the rules.',
  preheader = 'Free to start, no minimum days, and up to $700 paid when you finish Stage 3.'
where key = 'infinity_comeback';
-- The inbox preview line comes from the hidden first line of the email body, so change it there too.
update public.email_templates set body_html = replace(body_html,
  'No minimum days, no profit cap, and up to $700 paid when you finish Stage 3.',
  'Free to start, no minimum days, and up to $700 paid when you finish Stage 3.')
where key = 'infinity_comeback';
