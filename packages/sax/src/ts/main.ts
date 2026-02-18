export {
	EVENTS,
	HTML_NAMED_CHARACTER_ENTITIES,
	State,
	XML_PREDEFINED_ENTITIES,
} from "./constants.js";

import { Parser } from "./parser.js";

export const wasmURL: URL = new URL("./utils.wasm", import.meta.url);

export type { SAXHandlers, SAXOptions } from "./types.js";

const SAX = {
	Parser,
};

export default SAX;
