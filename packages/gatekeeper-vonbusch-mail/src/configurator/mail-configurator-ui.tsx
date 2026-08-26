import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { MailConfiguratorRpc, MailConfiguratorValues } from "./mail-configurator-types";

// Ressourcen-Konfigurator für den vonBusch-Mailer.
//
// Der Mailer hat genau EINE Ressource (den ausgehenden Kanal mail.vonbusch.app). Es gibt nichts
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

  // Feste, serverseitig autoritative Mail-Ressourcen-URL.
  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    const description =
      "Bindet den vonBusch-Mailer ein: ausgehende E-Mails (CF send_email, noreply@vonbusch.app) " +
      "mit menschlicher Freigabe versenden und den Status der eigenen Vorschlaege lesen. Es gibt " +
      "nichts weiter auszuwaehlen; klicke auf Add connection, um die Verbindung anzulegen.";
    return <Section title="vonBusch Mail">
      <Field label="Ausgehender Mail-Kanal" description={description} />
    </Section>;
  },
} satisfies ConfiguratorUISpec<MailConfiguratorRpc, MailConfiguratorValues>;
