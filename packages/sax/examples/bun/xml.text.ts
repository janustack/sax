import { Parser as SAXParser } from "@janustack/sax";
import { handlers, options } from "./shared.ts";

const path = "../../assets/index.xml";
const url = new URL(path, import.meta.url);
const text = await Bun.file(url).text();

const parser = new SAXParser(options, handlers);
parser.write(text);
parser.end();
