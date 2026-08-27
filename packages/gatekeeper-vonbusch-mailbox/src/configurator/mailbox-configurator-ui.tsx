import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  MailboxConfiguratorRpc,
  MailboxConfiguratorValues,
} from "./mailbox-configurator-types";

// Ressourcen-Konfigurator für den vonBusch-Mailbox-Gatekeeper.
//
// Anders als CRM/Mail (feste Einzelressource) bindet die Mailbox genau EINE agentic-inbox-Mailbox,
// die über eine konkrete Inbox-ID in der URL adressiert wird (`.../inbox/<id>`). Ein wildcard
// `.../inbox/*` als gebundene Ressource wäre kaputt (siehe `mailboxFromUrl`). Deshalb hat dieser
// Konfigurator EIN Eingabefeld: die Inbox-ID. Ohne diesen Frame (bzw. wenn `startResourceConfigurator`
// wirft) bleibt der „Add connection"-Button in der OS-Connect-Modal-UI ausgegraut (VON-1864).
export default {
  initial: { inboxId: null },

  // Vorbefüllung, falls die konkrete Ressourcen-URL schon feststeht (z. B. Verbindungswunsch eines
  // Agenten). Das Pattern nutzt `*` (kein benannter URLPattern-Group), daher parsen wir selbst.
  initialValuesFromResourceUrl({ resourceUrl }) {
    try {
      const u = new URL(resourceUrl);
      if (u.pathname.startsWith("/inbox/")) {
        const id = decodeURIComponent(u.pathname.slice("/inbox/".length));
        if (id) return { inboxId: id };
      }
    } catch {
      // Kein gültiger konkreter URL ⇒ Formular bleibt leer.
    }
    return {};
  },

  // „Add connection" wird erst aktiv, wenn eine nicht-leere Inbox-ID eingegeben wurde.
  isReady({ values }) {
    return !!values.inboxId && values.inboxId.trim().length > 0;
  },

  // Serverseitig autoritative Ressourcen-URL: der Vendor kennt Host/Prefix/Encoding (eine Quelle
  // der Wahrheit) und validiert die eingegebene ID.
  resourceUrl({ values, ui }) {
    return ui.resourceUrl((values.inboxId ?? "").trim());
  },

  render({ values, setValues }) {
    return <Section title="vonBusch Mailbox">
      <Field
        label="Inbox-ID"
        description={
          "Die konkrete agentic-inbox-Mailbox, die eingebunden werden soll (Bestandteil der URL " +
          "https://mail.vonbusch.app/inbox/<id>). Der Zugriff wird zusätzlich per ACL geprüft; " +
          "erlaubt sind nur freigegebene bzw. Admin-Identitäten."
        }
      >
        <TextInput
          name="inboxId"
          value={values.inboxId}
          placeholder="z. B. team-vertrieb"
          onChange={inboxId => setValues({ inboxId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<MailboxConfiguratorRpc, MailboxConfiguratorValues>;
