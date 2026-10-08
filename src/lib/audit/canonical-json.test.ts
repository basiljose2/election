import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";

describe("canonicalJson", () => {
  it("sorts keys recursively and omits whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: null, y: true }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":true,"z":null}]},"b":1}',
    );
  });

  it("is independent of key insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("escapes strings like JSON and keeps non-ASCII characters", () => {
    expect(canonicalJson({ s: 'a"b\\c\n\u0001é☃' })).toBe('{"s":"a\\"b\\\\c\\n\\u0001é☃"}');
  });

  it("sorts keys by UTF-16 code units", () => {
    expect(canonicalJson({ b: 1, B: 2, é: 3, a: 4 })).toBe('{"B":2,"a":4,"b":1,"é":3}');
  });

  it("normalises negative zero", () => {
    expect(canonicalJson(-0)).toBe("0");
  });

  it.each([
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["an unsafe integer", 2 ** 60],
    ["undefined", undefined],
    ["a Date", new Date(0)],
    ["a bigint", BigInt(1)],
    ["a nested undefined", { a: [undefined] }],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});
