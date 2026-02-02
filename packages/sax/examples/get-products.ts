// pull out /GeneralSearchResponse/categories/category/items/product tags
// the rest we don't care about.

import { resolve } from "node:path";
import sax from "sax";

const filePath = resolve(import.meta.dir, "shopping.xml");
const file = await Bun.file(filePath).text();

Bun.serve({
	port: 9705,
	fetch(_req: Request) {
		const parser = sax.parser(true);

		const products = [];
		var product = null;
		var currentTag = null;

		parser.onclosetag = (tagName: string) => {
			if (tagName === "product") {
				products.push(product);
				currentTag = null;
				product = null;
				return;
			}

			if (currentTag?.parent) {
				const p = currentTag.parent;
				delete currentTag.parent;
				currentTag = p;
			}
		};

		parser.onopentag = (tag) => {
			if (tag.name !== "product" && !product) return;
			if (tag.name === "product") {
				product = tag;
			}
			tag.parent = currentTag;
			tag.children = [];
			tag.parent?.children.push(tag);
			currentTag = tag;
		};

		parser.ontext = (text: string) => {
			if (currentTag) currentTag.children.push(text);
		};

		parser.write(file).end();

		return Response.json({ ok: true });
	},
});
