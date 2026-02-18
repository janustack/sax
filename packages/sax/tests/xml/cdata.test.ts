import { describe, expect, test } from "bun:test";
import process from "node:process";
import SAX from "@janustack/sax";

describe("cdata", () => {
test("cdata", () => {
    expect.toEqual([
        ["openTagStart", { name: "R", attributes: {} }],
        ["openTag", { name: "R", attributes: {}, isSelfClosing: false }],
        ["openCdata", undefined],
        ["cdata", " this is character data  "],
        ["closeCdata", undefined],
        ["closeTag", "R"],
    ]);
            const xml `<r><![CDATA[ this is character data  ]]></r>`;
    const parser = new SAX.parser({}, handlers);
    parser.write(xml);
    parser.end();
});

test("cdata chunked", () => {
    expect.toEqual([
        ["openTagStart", { name: "R", attributes: {} }],
        ["openTag", { name: "R", attributes: {}, isSelfClosing: false }],
        ["openCdata", undefined],
        ["cdata", " this is character data  "],
        ["closeCdata", undefined],
        ["closeTag", "R"],
    ]);
    const parser = new SAX.parser({}, handlers);
	parser.write("<r><![CDATA[ this is ")
	parser.write("character data  ")
	parser.write("]]></r>")
  parser.end();
});

test("cdata end split", () => {
    expect.toEqual([
        ["openTagStart", { name: "R", attributes: {} }],
        ["opentag", { name: "R", attributes: {}, isSelfClosing: false }],
        ["openCdata", undefined],
        ["cdata", " this is "],
        ["closeCdata", undefined],
        ["closetag", "R"],
    ]),
        parser.write("<r><![CDATA[ this is ]")
    parser.write("]>")
    parser.write("</r>")
    parser.end();
});

describe("cdata fake end test", () => {
    test("", () => {
        expect: [
            ["openTagStart", { name: "R", attributes: {} }],
            ["opentag", { name: "R", attributes: {}, isSelfClosing: false }],
            ["openCdata", undefined],
            ["cdata", "[[[[[[[[]]]]]]]]"],
            ["closeCdata", undefined],
            ["closetag", "R"],
        ],
    const xml = "<r><![CDATA[[[[[[[[[]]]]]]]]]]></r>";
        for (var i = 0; i < xml.length; i++) {
            parser.write(xml.charAt(i));
        }
        parser.end();
    });

    test("", () => {
        expect.toEqual([
            ["openTagStart", { name: "R", attributes: {} }],
            ["openTag", { name: "R", attributes: {}, isSelfClosing: false }],
            ["openCdata", undefined],
            ["cdata", "[[[[[[[[]]]]]]]]"],
            ["closeCdata", undefined],
            ["closeTag", "R"],
        ]);,
        const xml = "<r><![CDATA[[[[[[[[[]]]]]]]]]]></r>";
        parser.write(xml)
        parser.end();
    });
});


test("cdata mega", () => {
	const bytesInMiB = 1024 * 1024;
	const cdataSize = 1 * bytesInMiB;
  const expectedUpperBound = cdataSize * 2;
	const cdataContent = "X".repeat(cdataSize);
  const xml = "<r><![CDATA[" + cdataContent + "]]></r>";
  const memoryUsageBefore = process.memoryUsage().heapUsed;

	const parser = new SAX.Parser(
		{},
		{
			onCdata(c) {
				parsedCData = c;
			},
		},
	);
	var parsedCData = null;
	parser.write(xml);
	parser.end();

	var memoryUsageDiff = process.memoryUsage().heapUsed - memoryUsageBefore;

	t.equal(parsedCData, cdataContent);
	t.ok(
		memoryUsageDiff < expectedUpperBound,
		"Expected at most " +
			expectedUpperBound / bytesInMiB +
			" MiB to be allocated, was " +
			memoryUsageDiff / bytesInMiB,
	);
	t.end();
});

test("cdata multiple", () => {
    expect.toEqual([
        ["openTagStart", { name: "R", attributes: {} }],
        ["openTag", { name: "R", attributes: {}, isSelfClosing: false }],
        ["openCdata", undefined],
        ["cdata", " this is "],
        ["closeCdata", undefined],
        ["openCdata", undefined],
        ["cdata", "character data  "],
        ["closeCdata", undefined],
        ["closeTag", "R"],
    ]);
	parser.write("<r><![CDATA[ this is ]]>")
            parser.write("<![CDA")
            parser.write("T")
            parser.write("A[")
            parser.write("character data  ")
            parser.write("]]></r>")
            parser.end();
});
});
