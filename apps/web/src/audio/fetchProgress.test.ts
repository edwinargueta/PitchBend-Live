// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { EngineError } from "./errors";
import { fetchWithProgress, type FetchLike } from "./fetchProgress";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function fetchReturning(
  response: Response,
): FetchLike & ReturnType<typeof vi.fn> {
  return vi.fn(() => Promise.resolve(response));
}

describe("fetchWithProgress", () => {
  it("streams the body, reporting fractions of Content-Length", async () => {
    const chunks = [
      Uint8Array.from([1, 2]),
      Uint8Array.from([3, 4, 5]),
      Uint8Array.from([6, 7, 8, 9, 10]),
    ];
    const fetchFn = fetchReturning(
      new Response(streamOf(chunks), { headers: { "content-length": "10" } }),
    );
    const fractions: number[] = [];
    const signal = new AbortController().signal;
    const data = await fetchWithProgress(fetchFn, "/media/a.m4a", signal, (f) =>
      fractions.push(f),
    );
    expect(fetchFn).toHaveBeenCalledWith("/media/a.m4a", {
      signal,
      credentials: "same-origin",
    });
    expect([...new Uint8Array(data)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(fractions).toEqual([0.2, 0.5, 1, 1]);
  });

  it("only reports completion without a Content-Length", async () => {
    const fetchFn = fetchReturning(
      new Response(streamOf([Uint8Array.from([1]), Uint8Array.from([2])])),
    );
    const fractions: number[] = [];
    const data = await fetchWithProgress(
      fetchFn,
      "/x",
      new AbortController().signal,
      (f) => fractions.push(f),
    );
    expect(data.byteLength).toBe(2);
    expect(fractions).toEqual([1]);
  });

  it("caps progress when Content-Length undercounts", async () => {
    const fetchFn = fetchReturning(
      new Response(streamOf([new Uint8Array(8)]), {
        headers: { "content-length": "4" },
      }),
    );
    const fractions: number[] = [];
    await fetchWithProgress(fetchFn, "/x", new AbortController().signal, (f) =>
      fractions.push(f),
    );
    expect(fractions).toEqual([1, 1]);
  });

  it("falls back to arrayBuffer() when there is no readable body", async () => {
    const body = Uint8Array.from([9, 8, 7]).buffer;
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "3" }),
      body: null,
      arrayBuffer: () => Promise.resolve(body),
    } as unknown as Response;
    const fractions: number[] = [];
    const data = await fetchWithProgress(
      fetchReturning(response),
      "/x",
      new AbortController().signal,
      (f) => fractions.push(f),
    );
    expect(data).toBe(body);
    expect(fractions).toEqual([1]);
  });

  it("rejects on HTTP errors with a network EngineError naming the status", async () => {
    const fetchFn = fetchReturning(new Response("nope", { status: 404 }));
    const failure = fetchWithProgress(
      fetchFn,
      "/x",
      new AbortController().signal,
      () => undefined,
    );
    await expect(failure).rejects.toThrow("HTTP 404");
    await expect(failure).rejects.toBeInstanceOf(EngineError);
    await expect(failure).rejects.toMatchObject({ kind: "network" });
  });

  it("classifies a failed request as network, keeping the cause", async () => {
    const cause = new TypeError("Failed to fetch");
    const fetchFn: FetchLike = () => Promise.reject(cause);
    await expect(
      fetchWithProgress(
        fetchFn,
        "/x",
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({
      name: "EngineError",
      kind: "network",
      message: expect.stringContaining("Check your connection") as string,
      cause,
    });
  });

  it("classifies a body cut off mid-download as network", async () => {
    const cause = new TypeError("network error");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.error(cause);
      },
    });
    const fetchFn = fetchReturning(
      new Response(body, { headers: { "content-length": "8" } }),
    );
    await expect(
      fetchWithProgress(
        fetchFn,
        "/x",
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ kind: "network", cause });
  });

  it("passes an abort through unclassified", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn: FetchLike = () =>
      Promise.reject(new DOMException("aborted", "AbortError"));
    const failure = fetchWithProgress(
      fetchFn,
      "/x",
      controller.signal,
      () => undefined,
    );
    await expect(failure).rejects.toMatchObject({ name: "AbortError" });
    await expect(failure).rejects.not.toBeInstanceOf(EngineError);
  });

  it("classifies an AbortError that no abort caused as network", async () => {
    const fetchFn: FetchLike = () =>
      Promise.reject(new DOMException("stopped", "AbortError"));
    await expect(
      fetchWithProgress(
        fetchFn,
        "/x",
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ kind: "network" });
  });
});
