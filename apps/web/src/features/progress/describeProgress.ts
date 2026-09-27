import type { SessionPhase, SessionSource } from "../../hooks/sessionReducer";
import type { ProgressStage } from "../../lib/types";

export type StepId = "fetch" | "process" | "play";

export interface ProgressView {
  label: string;
  pct: number | null;
  step: StepId;
}

/** Named stages, never a silent spinner (§1 goal 3). */
export function describeProgress(
  phase: SessionPhase,
  source: SessionSource | null,
  uploadPct: number | null,
  stage: ProgressStage | null,
  pct: number | null,
): ProgressView {
  const upload = source === "upload";
  if (phase === "submitting") {
    return upload
      ? { label: "Uploading…", pct: uploadPct, step: "fetch" }
      : { label: "Contacting the server…", pct: null, step: "fetch" };
  }
  switch (stage) {
    case "queued":
      return { label: "Waiting in line…", pct: null, step: "fetch" };
    case "fetching":
      return {
        label: upload ? "Receiving your file…" : "Fetching audio…",
        pct,
        step: "fetch",
      };
    case "processing":
      return { label: "Processing…", pct, step: "process" };
    case "analyzing":
      return { label: "Analyzing key…", pct, step: "play" };
    case null:
      return { label: "Loading track…", pct: null, step: "play" };
  }
}
