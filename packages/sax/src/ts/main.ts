import {
	HTML_NAMED_CHARACTER_ENTITIES,
	XML_PREDEFINED_ENTITIES,
} from "./entities.js";

import { Parser } from "./parser.js";

export const wasmURL: URL = new URL("./lib.wasm", import.meta.url);

export type { SAXHandlers, SAXOptions } from "./types.js";

const SAX = {
	Parser,
};

export default SAX;
