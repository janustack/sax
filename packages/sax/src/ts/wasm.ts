import type { WasmExports } from "./types.js";

let wasmExports: WasmExports | undefined;

const decoder = new TextDecoder();

export function readString(
	memory: WebAssembly.Memory,
	byteOffset: number,
	length: number,
): string {
	const bytes = new Uint8Array(memory.buffer, byteOffset, length);
	return decoder.decode(bytes);
}

export function setWasmExports(exports: WasmExports) {
	wasmExports = exports;
}

function toBool(v: number | boolean): boolean {
	return typeof v === "boolean" ? v : v !== 0;
}

export function isWhitespace(char: string): boolean {
	return toBool(wasmExports.isWhitespace(char.charCodeAt(0)));
}
export function isQuote(char: string): boolean {
	return toBool(wasmExports.isQuote(char.charCodeAt(0)));
}
export function isAttributeEnd(char: string): boolean {
	return toBool(wasmExports.isAttributeEnd(char.charCodeAt(0)));
}
