import { describe, expect, it } from "vitest";
import { generateCode, normalizeCode, validateAlias, validateUrl } from "../src/validate";

describe("validateAlias", () => {
  it.each(["abc", "my-link", "a1b2c3", "x".repeat(32)])("accepts %s", (a) => {
    expect(validateAlias(a)).toBeNull();
  });
  it.each(["ab", "x".repeat(33), "-abc", "abc-", "a--b", "has space", "UPPER", "a_b", "é-é-é", "a/b"])(
    "rejects %s",
    (a) => {
      expect(validateAlias(a)).not.toBeNull();
    },
  );
  it.each(["api", "admin", "www", "robots", "favicon"])("rejects reserved %s", (a) => {
    expect(validateAlias(a)).toMatch(/reserved/);
  });
  it("normalizes case and whitespace", () => {
    expect(normalizeCode("  My-Link ")).toBe("my-link");
  });
});

describe("validateUrl", () => {
  it("accepts http(s) and normalises", () => {
    expect(validateUrl("https://example.com", "go.test")).toEqual({ ok: true, url: "https://example.com/" });
  });
  it.each(["", "   ", "ftp://x.com", "javascript:alert(1)", "not a url", "https://u:p@x.com", 42, null])(
    "rejects %s",
    (v) => {
      expect(validateUrl(v, "go.test").ok).toBe(false);
    },
  );
  it("rejects loops to the shortener host", () => {
    expect(validateUrl("https://GO.test/abc", "go.test").ok).toBe(false);
  });
  it("rejects over-long urls", () => {
    expect(validateUrl("https://x.com/" + "a".repeat(2100), "go.test").ok).toBe(false);
  });
});

describe("generateCode", () => {
  it("returns 7 valid, mostly-unique codes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const c = generateCode();
      expect(c).toMatch(/^[a-z0-9]{7}$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(495);
  });
});
