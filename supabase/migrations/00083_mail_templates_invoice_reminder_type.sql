-- Allow the Fakturapåminnelse / invoice reminder built-in template to be saved
-- with its own template_type. The compose page renders this as a plain-text
-- email (no branded styling) and, when selected, only sends to customers that
-- have invoices overdue by more than the grace period — injecting each
-- customer's overdue invoices into the body. Persisting the dedicated type lets
-- the composer reliably detect the template and apply that special behaviour,
-- and lets admins save customised copies that round-trip through the editor.

ALTER TABLE mail_templates
  DROP CONSTRAINT IF EXISTS mail_templates_template_type_check;

ALTER TABLE mail_templates
  ADD CONSTRAINT mail_templates_template_type_check
  CHECK (template_type IN ('plain', 'plain_os', 'default', 'campaign', 'invoice_reminder'));
