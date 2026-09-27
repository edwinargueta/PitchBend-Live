import { describe, expect, it, vi } from "vitest";
import {
  AAC_MIME,
  aacSupported,
  AudioUnsupportedError,
  checkWebAssembly,
  createAudioContext,
  createOfflineContext,
  decodeAudio,
  decodeError,
  preferPlaybackSession,
  type AudioGlobals,
} from "./browser";
import { EngineError } from "./errors";
import { fakeAudioBuffer } from "./testing/fakes";

/** A WebAssembly global whose Module compiles anything. */
const WASM: AudioGlobals["WebAssembly"] = {
  Module: class {
    readonly compiled = true;
  },
};

function contextClass(opts: { worklet?: boolean } = {}) {
  const created: { options: unknown; close: ReturnType<typeof vi.fn> }[] = [];
  class Ctx {
    readonly audioWorklet = opts.worklet === false ? undefined : {};
    readonly close = vi.fn(() => Promise.resolve());
    constructor(options?: unknown) {
      created.push({ options, close: this.close });
    }
  }
  return {
    Ctor: Ctx as unknown as NonNullable<AudioGlobals["AudioContext"]>,
    created,
  };
}

describe("createAudioContext", () => {
  it("uses AudioContext with an interactive latency hint", () => {
    const { Ctor, created } = contextClass();
    const ctx = createAudioContext({ AudioContext: Ctor, WebAssembly: WASM });
    expect(ctx).toBeInstanceOf(Ctor);
    expect(created[0]?.options).toEqual({ latencyHint: "interactive" });
  });

  it("falls back to Safari's webkitAudioContext", () => {
    const { Ctor } = contextClass();
    expect(
      createAudioContext({ webkitAudioContext: Ctor, WebAssembly: WASM }),
    ).toBeInstanceOf(Ctor);
  });

  it("throws a clear unsupported error without Web Audio", () => {
    expect(() => createAudioContext({ WebAssembly: WASM })).toThrow(
      AudioUnsupportedError,
    );
    expect(() => createAudioContext({ WebAssembly: WASM })).toThrow(
      expect.objectContaining({ kind: "unsupported" }) as Error,
    );
  });

  it("fails up front, before creating a context, without WebAssembly", () => {
    const { Ctor, created } = contextClass();
    expect(() => createAudioContext({ AudioContext: Ctor })).toThrow(
      expect.objectContaining({
        kind: "unsupported",
        hint: "no-wasm",
        message: expect.stringContaining("WebAssembly") as string,
      }) as Error,
    );
    expect(created).toHaveLength(0);
  });

  it("closes the context and throws when AudioWorklet is missing", () => {
    const { Ctor, created } = contextClass({ worklet: false });
    expect(() =>
      createAudioContext({ AudioContext: Ctor, WebAssembly: WASM }),
    ).toThrow(/AudioWorklet/);
    expect(created[0]?.close).toHaveBeenCalled();
  });

  it("asks iOS for a playback audio session", () => {
    const { Ctor } = contextClass();
    const navigator = { audioSession: { type: "auto" } };
    createAudioContext({ AudioContext: Ctor, navigator, WebAssembly: WASM });
    expect(navigator.audioSession.type).toBe("playback");
  });

  it("uses the real globals by default", () => {
    // jsdom has no Web Audio at all.
    expect(() => createAudioContext()).toThrow(AudioUnsupportedError);
  });
});

describe("AudioUnsupportedError", () => {
  it("is an EngineError of kind unsupported", () => {
    const cause = new Error("why");
    const err = new AudioUnsupportedError("No.", { cause, hint: "no-wasm" });
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({
      name: "AudioUnsupportedError",
      kind: "unsupported",
      hint: "no-wasm",
      cause,
    });
    expect(new AudioUnsupportedError("No.").hint).toBeNull();
  });
});

