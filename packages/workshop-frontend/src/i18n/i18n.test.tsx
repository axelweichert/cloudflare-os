// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, useI18n } from "./I18nProvider";
import { useT } from "./useT";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("i18n overlay", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let t: ReturnType<typeof useT> | undefined;
  let setLang: ReturnType<typeof useI18n>["setLang"] | undefined;

  function Probe() {
    t = useT();
    setLang = useI18n().setLang;
    return null;
  }

  beforeEach(() => { localStorage.clear(); });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    localStorage.clear();
  });

  function mount() {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    return act(async () => root!.render(<I18nProvider><Probe /></I18nProvider>));
  }

  it("defaults to German, switches to English, and persists the choice", async () => {
    await mount();
    expect(t!("sidebar.home")).toBe("Start");           // default DE

    expect(t!("auth.signIn")).toBe("Anmelden");         // auth stage, DE

    await act(async () => setLang!("en"));
    expect(t!("sidebar.home")).toBe("Home");            // switched EN
    expect(t!("auth.signIn")).toBe("Sign in");          // auth stage, EN
    expect(localStorage.getItem("gadgets:lang")).toBe("en"); // persisted
  });

  it("switches the Stufe-2 surfaces (routes / chat / billing / gatekeeper-modal) live", async () => {
    await mount();
    // one representative key per newly-wired surface, default DE …
    expect(t!("routes.gatekeepers.title")).toBe("Torwächter");
    expect(t!("chat.composer.followUp")).toBe("Stelle eine Anschlussfrage…");
    expect(t!("billing.addCredit")).toBe("Guthaben aufladen");
    expect(t!("gk.header.createNew")).toBe("Neue Verbindung erstellen");

    await act(async () => setLang!("en"));
    expect(t!("routes.gatekeepers.title")).toBe("Gatekeepers");
    expect(t!("chat.composer.followUp")).toBe("Ask a follow-up…");
    expect(t!("billing.addCredit")).toBe("Add credit");
    expect(t!("gk.header.createNew")).toBe("Create new connection");

    // plural + interpolation path used by the billing usage line
    expect(t!("billing.usageLine", { remaining: "3", limit: "5", requests: t!("billing.request.other") }))
      .toBe("3 of 5 requests left today");
  });

  it("reads the persisted language on mount", async () => {
    localStorage.setItem("gadgets:lang", "en");
    await mount();
    expect(t!("sidebar.blueprints")).toBe("Blueprints");
  });

  it("interpolates {placeholders} and leaves unknown ones intact", async () => {
    await mount();
    expect(t!("theme.switchAction", { mode: "Dunkel" })).toBe("Zu Dunkel wechseln.");
    expect(t!("theme.switchAction")).toBe("Zu {mode} wechseln."); // no params → raw
  });
});
