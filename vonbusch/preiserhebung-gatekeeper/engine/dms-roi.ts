/**
 * DMS-ROI-Rechenkern — portiert für vonBuschOS (VON-1801).
 *
 * TypeScript-Port des bewährten `roi-config.js` / `computeRoi()` aus dem
 * dmsroi-Repo (VON-1785/1787). Reiner Rechenkern, keine DOM-/UI-Abhängigkeiten.
 *
 * Die Koeffizienten (`coeff`) und Standardwerte (`defaults`) sind der
 * "Parametersatz" dieses Gadgets. Im Gatekeeper kommen sie read-only aus der
 * Preis-D1 (bzw. dem hier eingebetteten Default-Satz als Fallback); der
 * Vertrieb überschreibt sie zur Laufzeit per `overrides`, ohne die Quelle zu
 * verändern.
 */

export interface DmsRoiKoeffizienten {
  searchTimeReductionPct: number; // Ersparnis Suchzeit pro Beleg
  processTimeReductionPct: number; // Ersparnis Bearbeitungs-/Ablagezeit pro Beleg
  paperReductionPct: number; // Ersparnis Papier-/Druck-/Portokosten
  archiveReductionPct: number; // Ersparnis physische Archiv-/Lagerkosten
  errorReductionPct: number; // Ersparnis Fehler-/Nachbearbeitungskosten
}

export interface DmsRoiEingabe {
  docsPerMonth: number;
  searchMinBefore: number;
  processMinBefore: number;
  laborCostPerHour: number;
  paperCostPerDoc: number;
  archiveCostPerYear: number;
  errorCostPerYear: number;
  licenseSetupOnce: number;
  licenseYearly: number;
}

export interface DmsRoiConfig {
  coeff: DmsRoiKoeffizienten;
  defaults: DmsRoiEingabe;
  horizonsYears: number[];
}

export interface DmsRoiHorizont {
  years: number;
  totalCost: number;
  totalBenefit: number;
  netGain: number;
  roiPct: number;
}

export interface DmsRoiErgebnis {
  docsPerYear: number;
  hoursSavedPerYear: number;
  breakdown: {
    timeSavings: number;
    paperSavings: number;
    archiveSavings: number;
    errorSavings: number;
  };
  annualSavings: number;
  netAnnualBenefit: number;
  paybackMonths: number | null;
  horizons: Record<number, DmsRoiHorizont>;
}

/** Nicht-negative Zahl aus beliebigem Input (akzeptiert Komma-Dezimal). */
export function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Standard-Docuware-ROI-Modell (Branchenrichtwerte). Fallback / Test-Fixture;
 * Quelle: dmsroi ROI_CONFIG. Verbindliche Excel-Werte folgen via VON-1784.
 */
export const DMS_ROI_CONFIG: DmsRoiConfig = {
  coeff: {
    searchTimeReductionPct: 0.8,
    processTimeReductionPct: 0.3,
    paperReductionPct: 0.7,
    archiveReductionPct: 0.5,
    errorReductionPct: 0.6,
  },
  defaults: {
    docsPerMonth: 2000,
    searchMinBefore: 3,
    processMinBefore: 2,
    laborCostPerHour: 45,
    paperCostPerDoc: 0.12,
    archiveCostPerYear: 3600,
    errorCostPerYear: 4000,
    licenseSetupOnce: 40000,
    licenseYearly: 12000,
  },
  horizonsYears: [3, 5],
};

/**
 * Reiner Rechenkern. Nimmt Nutzereingaben + Config, liefert alle Kennzahlen.
 * Portiert aus dmsroi `computeRoi()` — Formeln unverändert.
 */
export function computeRoi(
  input: Partial<DmsRoiEingabe>,
  cfg: DmsRoiConfig = DMS_ROI_CONFIG,
): DmsRoiErgebnis {
  const c = cfg.coeff;
  const docsPerYear = num(input.docsPerMonth) * 12;

  // Zeitersparnis (Suche + Bearbeitung) → Personalkosten
  const searchMinSaved = num(input.searchMinBefore) * c.searchTimeReductionPct;
  const processMinSaved = num(input.processMinBefore) * c.processTimeReductionPct;
  const minSavedPerDoc = searchMinSaved + processMinSaved;
  const hoursSavedPerYear = (docsPerYear * minSavedPerDoc) / 60;
  const timeSavings = hoursSavedPerYear * num(input.laborCostPerHour);

  // Sachkosten-Ersparnisse
  const paperSavings = docsPerYear * num(input.paperCostPerDoc) * c.paperReductionPct;
  const archiveSavings = num(input.archiveCostPerYear) * c.archiveReductionPct;
  const errorSavings = num(input.errorCostPerYear) * c.errorReductionPct;

  const annualSavings = timeSavings + paperSavings + archiveSavings + errorSavings;

  // Kosten DMS
  const setup = num(input.licenseSetupOnce);
  const yearly = num(input.licenseYearly);

  const netAnnualBenefit = annualSavings - yearly;
  const netMonthlyBenefit = netAnnualBenefit / 12;

  // Amortisation (Monate) bis einmalige Kosten gedeckt sind
  let paybackMonths: number | null = null;
  if (netMonthlyBenefit > 0) paybackMonths = setup / netMonthlyBenefit;

  // ROI je Horizont
  const horizons: Record<number, DmsRoiHorizont> = {};
  for (const y of cfg.horizonsYears) {
    const totalBenefit = annualSavings * y;
    const totalCost = setup + yearly * y;
    const netGain = totalBenefit - totalCost;
    horizons[y] = {
      years: y,
      totalCost,
      totalBenefit,
      netGain,
      roiPct: totalCost > 0 ? (netGain / totalCost) * 100 : 0,
    };
  }

  return {
    docsPerYear,
    hoursSavedPerYear,
    breakdown: { timeSavings, paperSavings, archiveSavings, errorSavings },
    annualSavings,
    netAnnualBenefit,
    paybackMonths,
    horizons,
  };
}