describe("checkWebAssembly", () => {
  it("passes when a tiny module compiles", () => {
    const compiled: unknown[] = [];
    const WebAssembly = {
      Module: class {
        readonly exports = {};
        constructor(bytes: Uint8Array) {
          compiled.push([...bytes]);
        }
      },
    };
    expect(() => {
      checkWebAssembly({ WebAssembly });
    }).not.toThrow();
    // "\0asm", version 1: the smallest valid module.
    expect(compiled).toEqual([[0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]]);
  });

  it("rejects a missing WebAssembly (e.g. Chromium --jitless)", () => {
    for (const g of [{}, { WebAssembly: {} }] as AudioGlobals[]) {
      expect(() => {
        checkWebAssembly(g);
      }).toThrow(
        expect.objectContaining({
          kind: "unsupported",
          hint: "no-wasm",
        }) as Error,
      );
    }
  });

  it("rejects WebAssembly that isn't allowed to compile, keeping the cause", () => {
    const cause = new Error("Wasm code generation disallowed by embedder");
    const WebAssembly = {
      Module: class {
        readonly exports = {};
        constructor() {
          throw cause;
        }
      },
    };
    let caught: unknown;
    try {
      checkWebAssembly({ WebAssembly });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AudioUnsupportedError);
    expect(caught).toMatchObject({ hint: "no-wasm", cause });
  });

  it("uses the real globals by default (Node has WebAssembly)", () => {
    expect(() => {
      checkWebAssembly();
    }).not.toThrow();
  });
});

describe("aacSupported", () => {
  const audio = (answer: string) =>
    class {
      canPlayType(type: string) {
        return type === AAC_MIME ? answer : "";
      }
    };
  const mse = (supported: boolean) => ({
    isTypeSupported: (type: string) => type === AAC_MIME && supported,
  });

  it("is true when every available probe says yes", () => {
    expect(aacSupported({ Audio: audio("probably") })).toBe(true);
    expect(
      aacSupported({ Audio: audio("maybe"), MediaSource: mse(true) }),
    ).toBe(true);
    expect(aacSupported({ ManagedMediaSource: mse(true) })).toBe(true);
  });

  it('is false when the media element answers "" (no AAC decoder)', () => {
    expect(aacSupported({ Audio: audio(""), MediaSource: mse(true) })).toBe(
      false,
    );
  });

  it("is false when MediaSource rejects the type", () => {
    expect(
      aacSupported({ Audio: audio("probably"), MediaSource: mse(false) }),
    ).toBe(false);
  });

  it("is null when nothing can be asked", () => {
    expect(aacSupported({})).toBeNull();
    expect(aacSupported({ MediaSource: {} })).toBeNull();
  });

  it("skips probes that throw", () => {
    const throwing = {
      isTypeSupported: () => {
        throw new Error("nope");
      },
    };
    class BrokenAudio {
      constructor() {
        throw new Error("no media elements");
      }
      canPlayType() {
        return "probably";
      }
    }
    expect(
      aacSupported({ MediaSource: throwing, ManagedMediaSource: mse(false) }),
    ).toBe(false);
    expect(aacSupported({ Audio: BrokenAudio })).toBeNull();
  });

  it('uses the real globals by default (jsdom\'s media element says "")', () => {
    expect(aacSupported()).toBe(false);
  });
});

