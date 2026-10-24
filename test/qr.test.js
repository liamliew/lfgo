import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { qrMatrix, qrSvg } from "../qr.js";

describe("qr", () => {
  it("makes a square module matrix that grows with the text", () => {
    const small = qrMatrix("https://go.lfcrea.com/abc1234");
    assert.ok(small.length >= 21 && small.every((row) => row.length === small.length));
    const large = qrMatrix("https://go.lfcrea.com/" + "x".repeat(150));
    assert.ok(large.length > small.length);
  });
  it("has the three finder patterns (dark 7x7 corners)", () => {
    const m = qrMatrix("https://go.lfcrea.com/abc1234");
    const n = m.length;
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let i = 0; i < 7; i++) {
        assert.equal(m[r][c + i], true);
        assert.equal(m[r + 6][c + i], true);
        assert.equal(m[r + i][c], true);
        assert.equal(m[r + i][c + 6], true);
      }
    }
  });
  it("renders an SVG with a quiet zone and fixed black on white", () => {
    const n = qrMatrix("hello").length;
    const svg = qrSvg("hello");
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(svg.includes(`viewBox="0 0 ${n + 8} ${n + 8}"`));
    assert.ok(svg.includes('fill="#ffffff"') && svg.includes('fill="#000000"'));
    assert.ok(svg.endsWith("</svg>"));
  });
  it("encodes the same text deterministically", () => {
    assert.equal(qrSvg("https://go.lfcrea.com/x"), qrSvg("https://go.lfcrea.com/x"));
    assert.notEqual(qrSvg("https://go.lfcrea.com/x"), qrSvg("https://go.lfcrea.com/y"));
  });
});
