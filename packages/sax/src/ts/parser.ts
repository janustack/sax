import {
	BUFFERS,
	MAX_BUFFER_LENGTH,
	NAMESPACES,
	REGEX,
	State,
} from "./constants.js";
import {
	HTML_NAMED_CHARACTER_ENTITIES,
	XML_PREDEFINED_ENTITIES,
} from "./entities.js";
import { SAXParserError } from "./error.js";
import type {
	Attribute,
	SAXHandlers,
	SAXOptions,
	Tag,
	WasmExports,
} from "./types.js";
import {
	applyTextOptions,
	getQName,
	isAttributeEnd,
	isMatch,
	isQuote,
	isWhitespace,
} from "./utils.js";

export class Parser {
	public static decoder: TextDecoder = new TextDecoder();
	public static encoder: TextEncoder = new TextEncoder();

	public error: SAXParserError | null = null;
	public handlers: Partial<SAXHandlers>;
	public options: SAXOptions;
	public tag: Tag | null = null;
	public tags: Tag[] = [];

	private column = 0;
	private line = 0;
	private position = 0;
	private startTagPosition = 0;

	private attributeList: [string, string][] = [];
	private bufferCheckPosition = MAX_BUFFER_LENGTH;
	private applyCaseTransform: (name: string) => string = (name) => name;
	private ENTITIES: Record<string, string>;
	private hasDoctype = false;
	private hasSeenRoot = false;
	private isEnded = false;
	private isRootClosed = false;
	private ns: Record<string, string>;
	private state = State.BEGIN;
	private wasm: WasmExports;

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
	// or declare the variables here instead?

	constructor(
		options: Partial<SAXOptions> = {},
		handlers: Partial<SAXHandlers> = {},
	) {
		this.handlers = handlers;

		this.options = {
			caseTransform: "preserve",
			namespaces: false,
			normalize: false,
			strict: false,
			strictEntities: false,
			trackPosition: false,
			trim: false,
			...options,
		};

		if (this.options.caseTransform === "lowercase") {
			this.applyCaseTransform = (string) => string.toLowerCase();
		} else if (this.options.caseTransform === "uppercase") {
			this.applyCaseTransform = (string) => string.toUpperCase();
		}

		if (this.options.strictEntities === true) {
			this.ENTITIES = XML_PREDEFINED_ENTITIES;
		} else {
			this.ENTITIES = HTML_NAMED_CHARACTER_ENTITIES;
		}

		if (this.options.namespaces === true) {
			this.ns = Object.create(NAMESPACES);
		}
		// disallow unquoted attribute values if not otherwise configured  and strict mode is true
		if (this.options.unquotedAttributeValues === undefined) {
			this.options.unquotedAttributeValues = !this.options.strict;
		}

		this.emit("onReady");
	}

	public async loadWasm(
		source: Response | Uint8Array | WebAssembly.Module,
	): Promise<boolean> {
		let instance: WebAssembly.Instance;
		const imports = { env: {} };

		try {
			if (source instanceof Uint8Array) {
				const result = await WebAssembly.instantiate(
					source.buffer as ArrayBuffer,
					imports,
				);
				instance = result?.instance;
			} else if (source instanceof WebAssembly.Module) {
				instance = await WebAssembly.instantiate(source, imports);
			} else {
				const result = await WebAssembly.instantiateStreaming(source, imports);
				instance = result.instance;
			}

			const exports = instance.exports as unknown as WasmExports;
			this.wasm = exports;
			return true;
		} catch (error) {
			throw new Error(`Failed to instantiate Wasm: ${error}`);
		}
	}

	public end(): void {
		if (this.isEnded) return;

		this.flush();

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

		this.char = "";
		this.isEnded = true;

		this.emit("onEnd");
	}

	public flush(): void {
		this.closeText();

		if (this.cdata !== "") {
			this.emitNode("onCdata", this.cdata);
			this.cdata = "";
		}
	}

	public async parse(input: ReadableStream<Uint8Array>): Promise<void> {}

