// The shared YouTube URL contract: this table is also run against the server's
// parser (apps/api/tests/test_youtube_contract.py), so the two can't drift.
import { describe, expect, it } from "vitest";

import table from "./fixtures/youtube_urls.json";
import { extractVideoId } from "./youtube";

describe("shared YouTube URL contract", () => {
  it.each(table.cases)("$input", ({ input, id }) => {
    expect(extractVideoId(input)).toBe(id);
  });
});
