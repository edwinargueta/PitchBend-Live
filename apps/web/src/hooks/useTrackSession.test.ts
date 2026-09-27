import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_READY,
  JOB_DONE,
  JOB_QUEUED,
  KEY_G,
  makeTrack,
  type makeFakeSse,
} from "../features/__tests__/fakeLib";
import * as api from "../lib/api";
import * as sse from "../lib/sse";
import { toSessionError, useTrackSession } from "./useTrackSession";

vi.mock("../lib/api", async () =>
  (await import("../features/__tests__/fakeLib")).makeFakeApi(),
);
vi.mock("../lib/sse", async () =>
  (await import("../features/__tests__/fakeLib")).makeFakeSse(),
);
vi.mock(
  "../lib/errors",
  async () => (await import("../features/__tests__/fakeLib")).fakeErrors,
);

const fakeSse = sse as unknown as ReturnType<typeof makeFakeSse>;
const createJob = vi.mocked(api.createJob);
const uploadFile = vi.mocked(api.uploadFile);
const getTrack = vi.mocked(api.getTrack);

function abortError() {
  return new DOMException("aborted", "AbortError");
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeSse.subscriptions.length = 0;
});

describe("toSessionError", () => {
  it("keeps the code, message and retry time of an ApiError", () => {
    expect(
      toSessionError(new api.ApiError("RATE_LIMITED", "slow", 429, 12)),
    ).toEqual({
      code: "RATE_LIMITED",
      message: "slow",
      retryAfterS: 12,
    });
    expect(toSessionError(new api.ApiError("INVALID_URL", "bad", 400))).toEqual(
      {
        code: "INVALID_URL",
        message: "bad",
      },
    );
  });

  it("maps anything else to INTERNAL", () => {
    expect(toSessionError(new Error("boom"))).toEqual({
      code: "INTERNAL",
      message: "boom",
    });
    expect(toSessionError("weird")).toEqual({
      code: "INTERNAL",
      message: "Unexpected error",
    });
  });
});

