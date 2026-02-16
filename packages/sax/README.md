example of a user consuming @janustack/sax library

example.ts:
import { Parser, type SAXHandlers, type SAXOptions } from "@janustack/sax";

const options: SAXOptions = {
	lowercase: true,
	normalize: false,
	position: true,
	strict: true,
	trim: false,
	xmlns: true,
};

const handlers: SAXHandlers = {
	onProcessingInstruction(data) {
		console.log("Processing Instruction:", data);
	},
	onComment(comment) {
		console.log("COMMENT:", comment);
	},
	onCdata(cdata) {
		console.log("CDATA:", cdata);
	},
	onOpenTag(tag) {
		console.log("OPEN:", tag.name, tag);
	},
	onAttribute(attribute) {
		console.log("Attribute:", attribute);
	},
	onText(text) {
		if (text.trim()) {
			console.log("TEXT:", text);
		}
	},
	onCloseTag(name) {
		console.log("CLOSE:", name);
	},
	onError(error) {
		console.error("ERROR:", error);
	},
};

const wasmPath = "@janustack/sax/dist/lib.wasm";
const wasmURL = new URL(wasmPath, import.meta.url);
const wasmFile = Bun.file(wasmURL);
const buffer = await wasmFile.arrayBuffer();

const parser = new Parser(options, handlers);
await parser.initWasm(buffer);

const xmlPath = "./assets/large.xml";
const xmlURL = new URL(xmlPath, import.meta.url);
const xmlFile = Bun.file(xmlURL);

const startTime = Bun.nanoseconds();

const stream = xmlFile.stream().pipeThrough(new TextDecoderStream());

for await (const chunk of stream) {
	parser.write(chunk);
}

parser.end();

const endTime = Bun.nanoseconds();

const duration = (endTime - startTime) / 1_000_000;

parser.ts:
import {
	BUFFERS,
	CDATA_SECTION_OPEN,
	DOCTYPE_KEYWORD,
	HTML_NAMED_CHARACTER_ENTITIES,
	MAX_BUFFER_LENGTH,
	NAMESPACES,
	REGEX,
	State,
	XML_PREDEFINED_ENTITIES,
} from "./constants.js";
import { SAXParserError } from "./error.js";
import type { Attribute, SAXHandlers, SAXOptions, Tag } from "./types.js";
import { applyTextOptions, getQName, isMatch } from "./utils.js";
import { isAttributeEnd, isQuote, isWhitespace } from "./wasm.js";

export class Parser {
	public error: SAXParserError | null;
	public static textDecoder: TextDecoder = new TextDecoder();
	tag: Tag | null;
	tags: Tag[];
	public handlers: SAXHandlers;
	public options: SAXOptions;
	private bufferCheckPosition = MAX_BUFFER_LENGTH;
	private caseTransform: "toLowerCase" | "toUpperCase";
	private state: State;

	private trackPosition: boolean;
	private isRootClosed: boolean;
	private hasSeenRoot: boolean;
	private isEnded: boolean;

	// Buffer strings
	private attributeName = "";
	private attributeValue = "";
	private cdata = "";
	private char = "";
	private comment = "";
	private doctype = "";
	private entity = "";
	private piBody = "";
	private piName = "";
	private quoteChar = "";
	private sgmlDeclaration = "";
	private tagName = "";
	private textNode = "";

	constructor(options: SAXOptions, handlers: SAXHandlers) {
		this.clearBuffers();
		this.quoteChar = "";
		this.char = "";
		this.bufferCheckPosition = MAX_BUFFER_LENGTH;
		this.handlers = handlers ?? {};
		this.options = options ?? {};
		this.options.lowercase =
			this.options.lowercase || this.options.lowercaseTags;
		this.caseTransform = this.options.lowercase ? "toLowerCase" : "toUpperCase";
		this.tags = [];
		this.isEnded = false;
		this.isRootClosed = false;
		this.hasSeenRoot = false;
		this.tag = null;
		this.error = null;
		this.state = State.BEGIN;
		this.ENTITIES = this.options.strictEntities
			? Object.create(XML_PREDEFINED_ENTITIES)
			: Object.create(HTML_NAMED_CHARACTER_ENTITIES);
		this.attributeList = [];

		// namespaces form a prototype chain.
		// it always points at the current tag,
		// which protos to its parent tag.
		if (this.options.xmlns) {
			this.ns = Object.create(NAMESPACES);
		}

		// disallow unquoted attribute values if not otherwise configured  and strict mode is true
		if (this.options.unquotedAttributeValues === undefined) {
			this.options.unquotedAttributeValues = !this.options.strict;
		}

		this.trackPosition = this.options.trackPosition ?? false;

		// mostly just for error reporting
		if (this.trackPosition) {
			this.position = 0;
			this.lineNumber = 0;
			this.columnNumber = 0;
		}

		this.emit("onReady");
	}

