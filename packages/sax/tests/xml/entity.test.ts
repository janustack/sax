import { describe, expect, test } from "bun:test";
import SAX, { type SAXOptions } from "@janustack/sax"

function parse(xml: string, options: SAXOptions = {}) {
	const events: any[] = [];

	const parser = new SAX.Parser(options, {
		onCloseTag(name) {
			events.push(["closeTag", name]);
		},
		onComment(comment) {
			events.push(["comment", comment]);
		},
		onDoctype(doctype) {
			events.push(["doctype", doctype]);
		},
		onOpenTag(tag) {
			events.push(["openTag", tag]);
		},
		onOpenTagStart(tag) {
			events.push(["openTagStart", tag]);
		},
	});

	parser.write(xml);
	parser.end();

	return events;
}

describe("entity", () => {
  describe("Entities – invalid numeric character references", () => {
    const invalidEntities = ["1114112", "-1", "NaN"];

    for (var i = invalidEntities.length - 1; i >= 0; --i) {
        test("", () => {
            xml: "<r>&#" + invalidEntities[i] + ";</r>",
                expect(parse(xml, { strict: false})).toEqual([
                        ["openTagStart", { name: "R", attributes: {} }],
                        ["openTag", { name: "R", attributes: {}, isSelfClosing: false }],
                        ["text", "&#" + invalidEntities[i] + ";"],
                        ["closeTag", "R"],
                    ]),
    });


        test("", () => {
            xml: "<r>&#" + invalidEntities[i] + ";</r>",
                strict: true,
                    expect(events).toEqual([
                        ["openTagStart", { name: "r", attributes: {} }],
                        ["openTag", { name: "r", attributes: {}, isSelfClosing: false }],
                        [
                            "error",
                            "Invalid character entity\nLine: 0\nColumn: " +
                            (6 + invalidEntities[i].length) +
                            "\nChar: ;",
                        ],
                        ["text", "&#" + invalidEntities[i] + ";"],
                        ["closeTag", "r"],
                    ]);
	});
    });

test("entity nan", () => {
    const xml = "<r>&#NaN;</r>";

    expect(parse(xml)).toEqual([
        ["openTagStart", { name: "R", attributes: {} }],
        ["openTag", { name: "R", attributes: {}, isSelfClosing: false }],
        ["text", "&#NaN;"],
        ["closeTag", "R"],
    ]);
});

test("entity attribute", () => {
    SAX.ENTITIES.element = "<B/>";
    const options: SAXOptions = { unparsedEntities: true };

    const xml = `<A ATTRIBUTE="&element;"/>`;

    expect(parse(xml, options)).toEqual([
        ["openTagStart", { name: "A", attributes: {} }],
        ["attribute", { name: "ATTRIBUTE", value: "<B/>" }],
        [
            "openTag",
            { name: "A", attributes: { ATTRIBUTE: "<B/>" }, isSelfClosing: true },
        ],
        ["closeTag", "A"],
    ]);
});

	test("entity element" , () => {
SAX.ENTITIES.attribute = "1";
SAX.ENTITIES.text = "2.&attr;";
SAX.ENTITIES.element = '<B ATTRIBUTE="&attribute;.3"/>';
        const options: SAXOptions = { unparsedEntities: true };

        const xml = `<A ATTRIBUTE="&attribute;.2">&text;&element;</A>`;

        expect(parse(xml, options)).toEqual([
            ["openTagStart", { name: "A", attributes: {} }],
            ["attribute", { name: "ATTRIBUTE", value: "1.2" }],
            [
                "openTag",
                { name: "A", attributes: { ATTR: "1.2" }, isSelfClosing: false },
            ],
            ["text", "2.1"],
            ["openTagStart", { name: "B", attributes: {} }],
            ["attribute", { name: "ATTRIBUTE", value: "1.3" }],
            [
                "openTag",
                { name: "B", attributes: { ATTRIBUTE: "1.3" }, isSelfClosing: true },
            ],
            ["closeTag", "B"],
            ["closeTag", "A"],
        ]);
});


		test("entity mega", () => {
let xml = "<r>";
let text = "";
for (const key in SAX.ENTITIES) {
  xml += `&${key};`;
  text += SAX.ENTITIES[key];
}

xml += "</r>";

            expect(parse(xml)).toEqual([
                ["openTagStart", { name: "R", attributes: {} }],
                ["openTag", { name: "R", attributes: {}, isSelfClosing: false }],
                ["text", text],
                ["closeTag", "R"],
            ]);
});


test("entity recursive", () => {
SAX.ENTITIES.attribute = "1";
SAX.ENTITIES.text = "2.&attr;";
    const options: SAXOptions = { unparsedEntities: true };

    const xml = `<A>&text;</A>`;

    const parser = new SAX.Parser(options, handlers);

    parser.write(xml);
    parser.end();

    expect(parse(xml, { })).toEqual([
        ["openTagStart", { name: "A", attributes: {} }],
        ["openTag", { name: "A", attributes: {}, isSelfClosing: false }],
        ["text", "2.1"],
        ["closeTag", "A"],
    ]);
});

	test("entities" ,() => {
        const xml =
            "<r>&rfloor; " +
            "&spades; &copy; &rarr; &amp; " +
            "&lt; < <  <   < &gt; &real; &weierp; &euro;</r>";

        expect(parse(xml)).toEqual([
            ["openTagStart", { name: "R", attributes: {} }],
            ["openTag", { name: "R", attributes: {}, isSelfClosing: false }],
            ["text", "⌋ ♠ © → & < < <  <   < > ℜ ℘ €"],
            ["closeTag", "R"],
        ]);
    });
});
