// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// Side-panel entry: wiring only.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../index.css";
import { chromeGlobal } from "../shared/chromePorts";
import { preciseNow } from "../shared/protocol";
import { PanelApp } from "./Panel";
import { PanelStore, tabIdOverride } from "./panelStore";

const store = new PanelStore(
  chromeGlobal(),
  tabIdOverride(location.search),
  preciseNow,
);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <PanelApp store={store} />
    </StrictMode>,
  );
}