	public async initWasm(
		source: Response | Uint8Array | WebAssembly.Module,
	): Promise<boolean> {
		const env = {};

		let instance: WebAssembly.Instance;

		try {
			if (source instanceof Uint8Array) {
				const result = await WebAssembly.instantiate(
					source.buffer as ArrayBuffer,
					{
						env,
					},
				);
				instance = result?.instance;
			} else if (source instanceof WebAssembly.Module) {
				instance = await WebAssembly.instantiate(source, { env });
			} else {
				const result = await WebAssembly.instantiateStreaming(source, { env });
				instance = result?.instance;
			}
		} catch (error) {
			throw new Error(`Failed to instantiate Wasm: ${error}`);
		}
	}

	public end(): void {
		if (this.hasSeenRoot && !this.isRootClosed) {
			this.fail("Unclosed root tag");
		}

		if (
			this.state !== State.BEGIN &&
			this.state !== State.BEGIN_WHITESPACE &&
			this.state !== State.TEXT
		) {
			this.fail("Unexpected end");
		}

		this.closeText();

		this.char = "";
		this.isEnded = true;

		this.emit("onEnd");
	}

	public write(chunk: Uint8Array | string): void {
		if (this.error) {
			throw this.error;
		}

		if (this.isEnded) {
			this.fail("Cannot write after close. Assign an onready handler.");
			return;
		}

		if (typeof chunk === "object") {
			chunk = chunk.toString();
		}

		let i = 0;
		let char = "";

		while (true) {
			char = chunk.charAt(i++);
			this.char = char;

			if (!char) {
				break;
			}

			if (this.trackPosition) {
				this.position++;

				if (char === "\n") {
					this.lineNumber++;
					this.columnNumber = 0;
				} else {
					this.columnNumber++;
				}
			}

			switch (this.state) {
				case State.BEGIN: {
					this.state = State.BEGIN_WHITESPACE;

					if (char === "\uFEFF") {
						continue;
					}

					this.beginWhitespace(char);
					continue;
				}

				case State.BEGIN_WHITESPACE: {
					this.beginWhitespace(char);
					continue;
				}

				case State.TEXT: {
					if (this.hasSeenRoot && !this.isRootClosed) {
						const startIndex = i - 1;

						while (char && char !== "<" && char !== "&") {
							char = chunk.charAt(i++);

							if (char && this.trackPosition) {
								this.position++;

								if (char === "\n") {
									this.lineNumber++;
									this.columnNumber = 0;
								} else {
									this.columnNumber++;
								}
							}
						}

						this.textNode += chunk.substring(startIndex, i - 1);
					}

					if (
						char === "<" &&
						!(this.hasSeenRoot && this.isRootClosed && !this.options.strict)
					) {
						this.state = State.OPEN_WAKA;
						this.startTagPosition = this.position;
						continue;
					}

					if (!isWhitespace(char) && (!this.hasSeenRoot || this.isRootClosed)) {
						this.fail("Text data outside of root node.");
					}

					if (char === "&") {
						this.state = State.TEXT_ENTITY;
						continue;
					}

					this.textNode += char;
					continue;
				}

				case State.OPEN_WAKA: {
					// either a /, ?, !, or text is coming next.
					if (char === "!") {
						this.state = State.SGML_DECLARATION;
						this.sgmlDeclaration = "";
						continue;
					}

					if (isWhitespace(char)) {
						continue;
					}

					if (isMatch(REGEX.NAME_START, char)) {
						this.state = State.OPEN_TAG;
						this.tagName = char;
						continue;
					}

					if (char === "/") {
						this.state = State.CLOSE_TAG;
						this.tagName = "";
						continue;
					}

					if (char === "?") {
						this.state = State.PROCESSING_INSTRUCTION;
						this.piName = "";
						this.piBody = "";
						continue;
					}

					this.fail("Unencoded <");

					// if there was some whitespace, then add that in.
					if (this.startTagPosition + 1 < this.position) {
						const pad = this.position - this.startTagPosition;
						this.textNode += " ".repeat(pad);
					}

					this.textNode += `<${char}`;
					this.state = State.TEXT;
					continue;
				}

				case State.SGML_DECLARATION: {
					if (this.sgmlDeclaration + char === "--") {
						this.state = State.COMMENT;
						this.comment = "";
						this.sgmlDeclaration = "";
						continue;
					}

					if (this.doctype && this.doctype !== true && this.sgmlDeclaration) {
						this.state = State.DOCTYPE_DTD;
						this.doctype += `<!${this.sgmlDeclaration}${char}`;
						this.sgmlDeclaration = "";
						continue;
					}

					if (
						(this.sgmlDeclaration + char).toUpperCase() === CDATA_SECTION_OPEN
					) {
						this.emitNode("onOpenCdata");
						this.state = State.CDATA;
						this.sgmlDeclaration = "";
						this.cdata = "";
						continue;
					}

					if ((this.sgmlDeclaration + char).toUpperCase() === DOCTYPE_KEYWORD) {
						this.state = State.DOCTYPE;

						if (this.doctype || this.hasSeenRoot) {
							this.fail("Inappropriately located doctype declaration");
						}

						this.doctype = "";
						this.sgmlDeclaration = "";
						continue;
					}

					if (char === ">") {
						this.emitNode("onSgmlDeclaration", this.sgmlDeclaration);
						this.sgmlDeclaration = "";
						this.state = State.TEXT;
						continue;
					}

					if (isQuote(char)) {
						this.state = State.SGML_DECLARATION_QUOTED;
						this.sgmlDeclaration += char;
						continue;
					}

					this.sgmlDeclaration += char;
					continue;
				}

				case State.SGML_DECLARATION_QUOTED: {
					if (char === this.quoteChar) {
						this.state = State.SGML_DECLARATION;
						this.quoteChar = "";
					}
					this.sgmlDeclaration += char;
					continue;
				}

				case State.DOCTYPE: {
					if (char === ">") {
						this.state = State.TEXT;
						this.emitNode("onDoctype", this.doctype);
						this.doctype = true; // remember we saw one
						continue;
					}

					this.doctype += char;

					if (char === "[") {
						this.state = State.DOCTYPE_DTD;
						continue;
					}

					if (isQuote(char)) {
						this.state = State.DOCTYPE_QUOTED;
						this.quoteChar = char;
						continue;
					}

					continue;
				}

				case State.DOCTYPE_QUOTED: {
					this.doctype += char;
					if (char === this.quoteChar) {
						this.quoteChar = "";
						this.state = State.DOCTYPE;
					}
					continue;
				}

				case State.DOCTYPE_DTD: {
					if (char === "]") {
						this.doctype += char;
						this.state = State.DOCTYPE;
						continue;
					}

					if (char === "<") {
						this.state = State.OPEN_WAKA;
						this.startTagPosition = this.position;
						continue;
					}

					if (isQuote(char)) {
						this.doctype += char;
						this.state = State.DOCTYPE_DTD_QUOTED;
						this.quoteChar = char;
						continue;
					}

					this.doctype += char;
					continue;
				}

				case State.DOCTYPE_DTD_QUOTED: {
					this.doctype += char;
					if (char === this.quoteChar) {
						this.state = State.DOCTYPE_DTD;
						this.quoteChar = "";
					}
					continue;
				}

				case State.COMMENT: {
					if (char === "-") {
						this.state = State.COMMENT_ENDING;
						continue;
					}

					this.comment += char;
					continue;
				}

				case State.COMMENT_ENDING: {
					if (char === "-") {
						this.state = State.COMMENT_ENDED;
						this.comment = applyTextOptions(this.options, this.comment);

						if (this.comment) {
							this.emitNode("onComment", this.comment);
						}

						this.comment = "";
						continue;
					}

					this.comment += `-${char}`;
					this.state = State.COMMENT;
					continue;
				}

				case State.COMMENT_ENDED: {
					if (char !== ">") {
						this.fail("Malformed comment");
						// allow <!-- blah -- bloo --> in non-strict mode,
						// which is a comment of " blah -- bloo "
						this.comment += `--${char}`;
						this.state = State.COMMENT;
						continue;
					}

					if (this.doctype && this.doctype !== true) {
						this.state = State.DOCTYPE_DTD;
						continue;
					}

					this.state = State.TEXT;
					continue;
				}

				case State.CDATA: {
					const startIndex = i - 1;

					while (char && char !== "]") {
						char = chunk.charAt(i++);

						if (char && this.trackPosition) {
							this.position++;

							if (char === "\n") {
								this.lineNumber++;
								this.columnNumber = 0;
								continue;
							}

							this.columnNumber++;
						}
					}

					this.cdata += chunk.substring(startIndex, i - 1);

					if (char === "]") {
						this.state = State.CDATA_ENDING;
					}

					continue;
				}

				case State.CDATA_ENDING: {
					if (char === "]") {
						this.state = State.CDATA_ENDING_2;
						continue;
					}

					this.cdata += `]${char}`;
					this.state = State.CDATA;
					continue;
				}

				case State.CDATA_ENDING_2: {
					if (char === ">") {
						if (this.cdata) {
							this.emitNode("onCdata", this.cdata);
						}

						this.emitNode("onCloseCdata");

						this.cdata = "";
						this.state = State.TEXT;
						continue;
					}

					if (char === "]") {
						this.cdata += "]";
						continue;
					}

					this.cdata += `]]${char}`;
					this.state = State.CDATA;
					continue;
				}

				case State.PROCESSING_INSTRUCTION: {
					if (char === "?") {
						this.state = State.PROCESSING_INSTRUCTION_ENDING;
						continue;
					}

					if (isWhitespace(char)) {
						this.state = State.PROCESSING_INSTRUCTION_BODY;
						continue;
					}

					this.piName += char;
					continue;
				}

				case State.PROCESSING_INSTRUCTION_BODY: {
					if (!this.piBody && isWhitespace(char)) {
						continue;
					}

					if (char === "?") {
						this.state = State.PROCESSING_INSTRUCTION_ENDING;
						continue;
					}

					this.piBody += char;
					continue;
				}

				case State.PROCESSING_INSTRUCTION_ENDING: {
					if (char === ">") {
						this.emitNode("onProcessingInstruction", {
							name: this.piName,
							body: this.piBody,
						});

						this.piName = "";
						this.piBody = "";
						this.state = State.TEXT;
						continue;
					}

					this.piBody += `?${char}`;
					this.state = State.PROCESSING_INSTRUCTION_BODY;
					continue;
				}

				case State.OPEN_TAG: {
					if (isMatch(REGEX.NAME_BODY, char)) {
						this.tagName += char;
						continue;
					}

					this.newTag();

					if (char === ">") {
						this.openTag();
						continue;
					}

					if (char === "/") {
						this.state = State.OPEN_TAG_SLASH;
						break;
					}

					if (!isWhitespace(char)) {
						this.fail("Invalid character in tag name");
					}

					this.state = State.ATTRIBUTE;
					continue;
				}

				case State.OPEN_TAG_SLASH: {
					if (char === ">") {
						this.openTag(true);
						this.closeTag();
						continue;
					}

					this.fail("Forward-slash in opening tag not followed by >");

					this.state = State.ATTRIBUTE;
					continue;
				}

				case State.ATTRIBUTE: {
					if (isWhitespace(char)) {
						continue;
					}

					if (char === ">") {
						this.openTag();
						continue;
					}

					if (char === "/") {
						this.state = State.OPEN_TAG_SLASH;
						continue;
					}

					if (isMatch(REGEX.NAME_START, char)) {
						this.attributeName = char;
						this.attributeValue = "";
						this.state = State.ATTRIBUTE_NAME;
						continue;
					}

					this.fail("Invalid attribute name");
					continue;
				}

				case State.ATTRIBUTE_NAME: {
					if (char === "=") {
						this.state = State.ATTRIBUTE_VALUE;
						continue;
					}

					if (char === ">") {
						this.fail("Attribute without value");
						this.attributeValue = this.attributeName;
						this.processAttribute();
						this.openTag();
						continue;
					}

					if (isWhitespace(char)) {
						this.state = State.ATTRIBUTE_NAME_SAW_WHITE;
						continue;
					}

					if (isMatch(REGEX.NAME_BODY, char)) {
						this.attributeName += char;
						continue;
					}

					this.fail("Invalid attribute name");
					continue;
				}

				case State.ATTRIBUTE_NAME_SAW_WHITE: {
					if (char === "=") {
						this.state = State.ATTRIBUTE_VALUE;
						continue;
					}

					if (isWhitespace(char)) {
						continue;
					}

					this.fail("Attribute without value");

					this.tag.attributes[this.attributeName] = "";
					this.attributeValue = "";

					this.emitNode("onAttribute", {
						name: this.attributeName,
						value: "",
					});

					this.attributeName = "";

					if (char === ">") {
						this.openTag();
						continue;
					}

					if (isMatch(REGEX.NAME_START, char)) {
						this.attributeName = char;
						this.state = State.ATTRIBUTE_NAME;
						continue;
					}

					this.fail("Invalid attribute name");
					this.state = State.ATTRIBUTE;
					continue;
				}

				case State.ATTRIBUTE_VALUE: {
					if (isWhitespace(char)) {
						continue;
					}

					if (isQuote(char)) {
						this.quoteChar = char;
						this.state = State.ATTRIBUTE_VALUE_QUOTED;
						continue;
					}

					if (!this.options.unquotedAttributeValues) {
						this.fail("Unquoted attribute value");
					}

					this.state = State.ATTRIBUTE_VALUE_UNQUOTED;
					this.attributeValue = char;
					continue;
				}

				case State.ATTRIBUTE_VALUE_QUOTED: {
					if (char !== this.quoteChar) {
						if (char === "&") {
							this.state = State.ATTRIBUTE_VALUE_ENTITY_QUOTED;
							continue;
						}

						this.attributeValue += char;
						continue;
					}

					this.processAttribute();
					this.quoteChar = "";
					this.state = State.ATTRIBUTE_VALUE_CLOSED;
					continue;
				}

				case State.ATTRIBUTE_VALUE_CLOSED: {
					if (isWhitespace(char)) {
						this.state = State.ATTRIBUTE;
						continue;
					}

					if (char === ">") {
						this.openTag();
						continue;
					}

					if (char === "/") {
						this.state = State.OPEN_TAG_SLASH;
						continue;
					}

					if (isMatch(REGEX.NAME_START, char)) {
						this.fail("No whitespace between attributes");
						this.attributeName = char;
						this.attributeValue = "";
						this.state = State.ATTRIBUTE_NAME;
						continue;
					}

					this.fail("Invalid attribute name");
					continue;
				}

				case State.ATTRIBUTE_VALUE_UNQUOTED: {
					if (!isAttributeEnd(char)) {
						if (char === "&") {
							this.state = State.ATTRIBUTE_VALUE_ENTITY_UNQUOTED;
							continue;
						}

						this.attributeValue += char;
						continue;
					}

					this.processAttribute();

					if (char === ">") {
						this.openTag();
						continue;
					}

					this.state = State.ATTRIBUTE;
					continue;
				}

				case State.CLOSE_TAG: {
					if (!this.tagName) {
						if (isWhitespace(char)) {
							continue;
						}

						if (!isMatch(REGEX.NAME_START, char)) {
							this.fail("Invalid closing tag name.");
							continue;
						}

						this.tagName = char;
						continue;
					}

					if (char === ">") {
						this.closeTag();
						continue;
					}

					if (isMatch(REGEX.NAME_BODY, char)) {
						this.tagName += char;
						continue;
					}

					if (!isWhitespace(char)) {
						this.fail("Invalid tagname in closing tag");
						continue;
					}

					this.state = State.CLOSE_TAG_SAW_WHITE;
					continue;
				}

				case State.CLOSE_TAG_SAW_WHITE: {
					if (isWhitespace(char)) {
						continue;
					}

					if (char === ">") {
						this.closeTag();
						continue;
					}

					this.fail("Invalid characters in closing tag");
					continue;
				}

				case State.TEXT_ENTITY:
				case State.ATTRIBUTE_VALUE_ENTITY_QUOTED:
				case State.ATTRIBUTE_VALUE_ENTITY_UNQUOTED: {
					let returnState: State;
					let buffer: "attributeValue" | "textNode";

					switch (this.state) {
						case State.TEXT_ENTITY:
							returnState = State.TEXT;
							buffer = "textNode";
							break;

						case State.ATTRIBUTE_VALUE_ENTITY_QUOTED:
							returnState = State.ATTRIBUTE_VALUE_QUOTED;
							buffer = "attributeValue";
							break;

						case State.ATTRIBUTE_VALUE_ENTITY_UNQUOTED:
							returnState = State.ATTRIBUTE_VALUE_UNQUOTED;
							buffer = "attributeValue";
							break;
					}

					if (char === ";") {
						const parsedEntity = this.parseEntity();

						if (
							this.options.unparsedEntities &&
							!Object.values(XML_PREDEFINED_ENTITIES).includes(parsedEntity)
						) {
							this.entity = "";
							this.state = returnState;
							this.write(parsedEntity);
						} else {
							this[buffer] += parsedEntity;
							this.entity = "";
							this.state = returnState;
						}
						continue;
					}

					if (
						isMatch(
							this.entity.length ? REGEX.ENTITY_BODY : REGEX.ENTITY_START,
							char,
						)
					) {
						this.entity += char;
						continue;
					}

					this.fail("Invalid character in entity name");
					this[buffer] += `&${this.entity}${char}`;
					this.entity = "";
					this.state = returnState;
					continue;
				}

				default: {
					throw new Error(`Unknown state: ${this.state}`);
				}
			}
		} // while loop

		if (this.position >= this.bufferCheckPosition) {
			this.checkBufferLength();
		}
	}

