import { describe, expect, it } from "vitest";
import { EngineError, type EngineErrorKind } from "../../audio/errors";
import {
  describeEngineError,
  isEmbeddedBrowser,
  technicalDetails,
} from "./engineErrorCopy";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const VSCODE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.104.0 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36";

const BROWSER_TITLE = "This browser can’t play KeyShift audio";
const OPEN_ELSEWHERE = "Open this page in Chrome, Safari or Firefox.";

describe("isEmbeddedBrowser", () => {
  it("spots Electron apps and VS Code, not ordinary browsers", () => {
    expect(isEmbeddedBrowser(VSCODE)).toBe(true);
    expect(isEmbeddedBrowser("Something Electron/30.0.0")).toBe(true);
    expect(isEmbeddedBrowser("Mozilla/5.0 Code/1.90.0")).toBe(true);
    expect(isEmbeddedBrowser(CHROME)).toBe(false);
    expect(isEmbeddedBrowser("Mozilla/5.0 QRCode/2.0")).toBe(false);
    expect(isEmbeddedBrowser("")).toBe(false);
  });
});

describe("describeEngineError", () => {
  it("unsupported: the browser can't play KeyShift audio, open another one", () => {
    const copy = describeEngineError(
      new EngineError("unsupported", "No AudioWorklet."),
      CHROME,
    );
    expect(copy.title).toBe(BROWSER_TITLE);
    expect(copy.message).toBe(
      `It’s missing Web Audio features KeyShift needs. Embedded browsers like VS Code’s built-in browser lack the AAC decoder or block WebAssembly. ${OPEN_ELSEWHERE}`,
    );
    expect(copy.retryable).toBe(false);
  });

  it("unsupported without WebAssembly names it", () => {
    const copy = describeEngineError(
      new EngineError("unsupported", "No wasm.", { hint: "no-wasm" }),
      CHROME,
    );
    expect(copy.title).toBe(BROWSER_TITLE);
    expect(copy.message).toMatch(
      /^It blocks WebAssembly, which KeyShift’s pitch shifter needs/,
    );
    expect(copy.message).toContain(OPEN_ELSEWHERE);
    expect(copy.retryable).toBe(false);
  });

  it("decode without AAC is a browser problem, stronger in an embedded browser", () => {
    const err = new EngineError("decode", "No AAC.", { hint: "no-aac" });
    const plain = describeEngineError(err, CHROME);
    expect(plain.title).toBe(BROWSER_TITLE);
    expect(plain.message).toMatch(
      /^It can’t decode AAC audio, the format KeyShift plays\./,
    );
    expect(plain.retryable).toBe(false);

    const embedded = describeEngineError(err, VSCODE);
    expect(embedded.message).toBe(
      `It can’t decode AAC audio, the format KeyShift plays. This looks like an embedded browser (such as VS Code’s built-in one), and those lack the AAC decoder or block WebAssembly. ${OPEN_ELSEWHERE}`,
    );
  });

  it("any other decode failure points at the file", () => {
    const copy = describeEngineError(
      new EngineError("decode", "Couldn't decode."),
      VSCODE,
    );
    expect(copy).toMatchObject({
      title: "We couldn’t decode this audio",
      message:
        "The file may be damaged, or this browser can’t read its format. Try another song or file.",
      retryable: false,
    });
  });

  it.each<[EngineErrorKind, string, string]>([
    [
      "network",
      "Couldn’t download the audio",
      "Check your internet connection, then try again.",
    ],
    [
      "processor",
      "The audio processor stopped",
      "Something went wrong inside the browser’s audio engine. Try again to reload the song.",
    ],
    [
      "playback",
      "The browser blocked playback",
      "Press Play again to start the audio.",
    ],
  ])("%s is retryable with its own copy", (kind, title, message) => {
    expect(
      describeEngineError(new EngineError(kind, "raw"), CHROME),
    ).toMatchObject({ title, message, retryable: true });
  });

  it("a failure with no details still explains and offers a retry", () => {
    expect(describeEngineError(null, CHROME)).toMatchObject({
      title: "We couldn’t play this audio",
      retryable: true,
    });
  });

  it("uses the real user agent by default", () => {
    const copy = describeEngineError(new EngineError("network", "x"));
    expect(copy.details).toContain(`Browser: ${navigator.userAgent}`);
  });
});

describe("technicalDetails", () => {
  it("lists the kind, hint, message, cause chain and browser", () => {
    const root = new TypeError("root cause");
    const middle = new Error("middle", { cause: root });
    const err = new EngineError("decode", "No AAC.", {
      cause: middle,
      hint: "no-aac",
    });
    expect(technicalDetails(err, VSCODE)).toBe(
      [
        "Kind: decode (no-aac)",
        "Error: No AAC.",
        "Cause: Error: middle",
        "Cause: TypeError: root cause",
        `Browser: ${VSCODE}`,
      ].join("\n"),
    );
  });

  it("handles non-Error causes, deep chains, no cause and no browser", () => {
    expect(
      technicalDetails(
        new EngineError("processor", "Stopped.", { cause: "worklet failed" }),
        "",
      ),
    ).toBe(
      "Kind: processor\nError: Stopped.\nCause: worklet failed\nBrowser: unknown",
    );
    let deep: unknown = new Error("0");
    for (let i = 1; i < 6; i++) deep = new Error(String(i), { cause: deep });
    const lines = technicalDetails(
      new EngineError("network", "x", { cause: deep }),
      CHROME,
    ).split("\n");
    expect(lines.filter((l) => l.startsWith("Cause:"))).toHaveLength(3);
    expect(technicalDetails(null, CHROME)).toBe(
      `Error: unknown\nBrowser: ${CHROME}`,
    );
  });
});
