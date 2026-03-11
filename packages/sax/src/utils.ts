// utils.ts
import { AsciiCharCode, UnicodeCharCode } from "./constants.js";

export function isAttributeEnd(charCode: number): boolean {
	return charCode === AsciiCharCode.CloseAngle || isWhitespace(charCode);
}

/**
 * Checks whether an entire string is one valid XML 'Name'.
 */
export function isName(str: string): boolean {
	if (str.length === 0) {
		return false;
	}

	// Convert string to an array of characters to properly handle Unicode surrogate pairs.
	// e.g., Characters in the #x10000-#xEFFFF range take up two 16-bit code units.
	const chars = Array.from(str);

	// The first character must strictly be a NameStartChar
	const firstCodePoint = chars[0].codePointAt(0);

	if (firstCodePoint === undefined || !isNameStartChar(firstCodePoint)) {
		return false;
	}

	// All subsequent characters must be NameChars
	for (let i = 1; i < chars.length; i++) {
		const codePoint = chars[i].codePointAt(0);

		if (codePoint === undefined || !isNameChar(codePoint)) {
			return false;
		}
	}

	return true;
}

/**
 * Checks whether an entire string is a valid space-separated list of XML 'Name' values.
 */
export function isNames(str: string): boolean {
	if (str.length === 0) {
		return false;
	}

	// The specification strictly requires space (#x20) as the delimiter,
	// not general whitespace (S).
	const namesList = str.split(" ");

	for (const name of namesList) {
		if (!isName(name)) {
			return false;
		}
	}

	return true;
}

export function isNameChar(codePoint: number): boolean {
	return (
		isNameStartChar(codePoint) ||
		(codePoint >= 0x0030 && codePoint <= 0x0039) || // 0-9
		codePoint === AsciiCharCode.Dash || // -
		codePoint === AsciiCharCode.FullStop || // .
		codePoint === UnicodeCharCode.MiddleDot ||
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		(codePoint >= 0x203f && codePoint <= 0x2040)
	);
}

export function isNameStartChar(codePoint: number): boolean {
	return (
		(codePoint >= 0x0041 && codePoint <= 0x005a) || // A-Z
		(codePoint >= 0x0061 && codePoint <= 0x007a) || // a-z
		codePoint === AsciiCharCode.Colon || // :
		codePoint === AsciiCharCode.Underscore || // _
		(codePoint >= 0x00c0 && codePoint <= 0x00d6) ||
		(codePoint >= 0x00d8 && codePoint <= 0x00f6) ||
		(codePoint >= 0x00f8 && codePoint <= 0x02ff) ||
		(codePoint >= 0x0370 && codePoint <= 0x037d) ||
		(codePoint >= 0x037f && codePoint <= 0x1fff) ||
		(codePoint >= 0x200c && codePoint <= 0x200d) ||
		(codePoint >= 0x2070 && codePoint <= 0x218f) ||
		(codePoint >= 0x2c00 && codePoint <= 0x2fef) ||
		(codePoint >= 0x3001 && codePoint <= 0xd7ff) ||
		(codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
		(codePoint >= 0xfdf0 && codePoint <= 0xfffd) ||
		(codePoint >= 0x10000 && codePoint <= 0xeffff)
	);
}

export function isQuote(charCode: number): boolean {
	return (
		charCode === AsciiCharCode.DoubleQuote ||
		charCode === AsciiCharCode.SingleQuote
	);
}

export function isWhitespace(charCode: number): boolean {
	return (
		charCode === AsciiCharCode.CarriageReturn ||
		charCode === AsciiCharCode.HorizontalTab ||
		charCode === AsciiCharCode.LineFeed ||
		charCode === AsciiCharCode.Space
	);
}

export function getQName(name: string, isAttribute = false) {
	const i = name.indexOf(":");
	const qName = i < 0 ? ["", name] : name.split(":");

	let prefix = qName[0];
	let localName = qName[1];

	// <x "xmlns"="http://foo">
	if (isAttribute && name === "xmlns") {
		prefix = "xmlns";
		localName = "";
	}

	return { prefix, localName };
}
