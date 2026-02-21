import type { SAXOptions, WasmExports } from "./types.js";

const encoder = new TextEncoder();

function toBool(v: number | boolean): boolean {
	return typeof v === "boolean" ? v : v !== 0;
}

export function applyTextOptions(options: SAXOptions, text: string): string {
	if (options.trim) text = text.trim();
	if (options.normalize) text = text.replace(/\s+/g, " ");
	return text;
}

export function isMatch(regex: RegExp, char: string): boolean {
	return regex.test(char);
}

export function isWhitespace(wasm: WasmExports, char: string): boolean {
	return toBool(wasm.isWhitespace(char.charCodeAt(0)));
}

export function isAttributeEnd(wasm: WasmExports, char: string): boolean {
	return toBool(wasm.isAttributeEnd(char.charCodeAt(0)));
}

export function isQuote(wasm: WasmExports, char: string): boolean {
	return toBool(wasm.isQuote(char.charCodeAt(0)));
}

export function getQName(
	wasm: WasmExports,
	name: string,
	isAttribute = false,
): { prefix: string; localName: string } {
	const bytes = encoder.encode(name);

	// Allocate and copy the qualified name string into wasm memory.
	const ptr = wasm.alloc(bytes.length);

	new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);

	const splitIndex = wasm.getQName(ptr, bytes.length, isAttribute ? 1 : 0);

	wasm.free(ptr, bytes.length);

	if (splitIndex === -2) {
		// Special XML rule handled by Zig:
		// If this is an attribute and the name is exactly "xmlns",
		// treat it as the reserved namespace declaration attribute.
		return { prefix: "xmlns", localName: "" };
	}

	if (splitIndex === -1) {
		// No ':' present - unprefixed qualified name.
		// The entire string is the local name; prefix is empty.
		return { prefix: "", localName: name };
	}

	// Prefixed qualified name
	return {
		prefix: name.substring(0, splitIndex),
		localName: name.substring(splitIndex + 1),
	};
}
