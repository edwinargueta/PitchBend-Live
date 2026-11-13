// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// The side panel (FR-3): dial, bypass, original key, readout, added delay and
// shortcuts for the tab it controls. Presentational: PanelStore (panelStore.ts) does the I/O.
import { useSyncExternalStore } from "react";
import { KeyDial } from "../../features/key-dial/KeyDial";
import type { Command } from "../shared/protocol";
import { KeyPicker } from "./KeyPicker";
import {
  capoLine,
  delayLine,
  dialCaption,
  dialText,
  nowLine,
  SHORTCUT_HELP,
  statusCopy,
} from "./readout";
import type { PanelStore, PanelView } from "./panelStore";
import "./panel.css";

interface PanelProps {
  view: PanelView;
  send: (command: Command) => void;
}

export const NOT_YOUTUBE_COPY =
  "Open a YouTube or YouTube Music video in this tab to transpose it.";
export const NO_RECEIVER_COPY =
  "Reload this YouTube tab to start PitchBend Live.";

function Message({ text }: { text: string }) {
  return (
    <p className="panel__message" role="status">
      {text}
    </p>
  );
}

/** The panel bound to a store (the entry renders this). */
export function PanelApp({ store }: { store: PanelStore }) {
  const view = useSyncExternalStore(store.subscribe, store.getView);
  return <Panel view={view} send={store.send} />;
}

export function Panel({ view, send }: PanelProps) {
  return (
    <main className="panel">
      <h1 className="panel__title">PitchBend Live</h1>
      {view.kind === "loading" && <Message text="Connecting to this tab…" />}
      {view.kind === "not-youtube" && <Message text={NOT_YOUTUBE_COPY} />}
      {view.kind === "no-receiver" && <Message text={NO_RECEIVER_COPY} />}
      {view.kind === "ready" && <Controls status={view.status} send={send} />}
    </main>
  );
}

function Controls({
  status,
  send,
}: {
  status: Extract<PanelView, { kind: "ready" }>["status"];
  send: (command: Command) => void;
}) {
  const { settings } = status;
  const copy = statusCopy(status);
  const capo = capoLine(settings);
  const delay = delayLine(status);

  return (
    <>
      <p
        className={`panel__status panel__status--${copy.tone}`}
        role="status"
        aria-live="polite"
      >
        {copy.text}
      </p>
      <KeyDial
        value={settings.semitones}
        onChange={(semitones) => {
          send({ type: "set", semitones });
        }}
        valueText={dialText(settings)}
        caption={dialCaption(settings)}
      />
      <button
        type="button"
        className="btn panel__bypass"
        aria-pressed={settings.bypass}
        onClick={() => {
          send({ type: "setBypass", on: !settings.bypass });
        }}
      >
        {settings.bypass ? "Bypassed: playing the original" : "Bypass"}
      </button>
      <section className="card panel__card" aria-label="Key">
        <KeyPicker
          value={settings.key}
          onChange={(key) => {
            send({ type: "setKey", key });
          }}
        />
        <p className="panel__now">
          <span className="panel__label">Now:</span> {nowLine(settings)}
        </p>
        {capo && <p className="hint">{capo}</p>}
      </section>
      {delay && <p className="hint">{delay}</p>}
      <details className="panel__shortcuts">
        <summary>Keyboard shortcuts</summary>
        <ul>
          {SHORTCUT_HELP.map(({ keys, action }) => (
            <li key={keys}>
              <kbd>{keys}</kbd> {action}
            </li>
          ))}
        </ul>
        <p className="hint">
          Change them at chrome://extensions/shortcuts. In this panel, the dial
          also takes ← → and 0.
        </p>
      </details>
    </>
  );
}