	private processAttribute(): void {
		if (!this.options.strict) {
			this.attributeName = this.attributeName[this.caseTransform]();
		}

		if (
			this.attributeList.includes(this.attributeName) ||
			Object.hasOwn(this.tag.attributes, this.attributeName)
		) {
			this.attributeName = "";
			this.attributeValue = "";
			return;
		}

		if (this.options.xmlns) {
			const qName = getQName(this.attributeName, true);
			const prefix = qName.prefix;
			const localName = qName.localName;

			if (prefix === "xmlns") {
				// namespace binding attribute. push the binding into scope
				if (localName === "xml" && this.attributeValue !== NAMESPACES.xml) {
					this.fail(
						`xml: prefix must be bound to ${NAMESPACES.xml}\nActual: ${this.attributeValue}`,
					);
				} else if (
					localName === "xmlns" &&
					this.attributeValue !== NAMESPACES.xmlns
				) {
					this.fail(
						`xmlns: prefix must be bound to ${NAMESPACES.xml}\nActual: ${this.attributeValue}`,
					);
				} else {
					const tag = this.tag;
					const parent = this.tags.at(-1) || this;

					if (tag.ns === parent.ns) {
						tag.ns = Object.create(parent.ns);
					}

					tag.ns[localName] = this.attributeValue;
				}
			}

			// defer onattribute events until all attributes have been seen
			// so any new bindings can take effect. preserve attribute order
			// so deferred events can be emitted in document order
			this.attributeList.push([this.attributeName, this.attributeValue]);
		} else {
			// in non-xmlns mode, we can emit the event right away
			this.tag.attributes[this.attributeName] = this.attributeValue;
			this.emitNode("onAttribute", {
				name: this.attributeName,
				value: this.attributeValue,
			});
		}

		this.attributeName = "";
		this.attributeValue = "";
	}

