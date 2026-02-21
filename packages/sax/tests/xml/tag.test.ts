import { beforeAll, describe, expect, test } from "bun:test";
import SAX, { type SAXOptions, wasmURL } from "@janustack/sax";

describe("Tag Parsing", () => {
	let bytes: Uint8Array;

	beforeAll(async () => {
		bytes = await Bun.file(wasmURL).bytes();
	});

	test("should parse a basic open tag", async () => {
		let resultNode: any = null;
		const xml = "<x>y</x>";
		const parser = new SAX.Parser(
			{ strict: true },
			{
				onOpenTag(tag) {
					resultNode = tag;
				},
			},
		);
		await parser.initWasm(bytes);
		parser.write(xml);
		parser.end();
		expect(resultNode).toEqual({
			name: "x",
			attributes: {},
			isSelfClosing: false,
		});
	});
});
