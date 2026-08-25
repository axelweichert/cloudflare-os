/**
 * Lineare Echtzeit-Preis-Engine (printgemein) — portiert für vonBuschOS (VON-1801).
 *
 * 1:1-Port des bewährten Rechenkerns aus dem printgemein-Repo
 * (`src/pricing/engine.ts`, VON-32/§4). Reine Funktion ohne Seiteneffekte,
 * runtime-agnostisch → im Workers-Gatekeeper wie im Test identisch nutzbar.
 *
 * Die Parameterwerte kommen NICHT aus dieser Datei, sondern read-only aus der
 * Preis-D1 (`preisparameter`-Tabelle) — siehe ../preis-parameter.ts. Das hier
 * eingebettete PLATZHALTER_PARAMETER dient nur als Fallback für fehlende Keys
 * und als Test-Fixture.
 */

export type Format = "A4" | "A5";
export type Farbigkeit = "4c" | "sw";
export type Versandart = "standard" | "express";

export interface ProduktKonfiguration {
  format: Format;
  farbigkeit: Farbigkeit;
  papiersorte: string;
  seiten: number; // 4–80, Vielfaches von 4 (Rückenheftung)
  auflage: number; // 10–2.000
  versand: Versandart;
}

export interface PreisParameterSatz {
  /** Fixe Rüstkosten je Auftrag (EUR). */
  ruestkosten: number;
  /** Klickpreis je Impression (bedruckte Bogenseite). EUR. */
  klickpreis: Record<Farbigkeit, number>;
  /** Papierpreis je physischem Druckbogen (EUR), nach Sorte und Format. */
  papierpreis: Record<string, Record<Format, number>>;
  /** Seiten je Druckbogen je Format (= 4 × nutzen). */
  seitenProBlatt: Record<Format, number>;
  /** Weiterverarbeitung (Falz/Heftung) je Exemplar, EUR. */
  weiterverarbeitung: number;
  /** Versandkosten (EUR) je Versandart. */
  versandkosten: Record<Versandart, number>;
  /** Margen-/DB-Aufschlag (Default 0 wenn Parameter VK-Preise sind). */
  margenAufschlag: number;
  /** Provisionssatz je Bistum (Default 5 %). */
  provisionRate: number;
  /** MwSt-Satz (Default 7 % – ermäßigter Satz Druckerzeugnis §12 UStG). */
  ust: number;
}

export interface PreisAufschluesselung {
  ruestkosten: number;
  druckkosten: number; // klicksGesamt × klickpreis
  papierkosten: number;
  weiterverarbeitungskosten: number;
  versandkosten: number;
  druckNetto: number; // Herstellkosten netto = Provisionsbasis (ohne Versand)
  provision: number; // druckNetto × provisionRate
  netto: number; // Netto-Endpreis = druckNetto×(1+prov) + versand (vor MwSt)
  ust: number; // MwSt 7%
  brutto: number; // Endpreis inkl. MwSt (Kundensicht)
  details: {
    blaetterProExemplar: number;
    blaetterGesamt: number;
    klicksGesamt: number;
  };
}

export const MIN_SEITEN = 4;
export const MAX_SEITEN = 80;
export const MIN_AUFLAGE = 10;
export const MAX_AUFLAGE = 2000;

export class PreisValidierungsFehler extends Error {}

function rundeCent(betrag: number): number {
  return Math.round(betrag * 100) / 100;
}

export function validiereKonfiguration(k: ProduktKonfiguration): void {
  if (!Number.isInteger(k.seiten) || k.seiten < MIN_SEITEN || k.seiten > MAX_SEITEN) {
    throw new PreisValidierungsFehler(
      `Seitenzahl muss zwischen ${MIN_SEITEN} und ${MAX_SEITEN} liegen.`,
    );
  }
  if (k.seiten % 4 !== 0) {
    throw new PreisValidierungsFehler(
      `Seitenzahl muss ein Vielfaches von 4 sein (Rückenheftung).`,
    );
  }
  if (!Number.isInteger(k.auflage) || k.auflage < MIN_AUFLAGE || k.auflage > MAX_AUFLAGE) {
    throw new PreisValidierungsFehler(
      `Auflage muss zwischen ${MIN_AUFLAGE} und ${MAX_AUFLAGE} liegen.`,
    );
  }
}