	public write(chunk: Uint8Array | string): void {
		if (this.error) {
			throw this.error;
		}

		if (!this.wasm) {
			this.fail(
				"Wasm not initialized. Make sure to await parser.initWasm() before writing.",
			);
			return;
		}

		if (this.isEnded) {
			this.fail("Cannot write after close. Assign an onReady handler.");
			return;
		}

		if (chunk instanceof Uint8Array) {
			chunk = Parser.decoder.decode(chunk, { stream: true });
		}

		let i = 0;
		let char = "";

		while (true) {
			char = chunk.charAt(i++);
			this.char = char;

			if (!char) {
				break;
			}

			if (this.options.trackPosition) {
				this.position += 1;

				if (char === "\n") {
					this.line += 1;
					this.column = 0;
				} else {
					this.column += 1;
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

							if (char && this.options.trackPosition) {
								this.position += 1;

								if (char === "\n") {
									this.line += 1;
									this.column = 0;
								} else {
									this.column += 1;
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

					if (
						!isWhitespace(this.wasm, char) &&
						(!this.hasSeenRoot || this.isRootClosed)
					) {
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

					if (isWhitespace(this.wasm, char)) {
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

					if (
						this.doctype &&
						this.hasDoctype !== true &&
						this.sgmlDeclaration
					) {
						this.state = State.DOCTYPE_DTD;
						this.doctype += `<!${this.sgmlDeclaration}${char}`;
						this.sgmlDeclaration = "";
						continue;
					}

					if ((this.sgmlDeclaration + char).toUpperCase() === "[CDATA[") {
						this.emitNode("onOpenCdata");
						this.state = State.CDATA;
						this.sgmlDeclaration = "";
						this.cdata = "";
						continue;
					}

					if ((this.sgmlDeclaration + char).toUpperCase() === "DOCTYPE") {
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

					if (isQuote(this.wasm, char)) {
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
						this.hasDoctype = true; // remember we saw one
						continue;
					}

					this.doctype += char;

					if (char === "[") {
						this.state = State.DOCTYPE_DTD;
						continue;
					}

					if (isQuote(this.wasm, char)) {
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

					if (isQuote(this.wasm, char)) {
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

					if (this.doctype && this.hasDoctype !== true) {
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

						if (char && this.options.trackPosition) {
							this.position += 1;

							if (char === "\n") {
								this.line += 1;
								this.column = 0;
								continue;
							}

							this.column += 1;
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

					if (isWhitespace(this.wasm, char)) {
						this.state = State.PROCESSING_INSTRUCTION_BODY;
						continue;
					}

					this.piName += char;
					continue;
				}

				case State.PROCESSING_INSTRUCTION_BODY: {
					if (!this.piBody && isWhitespace(this.wasm, char)) {
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

					if (!isWhitespace(this.wasm, char)) {
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
					if (isWhitespace(this.wasm, char)) {
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

					if (isWhitespace(this.wasm, char)) {
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

					if (isWhitespace(this.wasm, char)) {
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
					if (isWhitespace(this.wasm, char)) {
						continue;
					}

					if (isQuote(this.wasm, char)) {
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
					if (isWhitespace(this.wasm, char)) {
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
					if (!isAttributeEnd(this.wasm, char)) {
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
						if (isWhitespace(this.wasm, char)) {
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

					if (!isWhitespace(this.wasm, char)) {
						this.fail("Invalid tagname in closing tag");
						continue;
					}

					this.state = State.CLOSE_TAG_SAW_WHITE;
					continue;
				}

				case State.CLOSE_TAG_SAW_WHITE: {
					if (isWhitespace(this.wasm, char)) {
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
			this.attributeName = this.applyCaseTransform(this.attributeName);
		}

		if (
			this.attributeList.some(([name]) => name === this.attributeName) ||
			Object.hasOwn(this.tag.attributes, this.attributeName)
		) {
			this.attributeName = "";
			this.attributeValue = "";
			return;
		}

		if (this.options.namespaces) {
			const { localName, prefix } = getQName(
				this.wasm,
				this.attributeName,
				true,
			);

			if (prefix === "xmlns") {
				// namespace binding attribute. push the binding into scope
				if (localName === "xml" && this.attributeValue !== NAMESPACES.xmlns) {
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

		if (!isWhitespace(this.wasm, char)) {
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
			this.tagName = this.applyCaseTransform(this.tagName);
		}

		const closeTo = tagName;

		while (t--) {
			const close = this.tags[t];

			if (close.name === closeTo) {
				break;
			}

			this.fail("Unexpected close tag");
		}

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

			if (this.options.namespaces && tag.ns !== parent.ns) {
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

	private closeText(): void {
		this.textNode = applyTextOptions(this.options, this.textNode);
		if (this.textNode) {
			this.emit("onText", this.textNode);
		}
		this.textNode = "";
	}

	private emit<T extends keyof SAXHandlers>(
		event: T,
		...args: Parameters<NonNullable<SAXHandlers[T]>>
	): void {
		const handler = this.handlers[event];
		if (typeof handler === "function") {
			(handler as Function)(...args);
		}
	}

	private emitNode<T extends keyof SAXHandlers>(
		nodeType: T,
		...args: Parameters<NonNullable<SAXHandlers[T]>>
	): void {
		if (this.textNode) {
			this.closeText();
		}
		this.emit(nodeType, ...args);
	}

	private fail(message: string): this {
		this.closeText();
		const error = new SAXParserError(this.column, this.line, message);
		this.error = error;
		this.emit("onError", error);
		return this;
	}

	private newTag(): void {
		if (!this.options.strict) {
			this.tagName = this.applyCaseTransform(this.tagName);
		}

		const parent = this.tags.at(-1) || this;

		const tag: Tag = {
			name: this.tagName,
			attributes: {},
		};

		this.tag = tag;

		// will be overridden if tag contails an xmlns="foo" or xmlns:foo="bar"
		if (this.options.namespaces) {
			tag.ns = parent.ns;
		}

		this.attributeList.length = 0;
		this.emitNode("onOpenTagStart", {
			...tag,
			attributes: { ...tag.attributes },
		});
	}

	private openTag(selfClosing?: boolean): void {
		if (this.options.namespaces) {
			const tag = this.tag;
			const qName = getQName(this.wasm, this.tagName);

			tag.prefix = qName.prefix;
			tag.localName = qName.localName;
			tag.uri = tag.ns[qName.prefix] ?? "";

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
			// http://www.w3.org/TR/REC-xml-names/#defaulting
			for (const [name, value] of this.attributeList) {
				const qName = getQName(this.wasm, name, true);
				const prefix = qName.prefix;
				const localName = qName.localName;

				let uri = "";

				if (prefix !== "") {
					uri = tag.ns[prefix] ?? "";
				}

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
		const rawEntity = this.entity;

		// Named entities only
		const named =
			this.ENTITIES[rawEntity] ?? this.ENTITIES[rawEntity.toLowerCase()];
		if (named !== undefined) return named;

		// Numeric entities only
		if (rawEntity.startsWith("#")) {
			const bytes = Parser.encoder.encode(rawEntity);

			const ptr = this.wasm.alloc(bytes.length);

			new Uint8Array(this.wasm.memory.buffer, ptr, bytes.length).set(bytes);

			const codePoint = this.wasm.parseEntity(ptr, bytes.length);

			this.wasm.free(ptr, bytes.length);

			// Check Sentinel (0xFFFFFFFF = 4294967295)
			if (codePoint !== 4294967295) {
				return String.fromCodePoint(codePoint);
			}
		}

		this.fail("Invalid character entity");
		return `&${rawEntity};`;
	}

	public reset(): void {
		this.error = null;
		this.tag = null;
		this.tags.length = 0;
		this.attributeList.length = 0;

		this.bufferCheckPosition = MAX_BUFFER_LENGTH;
		this.column = 0;
		this.line = 0;
		this.position = 0;
		this.startTagPosition = 0;

		this.hasDoctype = false;
		this.hasSeenRoot = false;
		this.isEnded = false;
		this.isRootClosed = false;
		this.state = State.BEGIN;

		// Reset namespaces if enabled
		if (this.options.namespaces) {
			this.ns = Object.create(NAMESPACES);
		}

		// Clear all string buffers
		this.attributeName = "";
		this.attributeValue = "";
		this.cdata = "";
		this.char = "";
		this.comment = "";
		this.doctype = "";
		this.entity = "";
		this.piBody = "";
		this.piName = "";
		this.quoteChar = "";
		this.sgmlDeclaration = "";
		this.tagName = "";
		this.textNode = "";

		this.emit("onReady");
	}
}
