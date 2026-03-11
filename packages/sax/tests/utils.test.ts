import { AsciiCharCode, UnicodeCharCode } from ":constants.ts";
import { isName, isNameChar, isQuote, isWhitespace } from ":utils.ts";
import { describe, expect, test } from "bun:test";

describe("isName", () => {
	test("rejects empty strings", () => {
		expect(isName("")).toBe(false);
	});

	test("accepts valid ASCII names", () => {
		expect(isName("a")).toBe(true);
		expect(isName("abc")).toBe(true);
		expect(isName("_name")).toBe(true);
		expect(isName(":name")).toBe(true);
		expect(isName("name123")).toBe(true);
		expect(isName("a-b.c")).toBe(true);
		expect(isName("ns:tag")).toBe(true);
	});

	test("rejects names with invalid starting characters", () => {
		expect(isName("1abc")).toBe(false);
		expect(isName("-abc")).toBe(false);
		expect(isName(".abc")).toBe(false);
		expect(isName(" abc")).toBe(false);
	});

	test("rejects names with invalid later characters", () => {
		expect(isName("a b")).toBe(false);
		expect(isName("a>b")).toBe(false);
		expect(isName('a"b')).toBe(false);
		expect(isName("a/b")).toBe(false);
	});

	test("accepts valid Unicode names", () => {
		expect(isName("π")).toBe(true);
		expect(isName("προβ")).toBe(true);
		expect(isName("中名")).toBe(true);
		expect(isName("Àname")).toBe(true);
	});

	test("accepts names with supplementary Unicode characters", () => {
		expect(isName("𐍈tag")).toBe(true);
		expect(isName("a𐍈")).toBe(true);
	});

	test("accepts combining characters after a valid start", () => {
		expect(isName("a\u0300")).toBe(true);
		expect(isName("name\u00B7part")).toBe(true);
	});

	test("rejects a combining character as the first character", () => {
		expect(isName("\u0300abc")).toBe(false);
	});
});

describe("isNameChar", () => {
	test("allows standard Latin letters (A-Z, a-z)", () => {
		expect(isNameChar(0x0041)).toBe(true); // 'A'
		expect(isNameChar(0x005a)).toBe(true); // 'Z'
		expect(isNameChar(0x0061)).toBe(true); // 'a'
		expect(isNameChar(0x007a)).toBe(true); // 'z'
	});

	test("allows digits (0-9)", () => {
		expect(isNameChar(0x0030)).toBe(true); // '0'
		expect(isNameChar(0x0039)).toBe(true); // '9'
	});

	const cases = [
		AsciiCharCode.Colon,
		AsciiCharCode.Underscore,
		AsciiCharCode.Dash,
		AsciiCharCode.Dot,
		UnicodeCharCode.MiddleDot,
	];

	test.each(cases)("allows specific permitted punctuation", (charCode) => {
		expect(isNameChar(charCode)).toBe(true);
	});
});

describe("isQuote", () => {
	test("returns true for single and double quotes", () => {
		expect(isQuote(CharCode.DoubleQuote)).toBe(true);
		expect(isQuote(CharCode.SingleQuote)).toBe(true);
	});

	test("returns false for non-quote characters", () => {
		expect(isQuote("a".charCodeAt(0))).toBe(false);
		expect(isQuote(CharCode.Space)).toBe(false);
	});
});

describe("isWhitespace", () => {
	test("returns true for XML whitespace characters", () => {
		expect(isWhitespace(AsciiCharCode.Space)).toBe(true);
		expect(isWhitespace(AsciiCharCode.HorizontalTab)).toBe(true);
		expect(isWhitespace(AsciiCharCode.LineFeed)).toBe(true);
		expect(isWhitespace(AsciiCharCode.CarriageReturn)).toBe(true);
	});

	test("returns false for non-whitespace characters", () => {
		expect(isWhitespace("a".charCodeAt(0))).toBe(false);
		expect(isWhitespace(AsciiCharCode.CloseAngle)).toBe(false);
		expect(isWhitespace(AsciiCharCode.DoubleQuote)).toBe(false);
	});
});
