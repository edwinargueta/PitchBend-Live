// Spec: THDSPEC/chrome-extension-live-transpose.spec.md · ADR 0009
// The content script's brain: per-tab settings in, audio graph and status out.
//
// State machine (protocol.ts AttachState):
//   idle ──(transpose ≠ 0)──▶ no-video ──(video appears)──┐
//     │                                                   ▼
//     ├──(page has no user activation)──▶ waiting-gesture ──(click/key)──┐
//     └──(activation)─────────────────────────────────────────────────────┴▶ starting ─▶ active | error
//
// The graph is created only once the AudioContext is running (FR-9). After
// that it stays for the life of the page (liveGraph.ts explains why); going
// back to 0 or bypassing just fades to the dry path, so "Original" really is
// the original audio, with no added delay.
import type { Logger } from "../shared/log";
import {
  isCommand,
  type AttachState,
  type Command,
  type Site,
  type TabSettings,
  type TabStatus,
} from "../shared/protocol";
import type { MessageListener, RuntimePort } from "../shared/chromePorts";
import {
  applyCommand,
  DEFAULT_SETTINGS,
  onVideoChanged,
  parseSettings,
  wantsShift,
} from "../shared/tabState";
import type { LiveGraph } from "./liveGraph";

export const GESTURE_COPY = "Click the video once to enable PitchBend Live.";
export const NO_VIDEO_COPY = "No video found on this page.";

export interface ControllerDeps {
  readonly site: Site | null;
  createContext(): AudioContext;
  createGraph(ctx: AudioContext): LiveGraph;
  /** navigator.userActivation.hasBeenActive: may an AudioContext start now? */
  hasActivation(): boolean;
  /** Call `callback` once on the next click/key on the page; returns a canceller. */
  onGesture(callback: () => void): () => void;
  publish(status: TabStatus): void;
  now(): number;
  readonly log: Logger;
}

export class ContentController {
  private readonly deps: ControllerDeps;
  private settings: TabSettings = DEFAULT_SETTINGS;
  private state: AttachState = "idle";
  private video: HTMLVideoElement | null = null;
  private ctx: AudioContext | null = null;
  private graph: LiveGraph | null = null;
  private error: string | null = null;
  private appliedAt: number | null = null;
  private sentAt: number | null = null;
  private cancelGesture: (() => void) | null = null;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  /** The live graph, once attached (the e2e probe taps it). */
  get liveGraph(): LiveGraph | null {
    return this.graph;
  }

  status(): TabStatus {
    return {
      state: this.state,
      settings: this.settings,
      site: this.deps.site,
      shifterMs: this.graph?.shifterMs ?? null,
      addedMs: this.graph?.addedMs ?? null,
      error: this.error,
      appliedAt: this.appliedAt,
      sentAt: this.sentAt,
    };
  }

  /** Apply a command from the panel or a shortcut; returns the new status. */
  handle(cmd: Command): TabStatus {
    if (cmd.type === "getStatus") return this.status();
    const before = this.settings;
    this.settings = applyCommand(before, cmd);
    this.sync(before, cmd.sentAt ?? null);
    return this.status();
  }

  /** Settings saved for this tab before a reload (FR-7). */
  restore(settings: TabSettings): void {
    const before = this.settings;
    this.settings = settings;
    this.sync(before, null);
  }

  /** The tracker found a (different) main video, or lost it. */
  setVideo(video: HTMLVideoElement | null): void {
    this.video = video;
    if (video && this.graph) {
      const attached = this.graph.attach(video);
      if (!attached.ok) this.fail(attached.error.message);
    } else if (video && this.state === "no-video") {
      this.state = "idle";
      this.ensureAttached();
    } else if (!video && !this.graph && wantsShift(this.settings)) {
      this.state = "no-video";
      this.error = NO_VIDEO_COPY;
    }
    this.publish();
  }

  /** A new video started in this tab (FR-6, AC-8). */
  videoChanged(): void {
    this.settings = onVideoChanged(this.settings);
    this.publish();
  }

  dispose(): void {
    this.cancelGesture?.();
    this.graph?.dispose();
  }

  private sync(before: TabSettings, sentAt: number | null): void {
    if (this.graph) {
      if (before.semitones !== this.settings.semitones) {
        this.graph.setShift(this.settings.semitones);
        this.stamp(sentAt);
      }
      this.applyMix();
      if (this.state === "error" && !this.graph.shifterReady) {
        // The shifter failed earlier: a new request is the retry.
        this.state = "starting";
        this.error = null;
        void this.startShifter(this.graph);
      }
    } else if (wantsShift(this.settings)) {
      this.ensureAttached();
    }
    this.publish();
  }

