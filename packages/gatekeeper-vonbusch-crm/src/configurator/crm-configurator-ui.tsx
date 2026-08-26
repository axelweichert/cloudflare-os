import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { CrmConfiguratorRpc, CrmConfiguratorValues } from "./crm-configurator-types";

// Ressourcen-Konfigurator für das vonBusch-CRM.
//
// Das CRM hat genau EINE Ressource (die Firmen-Datenbank vonbusch-crm-eu). Es gibt nichts
// auszuwählen — der Konfigurator bestätigt nur die Verbindung und liefert die feste Ressourcen-URL
// zurück. Er ist trotzdem nötig: die OS-Connect-Modal-UI aktiviert „Add connection" erst, wenn ein
// Konfigurator-Frame geladen ist und `isReady`/`setSelectionReady(true)` gemeldet hat — auch bei
// fest verdrahteten Einzelressourcen (VON-1850). Ohne diesen Frame blieb der Button ausgegraut.
export default {
  initial: {},

  // Nichts zu konfigurieren ⇒ sofort absendebereit: der Button wird aktiv, sobald der Frame lädt.
  isReady() {
    return true;
  },

  // Feste, serverseitig autoritative CRM-Ressourcen-URL.
  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    const description =
      "Bindet vonbusch-crm-eu ein: Kontakte, Deals und Aktivitaeten lesen und — mit " +
      "menschlicher Freigabe — schreiben. Es gibt nichts weiter auszuwaehlen; klicke auf " +
      "Add connection, um die Verbindung anzulegen.";
    return <Section title="vonBusch CRM">
      <Field label="Firmen-CRM-Datenbank" description={description} />
    </Section>;
  },
} satisfies ConfiguratorUISpec<CrmConfiguratorRpc, CrmConfiguratorValues>;
