import type { SAXOptions } from "./types.js";

export function isWhitespace(char: string): boolean {
	return char === " " || char === "\n" || char === "\r" || char === "\t";
}

export function isQuote(char: string): boolean {
	return char === '"' || char === "'";
}

export function isAttributeEnd(char: string): boolean {
	return char === ">" || isWhitespace(char);
}

export function isMatch(regex: RegExp, char: string): boolean {
	return regex.test(char);
}

export function applyTextOptions(options: SAXOptions, text: string): string {
	if (options.trim) text = text.trim();
	if (options.normalize) text = text.replace(/\s+/g, " ");
	return text;
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
