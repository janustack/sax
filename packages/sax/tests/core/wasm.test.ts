import type { WasmExports } from "../src/ts/types.ts";
import {
	isAttributeEnd as isAttributeEndJS,
	isQuote as isQuoteJS,
	isWhitespace as isWhitespaceJS,
} from "../src/ts/utils.ts";

let wasmExports: WasmExports;

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

async function initWasm() {
	const wasmPath = "../src/wasm/utils.wasm";
	const wasmURL = new URL(wasmPath, import.meta.url);
	const wasmFile = Bun.file(wasmURL);
	const buffer = await wasmFile.arrayBuffer();

	const env = {};

	const { instance } = await WebAssembly.instantiate(buffer, {
		env,
	});

	wasmExports = instance.exports as unknown as WasmExports;
	return wasmExports;
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

async function main() {
	await initWasm();

	console.log(isAttributeEnd(">"));
	console.log(isWhitespace(" ")); // 1 (true)
	console.log(isWhitespace("")); // 0 (false)
	console.log(isQuote('"')); // 1 (true)
	console.log(isQuote("Z")); // 0 (false)

	Bun.stdout.write(`isAttributeEndJS: ${isAttributeEndJS(">")}\n`);
	Bun.stdout.write(`isQuoteJS: ${isQuoteJS("")}\n`);
	Bun.stdout.write(`isWhitespaceJS: ${isWhitespaceJS("Hey")}\n`);
}

main();
