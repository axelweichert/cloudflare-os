-- owlOS ERP-Gatekeeper — self-backed D1-Schema (OWL-1633)
-- Der Gatekeeper IST das ERP-Backend (kein externer owlOS-API-Call). Prod-D1:
-- `owlos-erp` (Weichert.at-Account 6b9b3fa0…). Diese Datei ist die Source-of-Truth
-- des Schemas und wird beim Provisionieren angewandt (wrangler d1 execute --file schema.sql).

CREATE TABLE IF NOT EXISTS kunden (
  id      TEXT PRIMARY KEY,
  name    TEXT,
  email   TEXT,
  firma   TEXT,
  telefon TEXT,
  ustid   TEXT,          -- USt-IdNr.
  status  TEXT,          -- aktiv | inaktiv
  notizen TEXT
);

CREATE TABLE IF NOT EXISTS angebote (
  id         TEXT PRIMARY KEY,
  kunde_id   TEXT,
  titel      TEXT,
  betrag     REAL,
  status     TEXT,       -- angebot | auftrag | storniert
  gueltig_bis TEXT,
  notizen    TEXT
);

CREATE TABLE IF NOT EXISTS rechnungen (
  id         TEXT PRIMARY KEY,
  kunde_id   TEXT,
  angebot_id TEXT,
  nummer     TEXT,
  betrag     REAL,
  status     TEXT,       -- offen (offener Posten) | bezahlt | storniert
  faellig_am TEXT,
  bezahlt_am TEXT,
  notizen    TEXT
);

CREATE INDEX IF NOT EXISTS idx_angebote_kunde   ON angebote(kunde_id);
CREATE INDEX IF NOT EXISTS idx_rechnungen_kunde ON rechnungen(kunde_id, status);

-- Demo-Seed nur für lokale E2E (Miniflare). Prod bleibt leer.
INSERT OR IGNORE INTO kunden (id, name, firma, email, status) VALUES
  ('k1', 'Erika Mustermann', 'ACME GmbH', 'erika@acme.at', 'aktiv');
INSERT OR IGNORE INTO rechnungen (id, kunde_id, nummer, betrag, status, faellig_am) VALUES
  ('r1', 'k1', 'RE-2026-001', 1200, 'offen', '2026-10-15');
