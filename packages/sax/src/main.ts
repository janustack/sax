import {
	ENTITIES,
	EVENTS,
	PREDEFINED_INTERNAL_ENTITIES,
	State,
} from "./constants.js";
import { SAXParser } from "./parser.js";
import { SAXStreamer } from "./streamer.js";
import type { SAXOptions } from "./types.js";

export function parser(
	isStrict: boolean = false,
	options: SAXOptions = {},
): SAXParser {
	return new SAXParser(isStrict, options);
}

export function streamer(
	isStrict: boolean = false,
	options: SAXOptions = {},
): SAXStreamer {
	return new SAXStreamer(isStrict, options);
}

const sax = {
	ENTITIES,
	EVENTS,
	PREDEFINED_INTERNAL_ENTITIES,
	SAXParser,
	State,
	parser,
	streamer,
} as const;

export default sax;