	private beginWhitespace(char: string): void {
		if (char === "<") {
			this.state = State.OPEN_WAKA;
			this.startTagPosition = this.position;
			return;
		}

		if (!isWhitespace(char)) {
			// have to process this as a text node.
			// weird, but happens.
			this.fail("Non-whitespace before first tag.");
			this.textNode = char;
			this.state = State.TEXT;
		}
	}

	private checkBufferLength(): void {
		const threshold = Math.max(MAX_BUFFER_LENGTH, 10);
		let maxActual = 0;

		for (const buffer of BUFFERS) {
			const len = this[buffer].length;

			if (len > threshold) {
				// Text/cdata nodes can get big, and since they're buffered,
				// we can get here under normal conditions.
				// Avoid issues by emitting the text node now,
				// so at least it won't get any bigger.
				switch (buffer) {
					case "textNode": {
						this.closeText();
						break;
					}

					case "cdata": {
						this.emitNode("onCdata", this.cdata);
						this.cdata = "";
						break;
					}

					default: {
						this.fail(`Max buffer length exceeded: ${buffer}`);
					}
				}
			}

			maxActual = Math.max(maxActual, len);
		}

		this.bufferCheckPosition = MAX_BUFFER_LENGTH - maxActual + this.position;
	}

	private clearBuffers(): void {
		for (const buffer of BUFFERS) {
			this[buffer] = "";
		}
	}

