-- vonBuschOS — CRM-Gatekeeper: minimales CRM-Schema (VON-1800 / K2)
--
-- NUR für lokale Miniflare-E2E-Tests dieses Gadgets. Die PROD-Tabellen leben in
-- vonbusch-crm-eu (CRM-Repo) und werden vom Gatekeeper nur GELESEN/parametrisiert
-- beschrieben. Beim Wiring (CEO-Gate) müssen die Spalten der Allowlist (write-queue.ts)
-- auf die echten Spalten von vonbusch-crm-eu gemappt werden.

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  phone TEXT,
  company TEXT,
  status TEXT,
  owner TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  title TEXT,
  contact_id TEXT,
  value REAL,
  stage TEXT,
  status TEXT,
  owner TEXT,
  close_date TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  deal_id TEXT,
  type TEXT,
  subject TEXT,
  body TEXT,
  status TEXT,
  owner TEXT,
  due_at TEXT
);

INSERT OR IGNORE INTO contacts (id, name, email, company) VALUES
  ('c1', 'Erika Mustermann', 'erika@acme.de', 'ACME'),
  ('c2', 'Max Beispiel', 'max@globex.de', 'Globex');
INSERT OR IGNORE INTO deals (id, title, contact_id, stage, value) VALUES
  ('d1', 'ACME Rahmenvertrag', 'c1', 'open', 10000);
