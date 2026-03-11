import SAX from "@janustack/sax";
import { handlers, options } from "./shared.ts";

const path = "../../assets/index.svg";
const url = new URL(path, import.meta.url);
const text = await Bun.file(url).text();

const parser = new SAX.Parser(options, handlers);
parser.write(text);
parser.end();