  private ensureAttached(): void {
    if (this.state === "waiting-gesture" || this.state === "starting") return;
    if (!this.video) {
      this.state = "no-video";
      this.error = NO_VIDEO_COPY;
      return;
    }
    if (!this.ctx && !this.deps.hasActivation()) {
      this.waitForGesture();
      return;
    }
    void this.resumeAndAttach();
  }

  private waitForGesture(): void {
    this.state = "waiting-gesture";
    this.error = GESTURE_COPY;
    this.cancelGesture?.();
    this.cancelGesture = this.deps.onGesture(() => {
      this.cancelGesture = null;
      this.state = "idle";
      void this.resumeAndAttach();
    });
  }

  private async resumeAndAttach(): Promise<void> {
    this.state = "starting";
    this.error = null;
    this.ctx ??= this.deps.createContext();
    const ctx = this.ctx;
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch (cause) {
        this.deps.log.warn("The audio context couldn't resume.", cause);
      }
    }
    if (ctx.state !== "running") {
      this.waitForGesture();
      this.publish();
      return;
    }
    this.attach(ctx);
  }

  private attach(ctx: AudioContext): void {
    const video = this.video;
    if (!video) {
      this.state = "no-video";
      this.error = NO_VIDEO_COPY;
      this.publish();
      return;
    }
    const graph = this.deps.createGraph(ctx);
    const attached = graph.attach(video);
    if (!attached.ok) {
      this.fail(attached.error.message);
      this.publish();
      return;
    }
    graph.scheduleErrorHandler = (error) => {
      this.deps.log.warn("A pitch change didn't reach the shifter.", error);
    };
    this.graph = graph;
    graph.setShift(this.settings.semitones);
    this.applyMix();
    this.stamp(null);
    this.publish();
    void this.startShifter(graph);
  }

  private async startShifter(graph: LiveGraph): Promise<void> {
    const started = await graph.startShifter();
    if (started.ok) {
      this.state = "active";
      this.error = null;
      this.stamp(null);
    } else {
      this.deps.log.error(started.error.message, started.error.cause);
      this.fail(
        `${started.error.message} The video plays without transposing.`,
      );
    }
    this.publish();
  }

  /** Dry when bypassed or at 0 (the original, without the shifter's delay). */
  private applyMix(): void {
    this.graph?.setBypass(
      this.settings.bypass || this.settings.semitones === 0,
    );
  }

  private stamp(sentAt: number | null): void {
    this.appliedAt = this.deps.now();
    this.sentAt = sentAt;
  }

  private fail(message: string): void {
    this.state = "error";
    this.error = message;
  }

  private publish(): void {
    this.deps.publish(this.status());
  }
}

/**
 * runtime.onMessage listener: only the extension itself may send commands
 * (spec Security); anything else, or a malformed command, is ignored.
 */
export function createMessageListener(
  controller: ContentController,
  extensionId: string,
): MessageListener {
  return (message, sender, sendResponse) => {
    if (sender.id !== extensionId || !isCommand(message)) return undefined;
    sendResponse(controller.handle(message));
    return undefined;
  };
}

/** Ask the service worker for this tab's saved settings (FR-7 reload). */
export async function restoreSettings(
  runtime: Pick<RuntimePort, "sendMessage">,
  controller: ContentController,
  log: Logger,
): Promise<void> {
  let saved: unknown;
  try {
    saved = await runtime.sendMessage({ type: "restoreRequest" });
  } catch (cause) {
    log.warn("Couldn't read this tab's saved settings.", cause);
    return;
  }
  const settings = parseSettings(saved);
  if (settings !== DEFAULT_SETTINGS) controller.restore(settings);
}

/**
 * Run `callback` on the next pointerdown or keydown anywhere on the page: the
 * events that grant user activation, so the AudioContext may start in them.
 * Returns a canceller.
 */
export function onPageGesture(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  callback: () => void,
): () => void {
  const events = ["pointerdown", "keydown"] as const;
  const cancel = (): void => {
    for (const type of events) target.removeEventListener(type, handler, true);
  };
  function handler(): void {
    cancel();
    callback();
  }
  for (const type of events) target.addEventListener(type, handler, true);
  return cancel;
}

export function siteOf(hostname: string): Site | null {
  if (hostname === "www.youtube.com") return "youtube";
  if (hostname === "music.youtube.com") return "music";
  return null;
}
