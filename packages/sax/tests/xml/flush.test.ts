import { expect, test } from "bun:test";
import SAX from "@janustack/sax";

test("flush", () => {
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

	parser.write("<T>flush");
	parser.flush();
	parser.write("rest</T>");
	parser.end();

	expect(events).toEqual([
		["openTagStart", { name: "T", attributes: {} }],
		["openTag", { name: "T", attributes: {}, isSelfClosing: false }],
		["text", "flush"],
		["text", "rest"],
		["closeTag", "T"],
	]);
});
