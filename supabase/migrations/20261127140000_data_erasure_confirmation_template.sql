-- Confirmation sent after a UK GDPR erasure request is completed (first use: 27 Nov 2026). Account email, never marketing.
insert into public.email_templates (key, category, subject, preheader, body_html, body_text, is_active) values (
 'data_erasure_confirmation', 'compliance', 'Your IPFX Capital account has been closed and your data deleted',
 'We have completed your request to close your account and delete your personal data.',
 '<p>Dear {{customer_name}},</p>
<p>We have closed your IPFX Capital account and permanently deleted your personal information, including your identification documents and proof of address. We have also stopped all processing of your personal data.</p>
<p>Any remaining trading statistics are held only in anonymised form that cannot be linked to you.</p>
<p>If you have any questions, reply to this email. You also have the right to complain to the UK Information Commissioner''s Office (ico.org.uk).</p>
<p>Kind regards,<br>IPFX Capital</p>',
 'Dear {{customer_name}},

We have closed your IPFX Capital account and permanently deleted your personal information, including your identification documents and proof of address. We have also stopped all processing of your personal data.

Any remaining trading statistics are held only in anonymised form that cannot be linked to you.

If you have any questions, reply to this email. You also have the right to complain to the UK Information Commissioner''s Office (ico.org.uk).

Kind regards,
IPFX Capital', true)
on conflict (key) do update set subject=excluded.subject, preheader=excluded.preheader, body_html=excluded.body_html, body_text=excluded.body_text, is_active=true;
