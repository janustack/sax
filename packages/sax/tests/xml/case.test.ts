import { beforeAll, describe, expect, test } from "bun:test";
import SAX, { type SAXOptions, wasmURL } from "@janustack/sax";

describe("Casing Tests", () => {
	let bytes: Uint8Array;

	beforeAll(async () => {
		bytes = await Bun.file(wasmURL).bytes();
	});

	async function parse(xml: string, options?: SAXOptions) {
		const events: any[] = [];
		const parser = new SAX.Parser(options, {
			onOpenTagStart(tag) {
				events.push(["openTagStart", tag]);
			},
			onAttribute(attr) {
				events.push(["attribute", attr]);
			},
			onOpenTag(tag) {
				events.push(["openTag", tag]);
			},
			onCloseTag(name) {
				events.push(["closeTag", name]);
			},
		});
		await parser.initWasm(bytes);
		parser.write(xml);
		parser.end();
		return events;
	}

	test("uppercase", async () => {
		const options: SAXOptions = { nameCasing: "uppercase" };
		const xml = '<span class="test" hello="world"></span>';
		const results = await parse(xml, options);
		expect(results).toEqual([
			[
				"openTagStart",
				{
					name: "SPAN",
					attributes: {},
				},
			],
			["attribute", { name: "CLASS", value: "test" }],
			["attribute", { name: "HELLO", value: "world" }],
			[
				"openTag",
				{
					name: "SPAN",
					attributes: { CLASS: "test", HELLO: "world" },
					isSelfClosing: false,
				},
			],
			["closeTag", "SPAN"],
		]);
	});

	test("lowercase", async () => {
		const options: SAXOptions = { nameCasing: "lowercase" };
		const xml = '<span class="test" hello="world"></span>';
		const results = await parse(xml, options);
		expect(results).toEqual([
			[
				"openTagStart",
				{
					name: "span",
					attributes: {},
				},
			],
			["attribute", { name: "class", value: "test" }],
			["attribute", { name: "hello", value: "world" }],
			[
				"openTag",
				{
					name: "span",
					attributes: { class: "test", hello: "world" },
					isSelfClosing: false,
				},
			],
			["closeTag", "span"],
		]);
	});
});
