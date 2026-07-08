-- =====================================================
-- Migration 00097: Seed license_price_list (Fortnox standard prices)
-- =====================================================
-- Populates the license price list (created in 00009) with the Fortnox
-- standard price list from the reference workbook (Huvud excel.xlsm,
-- "Fortnox standardpris"). Idempotent: on conflict the product name and
-- price are refreshed so re-running keeps the list current without wiping
-- any comments an admin added.
--
-- Article 82500 = fixed client fee (info, 0 kr); 82501 = fixed client fee
-- actually billed (500 kr). See docs/pricing-tool-spec.md §5.

INSERT INTO license_price_list (article_number, product_name, monthly_price)
VALUES
  ('101030', 'Bokföring', 149),
  ('101230', 'Bokföring Attest & Läs', 79),
  ('102030', 'Fakturering', 149),
  ('103030', 'Byråpartner', 329),
  ('105030', 'Offert & Order', 89),
  ('106030', 'Anläggningsregister', 109),
  ('111030', 'Autogiro', 109),
  ('112030', 'Integration', 169),
  ('114030', 'Leverantörsfakturaattest', 49),
  ('117030', 'Lager', 369),
  ('202030', 'Arkivplats', 109),
  ('202560', 'Extra Utrymme', 109),
  ('301030', 'Lön', 169),
  ('302170', 'Tid', 89),
  ('302280', 'Förening', 279),
  ('55006052', 'Enkel Lön', 69),
  ('55006057', 'Löpande Bas', 239),
  ('55006064', 'Bokslut & Skatt - Byrå', 349),
  ('55006110', 'Standard', 369),
  ('55006111', 'Plus', 519),
  ('55006112', 'Fortnox Revisor', 149),
  ('55006113', 'Fortnox Läs', 79),
  ('55006116', 'Gör Det Själv Bas', 239),
  ('55006150', 'Personalattest', 49),
  ('55006164', 'Byrå Koncern Liten', 149),
  ('55006166', 'Byrå Koncern Mellan', 249),
  ('550066184', 'Findity AB/Kvitto  Resa', 109),
  ('55066197', 'Attest & Koll', 99),
  ('66000011', 'Standout AB/Zapier', 169),
  ('82500', 'Fast kostnad klienter', 0),
  ('55066199', 'Rapport & Analys - Byrå', 199),
  ('55066200', 'Rapport & Analys Utökad', 99),
  ('55006195', 'Rapport & Analys - Företag', 149),
  ('55006196', 'Rapport & Analys Plus', 299),
  ('55006114', 'Löpande Mini', 99),
  ('55066205', 'Mellan', 529),
  ('55066203', 'Liten', 349),
  ('55066204', 'Liten+', 479),
  ('55066206', 'Mellan+', 659),
  ('55006109', 'Bas', 349),
  ('55066201', 'Mini', 209),
  ('55066198', 'Bokslut & Skatt - Företag', 349),
  ('82501', 'Fast kostnad klienter', 500),
  ('55066208', 'Stor+', 919),
  ('55066244', 'Lön Kivra', 5)
ON CONFLICT (article_number) DO UPDATE
  SET product_name = EXCLUDED.product_name,
      monthly_price = EXCLUDED.monthly_price;
