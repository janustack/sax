import type { WasmExports } from "../../src/ts/types.ts";
import {
	isAttributeEnd as isAttributeEndJS,
	isQuote as isQuoteJS,
	isWhitespace as isWhitespaceJS,
	getQName as getQNameJS,
} from "./utilsJS.test.ts";

import { isAttributeEnd, isQuote, isWhitespace } from "../../src/ts/utils.ts";

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

async function initWasm() {
	const path = "../../src/wasm/utils.wasm";
	const url = new URL(path, import.meta.url);
	const bytes = await Bun.file(url).bytes();

	const env = {};

	const { instance } = await WebAssembly.instantiate(bytes, {
		env,
	});

	wasmExports = instance.exports as unknown as WasmExports;
	return wasmExports;
}

async function main() {
	await initWasm();

	console.log(isAttributeEnd(">"));
	console.log(isWhitespace(" ")); // 1 (true)
	console.log(isWhitespace("")); // 0 (false)
	console.log(isQuote('"')); // 1 (true)
	console.log(isQuote("Z")); // 0 (false)
	console.log(getQName(""));

	Bun.stdout.write(`isAttributeEndJS: ${isAttributeEndJS(">")}\n`);
	Bun.stdout.write(`isQuoteJS: ${isQuoteJS("")}\n`);
	Bun.stdout.write(`isWhitespaceJS: ${isWhitespaceJS("Hey")}\n`);
	Bun.stdout.write(`isWhitespaceJS: ${getQNameJS("Hey")}\n`);
}

main();
