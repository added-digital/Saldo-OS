Available tables for generated SQL:

customers
- id (uuid)
- name (text)
- status (text)
- fortnox_customer_number (text)
- fortnox_cost_center (text)
- email (text)
- created_at (timestamptz)

profiles
- id (uuid)
- full_name (text)
- email (text)
- role (text)
- is_active (boolean)
- fortnox_employee_id (text)
- fortnox_cost_center (text)
- team_id (uuid)

teams
- id (uuid)
- name (text)
- lead_id (uuid)

invoices
- id (uuid)
- customer_id (uuid)
- customer_name (text)
- fortnox_customer_number (text)
- invoice_date (date)
- currency_code (text)
- total_ex_vat (numeric, in currency_code)
- total (numeric, in currency_code)
- balance (numeric, in currency_code)
- total_ex_vat_sek (numeric, converted to SEK)
- total_sek (numeric, converted to SEK)
- balance_sek (numeric, converted to SEK)

time_reports
- id (uuid)
- customer_id (uuid)
- fortnox_customer_number (text)
- report_date (date)
- employee_id (text)
- employee_name (text)
- entry_type (text)
- hours (numeric)
- project_name (text)
- activity (text)

contract_accruals
- id (uuid)
- fortnox_customer_number (text)
- contract_number (text)
- is_active (boolean)
- start_date (date)
- end_date (date)
- currency_code (text)
- total_ex_vat (numeric, in currency_code)
- total (numeric, in currency_code)
- total_ex_vat_sek (numeric, converted to SEK)
- total_sek (numeric, converted to SEK)
- period (text)

customer_kpis
- customer_id (uuid)
- period_type (text)
- period_year (int)
- period_month (int)
- total_turnover (numeric)
- invoice_count (int)
- total_hours (numeric)
- customer_hours (numeric)
- absence_hours (numeric)
- internal_hours (numeric)
- other_hours (numeric)
- contract_value (numeric)

customer_contacts
- id (uuid)
- email (text)
- first_name (text)
- last_name (text)

customer_contact_links
- customer_id (uuid)
- contact_id (uuid)
- is_primary (boolean)

customer_segments
- customer_id (uuid)
- segment_id (uuid)

segments
- id (uuid)
- name (text)

Rules:
- Use only SELECT queries.
- Use only listed tables.
- If user/profile filter is required, use placeholder {user_id}.
- Prefer ex-VAT values for turnover whenever available.
- Always SUM the `_sek` columns (`total_ex_vat_sek`, `total_sek`, `balance_sek`). The plain columns are in each document's own currency and must never be summed across customers.
- Use active contracts only (`is_active = true`) for contract totals and KPI-related contract logic.
- Use LIMIT in result sets.
