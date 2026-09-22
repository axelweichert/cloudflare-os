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
