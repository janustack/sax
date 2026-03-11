import SAX from "@janustack/sax";
import { handlers, options } from "./shared.ts";

const path = "../../assets/index.jsx";
const url = new URL(path, import.meta.url);
const stream = Bun.file(url).stream();

const parser = new SAX.Parser(options, handlers);

for await (const chunk of stream) {
	parser.write(chunk);
}

parser.end();