/**
 * Berechnet den Endpreis nach Spec §4 (VON-32). Rechenreihenfolge verbindlich:
 *   1. Stückkosten (Druck + Papier + Weiterverarbeitung)
 *   2. Herstellungskosten netto (fix + variabel·q) mit Margenaufschlag
 *   3. Provision 5% auf Herstellkosten (OHNE Versand)
 *   4. Versand Pass-Through
 *   5. MwSt 7% auf Netto-Endpreis
 */
export function berechnePreis(
  k: ProduktKonfiguration,
  p: PreisParameterSatz,
): PreisAufschluesselung {
  validiereKonfiguration(k);

  const papierTabelle = p.papierpreis[k.papiersorte];
  if (!papierTabelle) {
    throw new PreisValidierungsFehler(`Unbekannte Papiersorte: ${k.papiersorte}`);
  }
  const papierpreisProBlatt = papierTabelle[k.format];
  const seitenProBlatt = p.seitenProBlatt[k.format];

  // Bogen und Impressionen je Exemplar
  const blaetterProExemplar = Math.ceil(k.seiten / seitenProBlatt);
  const blaetterGesamt = blaetterProExemplar * k.auflage;
  // Klick = eine bedruckte Bogenseite (Impression); 2 Impressionen je Bogen
  const klicksGesamt = 2 * blaetterGesamt;

  const druckkosten = klicksGesamt * p.klickpreis[k.farbigkeit];
  const papierkosten = blaetterGesamt * papierpreisProBlatt;
  const weiterverarbeitungskosten = k.auflage * p.weiterverarbeitung;
  const ruestkosten = p.ruestkosten;

  const herstellNetto = ruestkosten + druckkosten + papierkosten + weiterverarbeitungskosten;
  const druckNetto = herstellNetto * (1 + p.margenAufschlag);

  const versandkosten = p.versandkosten[k.versand];

  const provision = druckNetto * p.provisionRate;
  const netto = druckNetto * (1 + p.provisionRate) + versandkosten;

  const ust = netto * p.ust;
  const brutto = netto + ust;

  return {
    ruestkosten: rundeCent(ruestkosten),
    druckkosten: rundeCent(druckkosten),
    papierkosten: rundeCent(papierkosten),
    weiterverarbeitungskosten: rundeCent(weiterverarbeitungskosten),
    versandkosten: rundeCent(versandkosten),
    druckNetto: rundeCent(druckNetto),
    provision: rundeCent(provision),
    netto: rundeCent(netto),
    ust: rundeCent(ust),
    brutto: rundeCent(brutto),
    details: { blaetterProExemplar, blaetterGesamt, klicksGesamt },
  };
}

/**
 * Fallback-Parametersatz. Aktiv nur, wenn die Preis-D1 einen Key nicht liefert
 * (Resilienz) und als Test-Fixture. Quelle: printgemein PLATZHALTER_PARAMETER.
 */
export const PLATZHALTER_PARAMETER: PreisParameterSatz = {
  ruestkosten: 35.0,
  klickpreis: { "4c": 0.16, sw: 0.03 },
  papierpreis: {
    standard_75: { A4: 0.012, A5: 0.006 },
    premium_100: { A4: 0.02, A5: 0.01 },
  },
  seitenProBlatt: { A4: 4, A5: 4 },
  weiterverarbeitung: 0,
  versandkosten: { standard: 7.9, express: 24.9 },
  margenAufschlag: 0,
  provisionRate: 0.05,
  ust: 0.07,
};
