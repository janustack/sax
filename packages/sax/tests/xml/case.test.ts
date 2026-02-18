import { describe, expect, test } from "bun:test";
import SAX, { type SAXOptions } from "@janustack/sax";

describe("", () => {
	test("uppercase", () => {
		const options: SAXOptions = { strict: false };
		const xml = '<span class="test" hello="world"></span>';
		expect(parse(xml, options)).toEqual([
			[
				"openTagstart",
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

	test("lowercase", () => {
		const options: SAXOptions = { lowercase: true, strict: false };
		const xml = '<span class="test" hello="world"></span>';
		expect(parse(xml, options)).toEqual([
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
