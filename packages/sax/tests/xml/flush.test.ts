import { beforeAll, describe, expect, test } from "bun:test";
import SAX, { type SAXOptions, wasmURL } from "@janustack/sax";

describe("Flusing tests", () => {
	let bytes: Uint8Array;

	beforeAll(async () => {
		bytes = await Bun.file(wasmURL).bytes();
	});

	test("flush", async () => {
		const events: any[] = [];
		const parser = new SAX.Parser(
			{},
			{
				onOpenTagStart(tag) {
					events.push(["openTagStart", tag]);
				},
				onOpenTag(tag) {
					events.push(["openTag", tag]);
				},
				onText(text) {
					events.push(["text", text]);
				},
				onCloseTag(tag) {
					events.push(["closeTag", tag]);
				},
			},
		);
		await parser.initWasm(bytes);
		parser.write("<T>flush");
		parser.flush();
		parser.write("rest</T>");
		parser.end();
		expect(parser).toEqual([
			["openTagStart", { name: "T", attributes: {} }],
			["openTag", { name: "T", attributes: {}, isSelfClosing: false }],
			["text", "flush"],
			["text", "rest"],
			["closeTag", "T"],
		]);
	});
});
