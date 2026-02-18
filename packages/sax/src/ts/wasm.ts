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

function toBool(v: number | boolean): boolean {
	return typeof v === "boolean" ? v : v !== 0;
}

export function setWasmExports(exports: WasmExports) {
	wasmExports = exports;
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

export function getQName(
	name: string,
	isAttribute: boolean = false,
): { prefix: string; localName: string } {
	// 1. Prepare memory (Assuming you have a shared buffer or allocator)
	// If 'name' is already in Wasm memory from the parser, skip this step!
	const encoder = new TextEncoder();
	const bytes = encoder.encode(name);
	const ptr = 0; // Ideally, use a proper allocator like wasm.alloc(bytes.length)
	const memoryBytes = new Uint8Array(wasmExports.memory.buffer);
	memoryBytes.set(bytes, ptr);

	// 2. Call Zig (Pass 1/0 for boolean)
	const splitIndex = wasmExports.getQName(
		ptr,
		bytes.length,
		isAttribute ? 1 : 0,
	);

	// 3. Handle the logic based on the return code
	if (splitIndex === -2) {
		// Special case: xmlns attribute
		return { prefix: "xmlns", localName: "" };
	}

	if (splitIndex === -1) {
		// No colon found
		return { prefix: "", localName: name };
	}

	// Standard split
	return {
		prefix: name.substring(0, splitIndex),
		localName: name.substring(splitIndex + 1),
	};
}
