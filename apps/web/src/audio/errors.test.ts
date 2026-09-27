import { describe, expect, it } from "vitest";
import { asEngineError, EngineError, isEngineError } from "./errors";

describe("EngineError", () => {
  it("is an Error with a kind, an optional hint and the original cause", () => {
    const cause = new DOMException("bad data", "EncodingError");
    const err = new EngineError("decode", "Couldn't decode.", {
      cause,
      hint: "no-aac",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EngineError");
    expect(err.kind).toBe("decode");
    expect(err.hint).toBe("no-aac");
    expect(err.message).toBe("Couldn't decode.");
    expect(err.cause).toBe(cause);
  });

  it("has no hint and no cause unless given", () => {
    const err = new EngineError("network", "Offline.");
    expect(err.hint).toBeNull();
    expect("cause" in err).toBe(false);
    // An explicit undefined cause is still recorded.
    expect(
      "cause" in new EngineError("network", "x", { cause: undefined }),
    ).toBe(true);
  });

  it("isEngineError tells classified failures apart", () => {
    expect(isEngineError(new EngineError("playback", "x"))).toBe(true);
    expect(isEngineError(new Error("x"))).toBe(false);
    expect(isEngineError("x")).toBe(false);
  });
});

describe("asEngineError", () => {
  it("keeps an EngineError as it is", () => {
    const err = new EngineError("unsupported", "No WebAssembly.");
    expect(asEngineError(err, "processor", "fallback")).toBe(err);
  });

  it("wraps anything else with the given kind and message", () => {
    const cause = new TypeError("boom");
    const err = asEngineError(cause, "processor", "It broke.");
    expect(err).toMatchObject({
      kind: "processor",
      message: "It broke.",
      cause,
    });
    expect(asEngineError("text", "decode", "m").cause).toBe("text");
  });
});
