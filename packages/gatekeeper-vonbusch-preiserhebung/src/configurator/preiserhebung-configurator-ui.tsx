import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  PreiserhebungConfiguratorRpc,
  PreiserhebungConfiguratorValues,
} from "./preiserhebung-configurator-types";

// Ressourcen-Konfigurator für die vonBusch-Preiserhebung.
//
// Die Preiserhebung hat genau EINE Ressource (die read-only Preis-D1: printgemein-Druckpreis +
// DMS-ROI). Es gibt nichts auszuwählen — der Konfigurator bestätigt nur die Verbindung und liefert
// die feste Ressourcen-URL zurück. Er ist trotzdem nötig: die OS-Connect-Modal-UI aktiviert
// „Add connection" erst, wenn ein Konfigurator-Frame geladen ist und `isReady`/
// `setSelectionReady(true)` gemeldet hat — auch bei fest verdrahteten Einzelressourcen (VON-1850).
// Ohne diesen Frame bliebe der Button ausgegraut.
export default {
  initial: {},

  // Nichts zu konfigurieren ⇒ sofort absendebereit: der Button wird aktiv, sobald der Frame lädt.
  isReady() {
    return true;
  },

  // Feste, serverseitig autoritative Preiserhebungs-Ressourcen-URL.
  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    const description =
      "Bindet die read-only Preis-D1 ein: printgemein-Druckpreis und DMS-ROI aus den " +
      "Kalkulationsparametern. Nur-Lesen; Vertriebs-Anpassungen sind nicht-persistente Per-Call- " +
      "Overrides. Es gibt nichts weiter auszuwaehlen; klicke auf Add connection, um die Verbindung " +
      "anzulegen.";
    return <Section title="vonBusch Preiserhebung">
      <Field label="Preis-/Kalkulationsparameter (read-only)" description={description} />
    </Section>;
  },
} satisfies ConfiguratorUISpec<PreiserhebungConfiguratorRpc, PreiserhebungConfiguratorValues>;
