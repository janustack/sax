import { describe, expect, test } from "bun:test";
import SAX, { type SAXOptions } from "@janustack/sax";

describe("attribute", () => {
	describe("attribute no space", () => {
		test("non-strict: no error", () => {
			const options: SAXOptions = { lowercase: true, strict: false };

			const xml = `<root attr1="first"attr2="second"/>`;

			const parser = new SAX.Parser(options, handlers);

			parser.write(xml);
			parser.end();

			expect(events).toEqual([
				["openTagStart", { name: "root", attributes: {} }],
				["attribute", { name: "attr1", value: "first" }],
				["attribute", { name: "attr2", value: "second" }],
				[
					"openTag",
					{
						name: "root",
						attributes: { attr1: "first", attr2: "second" },
						isSelfClosing: true,
					},
				],
				["closeTag", "root"],
			]);
		});

		test("strict: should give an error, but still parse", () => {
			const options = { strict: true };

			const xml = `<root attr1="first"attr2="second"/>`;

			const parser = new SAX.Parser(options, handlers);

			parser.write(xml);
			parser.end();

			expect(events).toEqual([
				["openTagStart", { name: "root", attributes: {} }],
				["attribute", { name: "attr1", value: "first" }],
				[
					"error",
					"No whitespace between attributes\nLine: 0\nColumn: 20\nChar: a",
				],
				["attribute", { name: "attr2", value: "second" }],
				[
					"openTag",
					{
						name: "root",
						attributes: { attr1: "first", attr2: "second" },
						isSelfClosing: true,
					},
				],
				["closeTag", "root"],
			]);
		});

		test("strict: other cases should still pass", () => {
			const options: SAXOptions = { strict: true };

			const xml = `<root attr1="first" attr2="second"/>`;

			const parser = new SAX.Parser(options, handlers);

			parser.write(xml);
			parser.end();

			expect(events).toEqual([
				["openTagStart", { name: "root", attributes: {} }],
				["attribute", { name: "attr1", value: "first" }],
				["attribute", { name: "attr2", value: "second" }],
				[
					"openTag",
					{
						name: "root",
						attributes: { attr1: "first", attr2: "second" },
						isSelfClosing: true,
					},
				],
				["closeTag", "root"],
			]);
		});

		test("strict: other cases should still pass", () => {
			const options: SAXOptions = { strict: true };

			const xml = `<root attr1="first"\nattr2="second"/>`;

			const parser = new SAX.Parser(options, handlers);

			parser.write(xml);
			parser.end();

			expect(events).toEqual([
				["openTagStart", { name: "root", attributes: {} }],
				["attribute", { name: "attr1", value: "first" }],
				["attribute", { name: "attr2", value: "second" }],
				[
					"openTag",
					{
						name: "root",
						attributes: { attr1: "first", attr2: "second" },
						isSelfClosing: true,
					},
				],
				["closeTag", "root"],
			]);
		});

		test("strict: other cases should still pass", () => {
			const options: SAXOptions = { strict: true };

			const xml = `<root attr1="first"  attr2="second"/>`;

			const parser = new SAX.Parser(options, handlers);

			parser.write(xml);
			parser.end();

			expect(events).toEqual([
				["openTagStart", { name: "root", attributes: {} }],
				["attribute", { name: "attr1", value: "first" }],
				["attribute", { name: "attr2", value: "second" }],
				[
					"openTag",
					{
						name: "root",
						attributes: { attr1: "first", attr2: "second" },
						isSelfClosing: true,
					},
				],
				["closeTag", "root"],
			]);
		});
	});

	test("attribute unquoted", () => {
		const options: SAXOptions = { namespaces: true, strict: false };

		const parser = new SAX.Parser(options, handlers);

		parser.write("<root length=12");
		parser.write("345></root>");
		parser.end();

		expect(events).toEqual([
			["openTagStart", { name: "ROOT", attributes: {}, ns: {} }],
			[
				"attribute",
				{
					name: "LENGTH",
					value: "12345",
					prefix: "",
					localName: "LENGTH",
					uri: "",
				},
			],
			[
				"openTag",
				{
					name: "ROOT",
					attributes: {
						LENGTH: {
							name: "LENGTH",
							value: "12345",
							prefix: "",
							localName: "LENGTH",
							uri: "",
						},
					},
					ns: {},
					prefix: "",
					localName: "ROOT",
					uri: "",
					isSelfClosing: false,
				},
			],
			["closeTag", "ROOT"],
			["end"],
			["ready"],
		]);
	});

	test("attribute name", () => {
		const options: SAXOptions = { namespaces: true, strict: true };

		const xml = `<root length='12345'></root>`;

		const parser = new SAX.Parser(options, handlers);

		parser.write(xml);
		parser.end();

		expect(events).toEqual([
			["openTagStart", { name: "root", attributes: {}, ns: {} }],
			[
				"attribute",
				{
					name: "length",
					value: "12345",
					prefix: "",
					localName: "length",
					uri: "",
				},
			],
			[
				"openTag",
				{
					name: "root",
					prefix: "",
					local: "root",
					uri: "",
					attributes: {
						length: {
							name: "length",
							value: "12345",
							prefix: "",
							localName: "length",
							uri: "",
						},
					},
					ns: {},
					isSelfClosing: false,
				},
			],
			["closeTag", "root"],
		]);
	});

	test("trailing attribute no value", () => {
    const options: SAXOptions = { trim: true };
    const xml = "<root attrib>";
    expect(parse(xml, options)).toEqual([
        ["opentagstart", { name: "ROOT", attributes: {} }],
        ["attribute", { name: "ATTRIB", value: "attrib" }],
        [
            "opentag",
            {
                name: "ROOT",
                attributes: { ATTRIB: "attrib" },
                isSelfClosing: false,
            },
        ],
    ]);
});


	test("duplicate attribute", () => {
		const options: SAXOptions = { strict: false };

		const xml = '<span id="hello" id="there"></span>';

		const parser = new SAX.Parser(options, handlers);

		parser.write(xml);
		parser.end();

		expect(events).toEqual([
			[
				"openTagStart",
				{
					name: "SPAN",
					attributes: {},
				},
			],
			["attribute", { name: "ID", value: "hello" }],
			[
				"openTag",
				{
					name: "SPAN",
					attributes: { ID: "hello" },
					isSelfClosing: false,
				},
			],
			["closeTag", "SPAN"],
		]);
	});

	test("high-order numeric attributes (surrogate pairs)", () => {
		const options: SAXOptions = { strict: false };

		const xml = `<a>&#x1f525;</a>`;

		const parser = new SAX.Parser(options, handlers);

		parser.write(xml);
		parser.end();

		expect(events).toEqual([
			["openTagStart", { name: "A", attributes: {} }],
			["openTag", { name: "A", attributes: {}, isSelfClosing: false }],
			["text", "\ud83d\udd25"],
			["closeTag", "A"],
		]);
  });

	test("unquoted attribute", () => {
		xml: "<span class=test hello=world></span>",
		expect().toEqual([
			[
				"opentagstart",
				{
					name: "SPAN",
					attributes: {},
				},
			],
			[
				"attribute",
				{
					name: "CLASS",
					value: "test",
				},
			],
			[
				"attribute",
				{
					name: "HELLO",
					value: "world",
				},
			],
			[
				"opentag",
				{
					name: "SPAN",
					attributes: {
						CLASS: "test",
						HELLO: "world",
					},
					isSelfClosing: false,
				},
			],
			["closetag", "SPAN"],
		]),
		options: { strict: false },
	});

});