	private closeTag(): void {
		if (!this.tagName) {
			this.fail("Weird empty close tag.");
			this.textNode += "</>";
			this.state = State.TEXT;
			return;
		}

		// first make sure that the closing tag actually exists.
		// <a><b></c></b></a> will close everything, otherwise.
		let t = this.tags.length;
		let tagName = this.tagName;

		if (!this.options.strict) {
			tagName = tagName[this.caseTransform]();
		}

		const closeTo = tagName;

		while (t--) {
			const close = this.tags[t];

			if (close.name === closeTo) {
				break;
			}

			this.fail("Unexpected close tag");
		}

		// didn't find it.  we already failed for strict, so just abort.
		if (t < 0) {
			this.fail(`Unmatched closing tag: ${this.tagName}`);
			this.textNode += `</${this.tagName}>`;
			this.state = State.TEXT;
			return;
		}

		this.tagName = tagName;

		let s = this.tags.length;

		while (s-- > t) {
			this.tag = this.tags.pop();
			const tag = this.tag;

			this.tagName = this.tag.name;
			this.emitNode("onCloseTag", this.tagName);

			const parent = this.tags.at(-1) || this;

			if (this.options.xmlns && tag.ns !== parent.ns) {
				// remove namespace bindings introduced by tag
				Object.keys(tag.ns).forEach((prefix) => {
					this.emitNode("onCloseNamespace", { prefix, uri: tag.ns[prefix] });
				});
			}
		}

		if (t === 0) {
			this.isRootClosed = true;
		}

		this.tagName = "";
		this.attributeValue = "";
		this.attributeName = "";
		this.attributeList.length = 0;
		this.state = State.TEXT;
	}