describe("useTrackSession", () => {
  it("cache miss: 202 → SSE stages → audio_ready → key_ready → done", async () => {
    createJob.mockResolvedValue(JOB_QUEUED);
    const { result } = renderHook(() => useTrackSession());

    act(() => {
      result.current.submitUrl("https://youtu.be/dQw4w9WgXcQ");
    });
    expect(result.current.state.phase).toBe("submitting");
    expect(createJob).toHaveBeenCalledWith("https://youtu.be/dQw4w9WgXcQ", {
      signal: expect.any(AbortSignal) as AbortSignal,
    });

    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalledTimes(1);
    });
    expect(result.current.state).toMatchObject({
      phase: "waiting",
      stage: "queued",
    });
    const { handlers, jobId } = fakeSse.last();
    expect(jobId).toBe("job-1");

    act(() => {
      handlers.onProgress?.({ stage: "fetching", pct: 30 });
    });
    expect(result.current.state).toMatchObject({ stage: "fetching", pct: 30 });

    act(() => {
      handlers.onAudioReady?.(AUDIO_READY);
    });
    expect(result.current.state.phase).toBe("ready");
    expect(result.current.state.key.status).toBe("pending");

    act(() => {
      handlers.onKeyReady?.(KEY_G);
      handlers.onDone?.();
    });
    expect(result.current.state.key).toEqual({ status: "ready", info: KEY_G });
    expect(result.current.state.done).toBe(true);
  });

  it("KEY_DETECTION_FAILED keeps the track playable", async () => {
    createJob.mockResolvedValue(JOB_QUEUED);
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("u");
    });
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalled();
    });
    const { handlers } = fakeSse.last();
    act(() => {
      handlers.onAudioReady?.(AUDIO_READY);
      handlers.onError?.({ code: "KEY_DETECTION_FAILED", message: "nope" });
      handlers.onDone?.();
    });
    expect(result.current.state.phase).toBe("ready");
    expect(result.current.state.key.status).toBe("failed");
  });

  it("a fatal SSE error before audio → error state", async () => {
    createJob.mockResolvedValue(JOB_QUEUED);
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("u");
    });
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalled();
    });
    act(() => {
      fakeSse
        .last()
        .handlers.onError?.({ code: "SOURCE_BLOCKED", message: "blocked" });
    });
    expect(result.current.state.phase).toBe("error");
    expect(result.current.state.error?.code).toBe("SOURCE_BLOCKED");
  });

  it("cache hit: 200 done → GET /api/tracks → ready with the key, no SSE", async () => {
    createJob.mockResolvedValue(JOB_DONE);
    getTrack.mockResolvedValue(makeTrack());
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("u");
    });
    await waitFor(() => {
      expect(result.current.state.phase).toBe("ready");
    });
    expect(getTrack).toHaveBeenCalledWith("trk-1", {
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(result.current.state.track?.audioUrl).toBe("/media/abc.m4a");
    expect(result.current.state.key.status).toBe("ready");
    expect(fakeSse.subscribeToJob).not.toHaveBeenCalled();
  });

  it("cache hit still analyzing: follows the job for the key", async () => {
    createJob.mockResolvedValue(JOB_DONE);
    getTrack.mockResolvedValue(makeTrack({ key: null }));
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("u");
    });
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalledWith(
        "job-1",
        expect.anything(),
      );
    });
    expect(result.current.state.phase).toBe("ready");
    act(() => {
      fakeSse.last().handlers.onKeyReady?.(KEY_G);
    });
    expect(result.current.state.key.status).toBe("ready");
  });

  it("upload: reports progress, then follows the job", async () => {
    let report: ((pct: number) => void) | undefined;
    let resolveUpload: ((v: typeof JOB_QUEUED) => void) | undefined;
    uploadFile.mockImplementation((_file, opts) => {
      report = opts?.onProgress;
      return new Promise((resolve) => {
        resolveUpload = resolve;
      });
    });
    const { result } = renderHook(() => useTrackSession());
    const file = new File(["abc"], "song.mp3", { type: "audio/mpeg" });
    act(() => {
      result.current.submitFile(file);
    });
    expect(result.current.state).toMatchObject({
      phase: "submitting",
      source: "upload",
      uploadPct: 0,
    });
    act(() => {
      report?.(55);
    });
    expect(result.current.state.uploadPct).toBe(55);
    await act(async () => {
      resolveUpload?.(JOB_QUEUED);
      await Promise.resolve();
    });
    expect(fakeSse.subscribeToJob).toHaveBeenCalled();
    expect(result.current.state.phase).toBe("waiting");
  });

  it("rejects files over the upload limit without uploading", () => {
    const { result } = renderHook(() => useTrackSession());
    const big = new File(["x"], "big.wav");
    Object.defineProperty(big, "size", { value: 51 * 1024 * 1024 });
    act(() => {
      result.current.submitFile(big);
    });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.current.state.error?.code).toBe("FILE_TOO_LARGE");
    act(() => {
      result.current.retry(); // nothing to retry
    });
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("API errors (e.g. RATE_LIMITED) → error with retry_after_s", async () => {
    createJob.mockRejectedValue(
      new api.ApiError("RATE_LIMITED", "slow", 429, 90),
    );
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("u");
    });
    await waitFor(() => {
      expect(result.current.state.phase).toBe("error");
    });
    expect(result.current.state.error).toEqual({
      code: "RATE_LIMITED",
      message: "slow",
      retryAfterS: 90,
    });
    expect(result.current.canRetry).toBe(true);
  });

  it("a NOT_FOUND track on a cache hit → error", async () => {
    createJob.mockResolvedValue(JOB_DONE);
    getTrack.mockRejectedValue(new api.ApiError("NOT_FOUND", "gone", 404));
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("u");
    });
    await waitFor(() => {
      expect(result.current.state.error?.code).toBe("NOT_FOUND");
    });
  });

  it("retry re-submits the last URL and the last file", async () => {
    createJob.mockRejectedValueOnce(new api.ApiError("INTERNAL", "x", 500));
    createJob.mockResolvedValueOnce(JOB_QUEUED);
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.retry(); // nothing yet: no-op
    });
    expect(createJob).not.toHaveBeenCalled();
    act(() => {
      result.current.submitUrl("the-url");
    });
    await waitFor(() => {
      expect(result.current.state.phase).toBe("error");
    });
    act(() => {
      result.current.retry();
    });
    expect(createJob).toHaveBeenLastCalledWith("the-url", expect.anything());

    uploadFile.mockRejectedValueOnce(new Error("net"));
    uploadFile.mockResolvedValueOnce(JOB_QUEUED);
    const file = new File(["a"], "a.mp3");
    act(() => {
      result.current.submitFile(file);
    });
    await waitFor(() => {
      expect(result.current.state.phase).toBe("error");
    });
    act(() => {
      result.current.retry();
    });
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(uploadFile.mock.calls[1]?.[0]).toBe(file);
  });

  it("a new submission cancels the previous run and ignores its late results", async () => {
    let resolveFirst: ((v: typeof JOB_QUEUED) => void) | undefined;
    createJob.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    createJob.mockResolvedValueOnce({
      job_id: "job-2",
      track_id: "trk-2",
      status: "queued",
    });
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("first");
    });
    const firstSignal = createJob.mock.calls[0]?.[1]?.signal;
    act(() => {
      result.current.submitUrl("second");
    });
    expect(firstSignal?.aborted).toBe(true);
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalledWith(
        "job-2",
        expect.anything(),
      );
    });
    await act(async () => {
      resolveFirst?.(JOB_QUEUED);
      await Promise.resolve();
    });
    expect(fakeSse.subscribeToJob).toHaveBeenCalledTimes(1);
    expect(result.current.state.jobId).toBe("job-2");
  });

  it("starting a new track unsubscribes from the old job's events", async () => {
    createJob.mockResolvedValue(JOB_QUEUED);
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("a");
    });
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalledTimes(1);
    });
    const first = fakeSse.last();
    act(() => {
      result.current.submitUrl("b");
    });
    expect(first.unsubscribe).toHaveBeenCalled();
    // Late events from the old stream are ignored.
    act(() => {
      first.handlers.onAudioReady?.(AUDIO_READY);
    });
    expect(result.current.state.phase).not.toBe("ready");
  });

  it("reset and unmount close the stream", async () => {
    createJob.mockResolvedValue(JOB_QUEUED);
    const { result, unmount } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("a");
    });
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalledTimes(1);
    });
    act(() => {
      result.current.reset();
    });
    expect(fakeSse.last().unsubscribe).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe("idle");
    expect(result.current.canRetry).toBe(false);

    act(() => {
      result.current.submitUrl("b");
    });
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalledTimes(2);
    });
    unmount();
    expect(fakeSse.last().unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("aborted requests don't surface as errors", async () => {
    createJob.mockRejectedValue(abortError());
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("a");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state.phase).toBe("submitting");
  });

  it("a lost stream recovers from the track record when the audio is ready", async () => {
    createJob.mockResolvedValue(JOB_QUEUED);
    getTrack.mockResolvedValue(makeTrack({ key: null }));
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("a");
    });
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalled();
    });
    act(() => {
      fakeSse.last().handlers.onConnectionError?.();
    });
    await waitFor(() => {
      expect(result.current.state.phase).toBe("ready");
    });
    expect(result.current.state.key.status).toBe("failed"); // done without a key
  });

  it("a lost stream before the audio is ready → connection error", async () => {
    createJob.mockResolvedValue(JOB_QUEUED);
    getTrack.mockResolvedValue(
      makeTrack({ status: "fetching", audio_url: null, key: null }),
    );
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("a");
    });
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalled();
    });
    act(() => {
      fakeSse.last().handlers.onConnectionError?.();
    });
    await waitFor(() => {
      expect(result.current.state.phase).toBe("error");
    });
    expect(result.current.state.error?.code).toBe("INTERNAL");
  });

  it("a connection error after done is ignored", async () => {
    createJob.mockResolvedValue(JOB_QUEUED);
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("a");
    });
    await waitFor(() => {
      expect(fakeSse.subscribeToJob).toHaveBeenCalled();
    });
    const { handlers } = fakeSse.last();
    act(() => {
      handlers.onAudioReady?.(AUDIO_READY);
      handlers.onDone?.();
      handlers.onConnectionError?.();
    });
    expect(getTrack).not.toHaveBeenCalled();
  });

  it("a synchronous client throw → error", async () => {
    createJob.mockImplementationOnce(() => {
      throw new Error("sync");
    });
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("a");
    });
    await waitFor(() => {
      expect(result.current.state.error?.message).toBe("sync");
    });
  });

  it("a subscribe failure → error", async () => {
    createJob.mockResolvedValue(JOB_QUEUED);
    fakeSse.subscribeToJob.mockImplementationOnce(() => {
      throw new Error("no EventSource");
    });
    const { result } = renderHook(() => useTrackSession());
    act(() => {
      result.current.submitUrl("a");
    });
    await waitFor(() => {
      expect(result.current.state.phase).toBe("error");
    });
  });
});
