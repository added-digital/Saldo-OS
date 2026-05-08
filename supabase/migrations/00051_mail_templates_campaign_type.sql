-- Allow the Aktiebok / Campaign built-in template to be saved with its own
-- template_type instead of being coerced to 'default'. The compose page
-- already renders the campaign React Email template when template_type is
-- 'campaign', so persisting the type lets a saved campaign template round-trip
-- correctly through the editor and the inbox preview.

ALTER TABLE mail_templates
  DROP CONSTRAINT IF EXISTS mail_templates_template_type_check;

ALTER TABLE mail_templates
  ADD CONSTRAINT mail_templates_template_type_check
  CHECK (template_type IN ('plain', 'plain_os', 'default', 'campaign'));