	private closeText() {
		this.textNode = applyTextOptions(this.options, this.textNode);
		if (this.textNode) {
			this.emit("onText", this.textNode);
		}
		this.textNode = "";
	}

	private emit<T extends keyof SAXHandlers>(event: T, data?: any): void {
		const handler = this.handlers[event];
		if (typeof handler === "function") {
			handler(data);
		}
	}

	private emitNode<T extends keyof SAXHandlers>(nodeType: T, data?: any): void {
		if (this.textNode) {
			this.closeText();
		}
		this.emit(nodeType, data);
	}

	private fail(message: string): this {
		this.closeText();
		const error = new SAXParserError(
			this.columnNumber,
			this.lineNumber,
			message,
		);
		this.error = error;
		this.emit("onError", error);
		return this;
	}

	public flush(): void {
		this.closeText();

		if (this.cdata !== "") {
			this.emitNode("onCdata", this.cdata);
			this.cdata = "";
		}
	}

	private newTag(): void {
		if (!this.options.strict) {
			this.tagName = this.tagName[this.caseTransform]();
		}

		const parent = this.tags.at(-1) || this;

		const tag: Tag = {
			name: this.tagName,
			attributes: {},
		};

		this.tag = tag;

		// will be overridden if tag contails an xmlns="foo" or xmlns:foo="bar"
		if (this.options.xmlns) {
			tag.ns = parent.ns;
		}

		this.attributeList.length = 0;
		this.emitNode("onOpenTagStart", tag);
	}

