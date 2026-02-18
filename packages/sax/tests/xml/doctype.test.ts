import { describe, expect, test } from "bun:test";
import SAX, { type SAXOptions } from "@janustack/sax";

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

describe("DOCTYPE parsing", () => {
	test.each([
		{
			name: "emits doctype with internal entity declaration",
			xml: '<!DOCTYPE svg [ <!ENTITY ns_graphs "http://ns.adobe.com/Graphs/1.0/"> ]><svg></svg>',
			expected: [
				[
					"doctype",
					' svg [ <!ENTITY ns_graphs "http://ns.adobe.com/Graphs/1.0/"> ]',
				],
				["openTagStart", { name: "SVG", attributes: {} }],
				["openTag", { name: "SVG", attributes: {}, isSelfClosing: false }],
				["closeTag", "SVG"],
			],
		},
		{
			name: "with comment",
			xml: "<!DOCTYPE svg [<!--comment with ' and ] symbols-->]><svg></svg>",
			expected: [
				["comment", "comment with ' and ] symbols"],
				["doctype", " svg []"],
				["openTagStart", { name: "SVG", attributes: {} }],
				["openTag", { name: "SVG", attributes: {}, isSelfClosing: false }],
				["closeTag", "SVG"],
			],
		},
		{
			name: "with entity and comment",
			xml: '<!DOCTYPE svg [<!--comment with \' and ] symbols--> <!ENTITY ns_graphs "http://ns.adobe.com/Graphs/1.0/"> ]><svg></svg>',
			expected: [
				["comment", "comment with ' and ] symbols"],
				[
					"doctype",
					' svg [ <!ENTITY ns_graphs "http://ns.adobe.com/Graphs/1.0/"> ]',
				],
				["openTagStart", { name: "SVG", attributes: {} }],
				["openTag", { name: "SVG", attributes: {}, isSelfClosing: false }],
				["closeTag", "SVG"],
			],
		},
		{
			name: "emits empty internal subset",
			xml: "<!DOCTYPE svg []><svg></svg>",
			expected: [
				["doctype", " svg []"],
				["openTagStart", { name: "SVG", attributes: {} }],
				["openTag", { name: "SVG", attributes: {}, isSelfClosing: false }],
				["closeTag", "SVG"],
			],
		},
	])("$name", ({ xml, expected }) => {
		expect(parse(xml)).toEqual(expected);
	});
});