describe("decodeError", () => {
  const cause = new DOMException(
    "Unable to decode audio data",
    "EncodingError",
  );

  it("names AAC when the browser says it can't play it", () => {
    const err = decodeError(cause, {
      Audio: class {
        canPlayType = () => "";
      },
    });
    expect(err).toMatchObject({ kind: "decode", hint: "no-aac", cause });
    expect(err.message).toMatch(/can't decode AAC audio/);
  });

  it("is a plain decode failure otherwise", () => {
    for (const g of [
      {},
      {
        Audio: class {
          canPlayType = () => "probably";
        },
      },
    ] as AudioGlobals[]) {
      const err = decodeError(cause, g);
      expect(err).toMatchObject({ kind: "decode", hint: null, cause });
      expect(err.message).toBe("This audio file couldn't be decoded.");
    }
  });

  it("uses the real globals by default", () => {
    expect(decodeError(cause).kind).toBe("decode");
  });
});

describe("preferPlaybackSession", () => {
  it("ignores browsers without an audio session", () => {
    expect(() => {
      preferPlaybackSession({ navigator: {} });
    }).not.toThrow();
    expect(() => {
      preferPlaybackSession({});
    }).not.toThrow();
  });

  it("survives a session that refuses the value", () => {
    const audioSession = {
      get type() {
        return "auto";
      },
      set type(_v: string) {
        throw new TypeError("read-only");
      },
    };
    expect(() => {
      preferPlaybackSession({ navigator: { audioSession } });
    }).not.toThrow();
  });
});

describe("createOfflineContext", () => {
  it("uses the positional constructor, falling back to the webkit prefix", () => {
    const args: unknown[][] = [];
    class Offline {
      readonly kind = "offline";
      constructor(...a: unknown[]) {
        args.push(a);
      }
    }
    const Ctor = Offline as unknown as NonNullable<
      AudioGlobals["OfflineAudioContext"]
    >;
    expect(
      createOfflineContext(2, 100, 44_100, { OfflineAudioContext: Ctor }),
    ).toBeInstanceOf(Offline);
    expect(
      createOfflineContext(1, 5, 8000, { webkitOfflineAudioContext: Ctor }),
    ).toBeInstanceOf(Offline);
    expect(args).toEqual([
      [2, 100, 44_100],
      [1, 5, 8000],
    ]);
  });

  it("throws without offline rendering support", () => {
    expect(() => createOfflineContext(2, 1, 44_100, {})).toThrow(
      AudioUnsupportedError,
    );
    expect(() => createOfflineContext(2, 1, 44_100)).toThrow(
      AudioUnsupportedError,
    );
  });
});

describe("decodeAudio", () => {
  const data = new ArrayBuffer(8);
  const decoded = fakeAudioBuffer(2, 10);

  function ctxWith(
    decodeAudioData: (...a: never[]) => unknown,
  ): BaseAudioContext {
    return { decodeAudioData } as unknown as BaseAudioContext;
  }

  it("uses the promise form", async () => {
    const ctx = ctxWith(() => Promise.resolve(decoded));
    await expect(decodeAudio(ctx, data)).resolves.toBe(decoded);
  });

  it("supports the callback-only form (old Safari returns undefined)", async () => {
    const ctx = ctxWith((_d: ArrayBuffer, ok: (b: AudioBuffer) => void) => {
      setTimeout(() => {
        ok(decoded);
      }, 0);
      return undefined;
    });
    await expect(decodeAudio(ctx, data)).resolves.toBe(decoded);
  });

  it("wraps a callback failure with a null error as a decode EngineError", async () => {
    const ctx = ctxWith(
      (_d: ArrayBuffer, _ok: unknown, fail: (e: unknown) => void) => {
        fail(null);
        return undefined;
      },
    );
    const failure = decodeAudio(ctx, data, {});
    await expect(failure).rejects.toThrow("couldn't be decoded");
    await expect(failure).rejects.toMatchObject({ kind: "decode" });
  });

  it("wraps a promise rejection once, keeping the cause", async () => {
    const cause = new DOMException("bad data", "EncodingError");
    const canPlayType = vi.fn(() => "probably");
    const ctx = ctxWith(
      (_d: ArrayBuffer, _ok: unknown, fail: (e: unknown) => void) => {
        fail(cause); // modern browsers call back *and* reject
        return Promise.reject(cause);
      },
    );
    await expect(
      decodeAudio(ctx, data, {
        Audio: class {
          canPlayType = canPlayType;
        },
      }),
    ).rejects.toMatchObject({ kind: "decode", hint: null, cause });
    expect(canPlayType).toHaveBeenCalledTimes(1);
  });

  it("explains a failure in a browser without AAC (e.g. VS Code's built-in browser)", async () => {
    const ctx = ctxWith(() =>
      Promise.reject(new DOMException("x", "EncodingError")),
    );
    await expect(
      decodeAudio(ctx, data, {
        Audio: class {
          canPlayType = () => "";
        },
      }),
    ).rejects.toMatchObject({ kind: "decode", hint: "no-aac" });
  });

  it("wraps a synchronous throw", async () => {
    const ctx = ctxWith(() => {
      throw new TypeError("detached");
    });
    await expect(decodeAudio(ctx, data, {})).rejects.toThrow(
      "couldn't be decoded",
    );
  });
});