	private openTag(selfClosing?: boolean): void {
		if (this.options.xmlns) {
			const tag = this.tag;
			const qName = getQName(this.tagName);

			tag.prefix = qName.prefix;
			tag.localName = qName.localName;
			tag.uri = tag.ns[qName.prefix] || "";

			if (tag.prefix && !tag.uri) {
				this.fail(`Unbound namespace prefix: ${JSON.stringify(this.tagName)}`);
				tag.uri = qName.prefix;
			}

			const parent = this.tags.at(-1) || this;

			if (tag.ns && parent.ns !== tag.ns) {
				Object.keys(tag.ns).forEach((prefix) => {
					this.emitNode("onOpenNamespace", {
						prefix,
						uri: tag.ns[prefix],
					});
				});
			}

			// handle deferred onattribute events
			// Note: do not apply default ns to attributes:
			//   http://www.w3.org/TR/REC-xml-names/#defaulting
			for (const [name, value] of this.attributeList) {
				const qName = getQName(name, true);
				const prefix = qName.prefix;
				const localName = qName.localName;
				const uri = prefix === "" ? "" : tag.ns[prefix] || "";

				const attribute: Attribute = {
					name,
					value,
					prefix,
					localName,
					uri,
				};

				// if there's any attributes with an undefined namespace,
				// then fail on them now.
				if (prefix && prefix !== "xmlns" && !uri) {
					this.fail(`Unbound namespace prefix: ${JSON.stringify(prefix)}`);
					attribute.uri = prefix;
				}
				this.tag.attributes[name] = attribute;
				this.emitNode("onAttribute", attribute);
			}

			this.attributeList.length = 0;
		}

		this.tag.isSelfClosing = Boolean(selfClosing);

		// process the tag
		this.hasSeenRoot = true;
		this.tags.push(this.tag);

		this.emitNode("onOpenTag", this.tag);

		if (!selfClosing) {
			this.state = State.TEXT;
			this.tag = null;
			this.tagName = "";
		}

		this.attributeName = "";
		this.attributeValue = "";
		this.attributeList.length = 0;
	}

