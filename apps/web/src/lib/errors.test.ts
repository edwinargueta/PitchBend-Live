import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  LIMITS,
  describeError,
  formatLength,
  formatWait,
  isErrorCode,
} from "./errors";
import type { ErrorCode } from "./types";

// Compile-time check that ERROR_CODES lists every ErrorCode: this record fails to
// type-check if a code is missing from it, and the test below compares the two.
const ALL: Record<ErrorCode, true> = {
  INVALID_URL: true,
  UNSUPPORTED_FILE: true,
  FILE_TOO_LARGE: true,
  VIDEO_TOO_LONG: true,
  LIVESTREAM: true,
  SOURCE_UNAVAILABLE: true,
  SOURCE_BLOCKED: true,
  RATE_LIMITED: true,
  KEY_DETECTION_FAILED: true,
  NOT_FOUND: true,
  INTERNAL: true,
};

describe("LIMITS", () => {
  it("mirrors §6.2", () => {
    expect(LIMITS).toEqual({
      maxDurationS: 720,
      maxUploadMb: 50,
      mediaTtlHours: 24,
    });
  });
});

describe("ERROR_CODES / isErrorCode", () => {
  it("lists every §6.6 code", () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(ALL).sort());
  });

  it.each(ERROR_CODES)("accepts %s", (code) => {
    expect(isErrorCode(code)).toBe(true);
  });

  it.each(["BOGUS", "invalid_url", "", 404, null, undefined, {}])(
    "rejects %j",
    (value) => {
      expect(isErrorCode(value)).toBe(false);
    },
  );
});

describe("describeError", () => {
  it.each(ERROR_CODES)("has friendly copy for %s", (code) => {
    const copy = describeError(code);
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.message.length).toBeGreaterThan(0);
    // Friendly: no raw codes or stack-trace-ish text in the copy.
    expect(copy.title + copy.message).not.toContain(code);
    expect(copy.message).not.toMatch(/undefined|NaN|null/);
  });

  it("gives every code distinct copy", () => {
    const titles = new Set(ERROR_CODES.map((c) => describeError(c).title));
    expect(titles.size).toBe(ERROR_CODES.length);
  });

  it("suggests uploading exactly for YouTube-side failures", () => {
    const suggesting = ERROR_CODES.filter(
      (c) => describeError(c).suggestUpload,
    );
    expect(suggesting.sort()).toEqual([
      "LIVESTREAM",
      "SOURCE_BLOCKED",
      "SOURCE_UNAVAILABLE",
    ]);
  });

  it("SOURCE_BLOCKED prominently suggests uploading", () => {
    const copy = describeError("SOURCE_BLOCKED");
    expect(copy.suggestUpload).toBe(true);
    expect(copy.message).toContain(
      "YouTube blocked this request — try uploading the file instead",
    );
  });

  it("mentions uploading whenever it suggests it", () => {
    for (const code of ERROR_CODES) {
      const copy = describeError(code);
      if (copy.suggestUpload) expect(copy.message).toMatch(/upload/i);
    }
  });

  it("takes limits from LIMITS", () => {
    expect(describeError("FILE_TOO_LARGE").message).toContain("50 MB");
    expect(describeError("VIDEO_TOO_LONG").message).toContain("12 minutes");
    expect(describeError("NOT_FOUND").message).toContain("24 hours");
  });

  it("says playback still works when key detection fails", () => {
    expect(describeError("KEY_DETECTION_FAILED").message).toMatch(/still play/);
  });

  it.each([
    [undefined, "a few minutes"],
    [1, "1 second"],
    [45, "45 seconds"],
    [60, "1 minute"],
    [61, "2 minutes"],
    [360, "6 minutes"],
  ])("RATE_LIMITED with retryAfterS=%s mentions %s", (retryAfterS, wait) => {
    const copy = describeError("RATE_LIMITED", retryAfterS);
    expect(copy.message).toContain(`wait ${wait} and try again`);
    expect(copy.suggestUpload).toBe(false);
  });

  it("falls back to INTERNAL copy for a code a newer server might send", () => {
    expect(describeError("SOMETHING_NEW" as ErrorCode)).toEqual(
      describeError("INTERNAL"),
    );
  });
});

describe("formatWait", () => {
  it.each([
    [undefined, "a few minutes"],
    [Number.NaN, "a few minutes"],
    [Infinity, "a few minutes"],
    [-5, "a few minutes"],
    [0, "1 second"],
    [0.2, "1 second"],
    [1, "1 second"],
    [2, "2 seconds"],
    [59, "59 seconds"],
    [59.5, "1 minute"],
    [60, "1 minute"],
    [90, "2 minutes"],
    [120, "2 minutes"],
    [3600, "60 minutes"],
  ])("%s → %s", (seconds, expected) => {
    expect(formatWait(seconds)).toBe(expected);
  });
});

describe("formatLength", () => {
  it.each([
    [720, "12 minutes"],
    [60, "1 minute"],
    [750, "12 minutes 30 seconds"],
    [61, "1 minute 1 second"],
    [45, "45 seconds"],
    [1, "1 second"],
  ])("%s → %s", (seconds, expected) => {
    expect(formatLength(seconds)).toBe(expected);
  });
});