	private parseEntity(): string {
		let entity = this.entity;
		const entityLC = entity.toLowerCase();
		let number = NaN;
		let numberString = "";

		if (this.ENTITIES[entity]) {
			return this.ENTITIES[entity];
		}

		if (this.ENTITIES[entityLC]) {
			return this.ENTITIES[entityLC];
		}

		entity = entityLC;

		if (entity.startsWith("#")) {
			if (entity.startsWith("#x")) {
				entity = entity.slice(2);
				number = Number.parseInt(entity, 16);
				numberString = number.toString(16);
			} else {
				entity = entity.slice(1);
				number = Number.parseInt(entity, 10);
				numberString = number.toString(10);
			}
		}

		entity = entity.replace(/^0+/, "");

		if (
			Number.isNaN(number) ||
			numberString.toLowerCase() !== entity ||
			number < 0 ||
			number > 0x10ffff
		) {
			this.fail("Invalid character entity");
			return `&${this.entity};`;
		}

		return String.fromCodePoint(number);
	}
}

wasm.ts:
import type { WasmExports } from "./types.js";

let wasmExports: WasmExports;

const decoder = new TextDecoder();

export function readString(
	memory: WebAssembly.Memory,
	byteOffset: number,
	length: number,
): string {
	const bytes = new Uint8Array(memory.buffer, byteOffset, length);
	return decoder.decode(bytes);
}

export function isWhitespace(char: string): boolean {
	return wasmExports.isWhitespace(char.charCodeAt(0)));
}
export function isQuote(char: string): boolean {
	return wasmExports.isQuote(char.charCodeAt(0)));
}
export function isAttributeEnd(char: string): boolean {
	return wasmExports.isAttributeEnd(char.charCodeAt(0)));
}

types.ts:
export type WasmExports = {
	isAttributeEnd(char: string): string;
	isQuote(char: string): string;
	isWhitespace(char: string): string;
	memory: WebAssembly.Memory;
};

utils.zig:
const std = @import("std");

export fn isAttributeEnd(byte: u8) bool {
    if (byte == '>' or std.ascii.isWhitespace(byte)) {
        return true;
    }

    return false;
}

export fn isQuote(byte: u8) bool {
    return byte == '"' or byte == '\'';
}

export fn isWhitespace(byte: u8) bool {
    return byte == ' ' or byte == '\n' or byte == '\r' or byte == '\t';
}
