// parser.ts
import {
	AsciiCharCode,
	AttributeValueType,
	BUFFERS,
	MAX_BUFFER_LENGTH,
	NAMESPACES,
	State,
	UnicodeCharCode,
} from "./constants.js";
import {
	HTML_NAMED_CHARACTER_ENTITIES,
	XML_PREDEFINED_ENTITIES,
} from "./entities.js";
import type {
	Attribute,
	ProcessingInstruction,
	SAXHandlers,
	SAXOptions,
	Tag,
} from "./types.js";
import {
	getQName,
	isAttributeEnd,
	isNameChar,
	isNameStartChar,
	isQuote,
	isWhitespace,
} from "./utils.js";

export class Parser {
	public static decoder = new TextDecoder();

	public static defaultOptions: SAXOptions = {
		caseTransform: "preserve",
		namespaces: false,
		strict: false,
		strictEntities: false,
		trackPosition: false,
	};

	public error: Error | null = null;
	public handlers: SAXHandlers;
	public options: SAXOptions;

	// List implemented as an array of Attribute objects
	private attributeList: Attribute[] = [];
	// Stack implemented as an array of Tag objects
	private tagStack: Tag[] = [];

	// Position tracking
	private column = 0;
	private line = 0;
	private position = 0;
	private startTagPosition = 0;

	private bufferCheckPosition = MAX_BUFFER_LENGTH;
	private applyCaseTransform: (name: string) => string = (name) => name;
	private entities: Record<string, string>;
	private ns: Record<string, string>;

	// Parser state
	private state = State.BEGIN;
	private braceDepth = 0;
	private hasDoctype = false;
	private hasSeenRoot = false;
	private isEnded = false;
	private isRootClosed = false;

	// Buffers
	private attribute: Attribute = {
		name: "",
		value: "",
		valueType: AttributeValueType.NoValue,
	};
	private cdata = "";
	private char = "";
	private comment = "";
	private doctype = "";
	private entity = "";
	private pi: ProcessingInstruction = {
		target: "",
		data: "",
	};
	private quote = 0;
	private sgmlDeclaration = "";
	private script = "";
	private tag: Tag = {
		name: "",
		attributes: {},
		isSelfClosing: false,
	};
	private textNode = "";

	constructor(options: SAXOptions = {}, handlers: SAXHandlers = {}) {
		this.options = { ...Parser.defaultOptions, ...options };

		if (this.options.caseTransform === "lowercase") {
			this.applyCaseTransform = (string) => string.toLowerCase();
		} else if (this.options.caseTransform === "uppercase") {
			this.applyCaseTransform = (string) => string.toUpperCase();
		}

		if (this.options.strictEntities === true) {
			this.entities = XML_PREDEFINED_ENTITIES;
		} else {
			this.entities = HTML_NAMED_CHARACTER_ENTITIES;
		}

		if (this.options.namespaces === true) {
			this.ns = Object.create(NAMESPACES);
		}

		this.handlers = handlers;

		this.emit("onReady");
	}

	public end(): void {
		if (this.isEnded) {
			return;
		}

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

	/**
	 * Flushes any buffered character data that has not yet been emitted as events.
	 */
	public flush(): void {
		this.closeText();

		if (this.cdata !== "") {
			this.emitNode("onCdata", this.cdata);
			this.cdata = "";
		}

		if (this.script !== "") {
			this.emitNode("onScript", this.script);
			this.script = "";
		}
	}

	public write(chunk: Uint8Array | string): void {
		if (this.error) {
			throw this.error;
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

		while (i < chunk.length) {
			let charCode = chunk.charCodeAt(i);
			const codePoint = chunk.codePointAt(i)!;
			char = chunk.charAt(i++);

			this.char = char;

			this.updatePosition(charCode);

			switch (this.state) {
				/**
				 * The absolute starting point of the parser.
				 * This state is only ever hit for the very first character of the document.
				 */
				case State.BEGIN: {
					this.state = State.BEGIN_WHITESPACE;

					if (charCode === UnicodeCharCode.ByteOrderMark) {
						continue;
					}

					this.beginWhitespace(charCode);
					continue;
				}

				case State.TEXT: {
					if (this.hasSeenRoot && !this.isRootClosed) {
						const startIndex = i - 1;

						while (
							char &&
							charCode !== AsciiCharCode.OpenAngle &&
							charCode !== AsciiCharCode.Ampersand
						) {
							char = chunk.charAt(i++);

							if (char) {
								charCode = chunk.charCodeAt(i - 1);
								this.updatePosition(charCode);
							}
						}

						this.textNode += chunk.substring(startIndex, i - 1);
					}

					if (
						charCode === AsciiCharCode.OpenAngle &&
						!(this.hasSeenRoot && this.isRootClosed && !this.options.strict)
					) {
						this.state = State.OPEN_WAKA;
						this.startTagPosition = this.position;
						continue;
					}

					if (
						!isWhitespace(charCode) &&
						(!this.hasSeenRoot || this.isRootClosed)
					) {
						this.fail("Text data outside of root node.");
					}

					if (charCode === AsciiCharCode.Ampersand) {
						this.state = State.TEXT_ENTITY;
						continue;
					}

					this.textNode += char;
					continue;
				}

				case State.ATTRIBUTE: {
					/**
					 * Skip whitespace while parsing attributes inside a tag.
					 *
					 * @example
					 * Input:
					 *   <div class="box" id="main">
					 *
					 * Character flow:
					 *   ' ' → whitespace → ignored
					 *   'i' → start parsing next attribute (`id`)
					 */
					if (isWhitespace(charCode)) {
						continue;
					}

					/**
					 * Detects the end of an opening tag.
					 *
					 * When `>` is encountered, the current tag declaration is complete.
					 * The tokenizer finalizes the tag by calling `openTag()` and then
					 * continues parsing the document content that follows.
					 *
					 * @example
					 * Input:
					 *   <div>
					 *
					 * Character flow:
					 *   '<' → start tag
					 *   'd','i','v' → read tag name
					 *   '>' → tag complete → `openTag()` called
					 */
					if (charCode === AsciiCharCode.CloseAngle) {
						this.processOpenTag();
						continue;
					}

					/**
					 * Detects the start of a closing tag.
					 *
					 * If a `/` appears immediately after `<`, this indicates a closing tag.
					 *
					 * @example
					 * Input:
					 *   </div>
					 *
					 * Character flow:
					 *   '<' → open tag state
					 *   '/' → OPEN_TAG_SLASH state
					 *   'd','i','v' → read tag name
					 *   '>' → tag closes
					 */
					if (charCode === AsciiCharCode.Slash) {
						this.state = State.OPEN_TAG_SLASH;
						continue;
					}

					// Begin parsing a new attribute name
					if (isNameStartChar(codePoint)) {
						this.newAttribute(char);
						continue; // Jumps to the next character
					}

					this.fail("Invalid attribute name");
					continue;
				}

				/**
				 * @example
				 * ```
				 * ```
				 */
				case State.ATTRIBUTE_NAME: {
					if (charCode === AsciiCharCode.Equals) {
						this.state = State.ATTRIBUTE_VALUE;
						continue;
					}

					/*
					 * The attribute name is complete and no value was provided
					 */
					if (charCode === AsciiCharCode.CloseAngle) {
						// For XML, this is a failure, but for HTML it's a valid boolean attribute.
						this.fail("Attribute without value");
						this.attribute.value = this.attribute.name;
						this.processAttribute();
						this.processOpenTag();
						continue;
					}

					if (isWhitespace(charCode)) {
						this.state = State.ATTRIBUTE_NAME_SAW_WHITESPACE;
						continue;
					}

					if (isNameChar(codePoint)) {
						this.attribute.name += char; // Append the character
						continue; // Jumps to the next character in the while loop
					}

					this.fail("Invalid attribute name");
					continue;
				}

				/**
				 * @example
				 * ```
				 * <input disabled>           // boolean/no-value attribute (value defaults to "")
				 * <div class = "container">  // whitespace before '=' is allowed
				 * <div data-id  ="1">        // multiple spaces tolerated
				 * ```
				 */
				case State.ATTRIBUTE_NAME_SAW_WHITESPACE: {
					if (isWhitespace(charCode)) {
						continue;
					}

					if (charCode === AsciiCharCode.Slash) {
						this.state = State.OPEN_TAG_SLASH;
						continue;
					}

					if (charCode === AsciiCharCode.Equals) {
						this.state = State.ATTRIBUTE_VALUE;
						continue;
					}

					this.fail("Attribute without value");
					this.tag.attributes[this.attribute.name] = "";
					this.attribute.value = "";
					this.emitNode("onAttribute", {
						name: this.attribute.name,
						value: "",
						valueType: AttributeValueType.NoValue,
					});
					this.attribute.name = "";

					if (charCode === AsciiCharCode.CloseAngle) {
						this.processOpenTag();
						continue;
					}

					if (isNameStartChar(codePoint)) {
						this.newAttribute(char);
						continue;
					}

					this.fail("Invalid attribute name");
					this.state = State.ATTRIBUTE;
					continue;
				}

				case State.ATTRIBUTE_VALUE: {
					// Skip whitespace between '=' and the start of the value.
					if (isWhitespace(charCode)) {
						continue;
					}

					if (isQuote(charCode)) {
						this.quote = charCode;
						this.state = State.ATTRIBUTE_VALUE_QUOTED;

						if (charCode === AsciiCharCode.DoubleQuote) {
							this.attribute.valueType = AttributeValueType.DoubleQuoted;
						}

						if (charCode === AsciiCharCode.SingleQuote) {
							this.attribute.valueType = AttributeValueType.SingleQuoted;
						}

						continue;
					}

					/*
					 * ONLY JSX:
					 * `{` starts a JSX expression value (e.g. `onClick={() => ...}`).
					 * We track nested braces with `braceDepth` until the matching `}` is found.
					 */
					if (charCode === AsciiCharCode.OpenBrace) {
						this.state = State.JSX_ATTRIBUTE_EXPRESSION;
						this.braceDepth += 1;
						this.attribute.value += char;
						this.attribute.valueType = AttributeValueType.JSX;
						continue;
					}

					// ONLY HTML:
					// Unquoted attribute values are valid in HTML (e.g. `value=foo`)
					this.state = State.ATTRIBUTE_VALUE_UNQUOTED;
					this.attribute.value = char;
					this.attribute.valueType = AttributeValueType.Unquoted;
					continue;
				}

				case State.ATTRIBUTE_VALUE_QUOTED: {
					if (charCode !== this.quote) {
						if (charCode === AsciiCharCode.Ampersand) {
							this.state = State.ATTRIBUTE_VALUE_ENTITY_QUOTED;
							continue;
						}

						this.attribute.value += char;
						continue;
					}

					// Matching quote encountered:
					// The attribute value is complete.
					// Finalize and emit the attribute.
					this.processAttribute();

					this.quote = 0;
					this.state = State.ATTRIBUTE_VALUE_CLOSED;
					continue;
				}

				// Entered after closing an attribute value (after the quote)
				case State.ATTRIBUTE_VALUE_CLOSED: {
					// Whitespace means we can begin parsing the next attribute
					if (isWhitespace(charCode)) {
						this.state = State.ATTRIBUTE;
						continue;
					}

					if (charCode === AsciiCharCode.CloseAngle) {
						this.processOpenTag();
						continue;
					}

					// Indicates a self closing tag
					if (charCode === AsciiCharCode.Slash) {
						this.state = State.OPEN_TAG_SLASH;
						continue;
					}

					// If another attribute starts immediately, whitespace is missing.
					// Emit an error, but recover by treating this as a new attribute.
					if (isNameStartChar(codePoint)) {
						this.fail(
							"Invalid attribute syntax: missing whitespace between attributes",
						);
						this.newAttribute(char);
						continue;
					}

					this.fail("Invalid attribute name"); // Any other character here is invalid
					continue;
				}

				case State.ATTRIBUTE_VALUE_UNQUOTED: {
					if (!isAttributeEnd(charCode)) {
						if (charCode === AsciiCharCode.Ampersand) {
							this.state = State.ATTRIBUTE_VALUE_ENTITY_UNQUOTED;
							continue;
						}

						this.attribute.value += char;
						continue;
					}

					this.processAttribute();

					if (charCode === AsciiCharCode.Slash) {
						this.state = State.OPEN_TAG_SLASH;
						continue;
					}

					if (charCode === AsciiCharCode.CloseAngle) {
						this.processOpenTag();
						continue;
					}

					// Otherwise it was whitespace; expect another attribute
					this.state = State.ATTRIBUTE;
					continue;
				}

				/**
				 * When parsing begins, it loops through the first characters
				 * of the document, delegating to `beginWhitespace` to consume
				 * empty space until it finds the opening root tag (or an error).
				 */
				case State.BEGIN_WHITESPACE:
					this.beginWhitespace(charCode);
					continue;

				case State.CDATA: {
					const startIndex = i - 1;

					while (char && charCode !== AsciiCharCode.CloseBracket) {
						char = chunk.charAt(i++);

						if (char) {
							charCode = chunk.charCodeAt(i - 1);
							this.updatePosition(charCode);
						}
					}

					this.cdata += chunk.substring(startIndex, i - 1);

					if (charCode === AsciiCharCode.CloseBracket) {
						this.state = State.CDATA_ENDING;
					}

					continue;
				}

				// ONLY FOR XML
				case State.CDATA_ENDING: {
					if (charCode === AsciiCharCode.CloseBracket) {
						this.state = State.CDATA_ENDING_2;
						continue;
					}

					this.cdata += `]${char}`;
					this.state = State.CDATA;
					continue;
				}

				// ONLY FOR XML
				case State.CDATA_ENDING_2: {
					if (charCode === AsciiCharCode.CloseAngle) {
						if (this.cdata) {
							this.emitNode("onCdata", this.cdata);
						}

						this.emitNode("onCloseCdata");

						this.cdata = "";
						this.state = State.TEXT;
						continue;
					}

					if (charCode === AsciiCharCode.CloseBracket) {
						this.cdata += "]";
						continue;
					}

					this.cdata += `]]${char}`;
					this.state = State.CDATA;
					continue;
				}

				case State.CLOSE_TAG: {
					if (!this.tag.name) {
						if (isWhitespace(charCode)) {
							continue;
						}

						if (!isNameStartChar(codePoint)) {
							this.fail("Invalid closing tag name.");
							continue;
						}

						this.tag.name = char;
						continue;
					}

					if (charCode === AsciiCharCode.CloseAngle) {
						this.closeTag();
						continue;
					}

					if (isNameChar(codePoint)) {
						this.tag.name += char;
						continue;
					}

					if (!isWhitespace(charCode)) {
						this.fail("Invalid tagname in closing tag");
						continue;
					}

					this.state = State.CLOSE_TAG_SAW_WHITE;
					continue;
				}

				case State.CLOSE_TAG_SAW_WHITE:
					if (isWhitespace(charCode)) {
						continue;
					}

					if (charCode === AsciiCharCode.CloseAngle) {
						this.closeTag();
						continue;
					}

					this.fail("Invalid characters in closing tag");
					continue;

				/**
				 * @example HTML / XML
				 * ```html
				 * <!-- This is an HTML and XML comment -->
				 * ```
				 */
				case State.COMMENT: {
					this.comment += char;

					if (this.comment.endsWith("-->")) {
						const comment = this.comment.slice(0, -3);

						if (comment) {
							this.emitNode("onComment", comment);
						}

						this.comment = "";

						// ONLY FOR HTML/XML
						if (this.doctype && this.hasDoctype !== true) {
							this.state = State.DOCTYPE_DTD;
							continue;
						}

						this.state = State.TEXT;
						continue;
					}

					continue;
				}

				// ONLY FOR HTML/XML
				case State.DOCTYPE: {
					if (charCode === AsciiCharCode.CloseAngle) {
						this.state = State.TEXT;
						this.emitNode("onDoctype", this.doctype);
						this.hasDoctype = true; // remember we saw one
						continue;
					}

					this.doctype += char;

					if (charCode === AsciiCharCode.OpenBracket) {
						this.state = State.DOCTYPE_DTD;
						continue;
					}

					if (isQuote(charCode)) {
						this.quote = charCode;
						this.state = State.DOCTYPE_QUOTED;
						continue;
					}

					continue;
				}

				// ONLY FOR HTML/XML
				case State.DOCTYPE_DTD:
					if (charCode === AsciiCharCode.CloseBracket) {
						this.doctype += char;
						this.state = State.DOCTYPE;
						continue;
					}

					if (charCode === AsciiCharCode.OpenAngle) {
						this.state = State.OPEN_WAKA;
						this.startTagPosition = this.position;
						continue;
					}

					if (isQuote(charCode)) {
						this.doctype += char;
						this.quote = charCode;
						this.state = State.DOCTYPE_DTD_QUOTED;
						continue;
					}

					this.doctype += char;
					continue;

				case State.DOCTYPE_DTD_QUOTED:
					this.doctype += char;

					if (charCode === this.quote) {
						this.state = State.DOCTYPE_DTD;
						this.quote = 0;
					}

					continue;

				case State.DOCTYPE_QUOTED:
					this.doctype += char;

					if (charCode === this.quote) {
						this.quote = 0;
						this.state = State.DOCTYPE;
					}

					continue;

				/**
				 * JSX attribute expression parsing state.
				 *
				 * In this state, the parser is inside a JSX attribute value that starts with `{`
				 * (e.g. `props={user}` or `onClick={() => doThing()}`), and it will keep consuming
				 * characters until the matching closing `}` is found. Nested braces are supported
				 * via `braceDepth`.
				 *
				 * @example
				 * ```tsx
				 * <User
				 *   id="42"
				 *   onClick={() => {
				 *     if (ready) {
				 *       start();
				 *     }
				 *   }}
				 *   props={{ name: user.name, flags: { admin: user.isAdmin } }}
				 * />
				 * ```
				 */
				case State.JSX_ATTRIBUTE_EXPRESSION: {
					this.attribute.value += char;

					if (charCode === AsciiCharCode.OpenBrace) {
						this.braceDepth += 1;
					}

					if (charCode === AsciiCharCode.CloseBrace) {
						this.braceDepth -= 1;

						if (this.braceDepth === 0) {
							this.processAttribute();
							this.state = State.ATTRIBUTE_VALUE_CLOSED;
						}

						continue;
					}

					continue;
				}

				case State.OPEN_TAG: {
					if (isNameChar(codePoint)) {
						this.tag.name += char;
						continue;
					}

					if (charCode === AsciiCharCode.CloseAngle) {
						this.processOpenTag();
						continue;
					}

					if (charCode === AsciiCharCode.Slash) {
						this.state = State.OPEN_TAG_SLASH;
					}

					if (!isWhitespace(charCode)) {
						this.fail("Invalid character in tag name");
					}

					this.state = State.ATTRIBUTE;
					continue;
				}

				case State.OPEN_TAG_SLASH: {
					if (charCode === AsciiCharCode.CloseAngle) {
						this.processOpenTag(true);
						this.closeTag();
						continue;
					}

					this.fail("Forward-slash in opening tag not followed by >");
					this.state = State.ATTRIBUTE;
					continue;
				}

				case State.OPEN_WAKA:
					if (isWhitespace(charCode)) {
						continue;
					}

					// either a /, ?, !, or text is coming next.
					if (charCode === AsciiCharCode.Bang) {
						this.state = State.SGML_DECLARATION;
						this.sgmlDeclaration = "";
						continue;
					}

					if (isNameStartChar(codePoint)) {
						this.newTag(char);
						continue;
					}

					// We just parsed `<` and the very next character is `/`.
					//
					// - In HTML, XML, and JSX: This is the universal standard for
					//   starting a closing tag (e.g., `</div>`).
					if (charCode === AsciiCharCode.Slash) {
						this.newTag("", true);
						continue;
					}

					if (charCode === AsciiCharCode.QuestionMark) {
						this.state = State.PROCESSING_INSTRUCTION;
						this.resetProcessingInstruction();
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

				case State.PROCESSING_INSTRUCTION: {
					if (charCode === AsciiCharCode.QuestionMark) {
						this.state = State.PROCESSING_INSTRUCTION_ENDING;
					} else if (isWhitespace(charCode)) {
						this.state = State.PROCESSING_INSTRUCTION_DATA;
					} else {
						this.pi.target += char;
					}
					continue;
				}

				case State.PROCESSING_INSTRUCTION_DATA: {
					if (!this.pi.data && isWhitespace(charCode)) {
						continue;
					} else if (charCode === AsciiCharCode.QuestionMark) {
						this.state = State.PROCESSING_INSTRUCTION_ENDING;
					} else {
						this.pi.data += char;
					}
					continue;
				}

				case State.PROCESSING_INSTRUCTION_ENDING: {
					if (charCode === AsciiCharCode.CloseAngle) {
						this.emitNode("onProcessingInstruction", {
							target: this.pi.target,
							data: this.pi.data,
						});
						this.resetProcessingInstruction();
						this.state = State.TEXT;
					} else {
						this.pi.data += `?${char}`;
						this.state = State.PROCESSING_INSTRUCTION_DATA;
					}
					continue;
				}

				case State.SGML_DECLARATION: {
					const sequence = this.sgmlDeclaration + char;
					const upperSequence = sequence.toUpperCase();

					if (sequence === "--") {
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

					if (upperSequence === "[CDATA[") {
						this.emitNode("onOpenCdata");
						this.state = State.CDATA;
						this.sgmlDeclaration = "";
						this.cdata = "";
						continue;
					}

					if (upperSequence === "DOCTYPE") {
						this.state = State.DOCTYPE;

						if (this.doctype || this.hasSeenRoot) {
							this.fail("Inappropriately located doctype declaration");
						}

						this.doctype = "";
						this.sgmlDeclaration = "";
						continue;
					}

					if (charCode === AsciiCharCode.CloseAngle) {
						this.emitNode("onSgmlDeclaration", this.sgmlDeclaration);
						this.sgmlDeclaration = "";
						this.state = State.TEXT;
						continue;
					}

					if (isQuote(charCode)) {
						this.quote = charCode;
						this.sgmlDeclaration += char;
						this.state = State.SGML_DECLARATION_QUOTED;
						continue;
					}

					this.sgmlDeclaration += char;
					continue;
				}

				case State.SGML_DECLARATION_QUOTED:
					if (charCode === this.quote) {
						this.state = State.SGML_DECLARATION;
						this.quote = 0;
					}

					this.sgmlDeclaration += char;
					continue;

				case State.ATTRIBUTE_VALUE_ENTITY_QUOTED:
				case State.ATTRIBUTE_VALUE_ENTITY_UNQUOTED:
				case State.TEXT_ENTITY: {
					let returnState: State;
					let buffer: (typeof BUFFERS)[number];

					switch (this.state) {
						case State.TEXT_ENTITY: {
							returnState = State.TEXT;
							buffer = "textNode";
							break;
						}

						case State.ATTRIBUTE_VALUE_ENTITY_QUOTED: {
							returnState = State.ATTRIBUTE_VALUE_QUOTED;
							buffer = "attributeValue";
							break;
						}

						case State.ATTRIBUTE_VALUE_ENTITY_UNQUOTED: {
							returnState = State.ATTRIBUTE_VALUE_UNQUOTED;
							buffer = "attributeValue";
							break;
						}
					}

					if (charCode === AsciiCharCode.Semicolon) {
						this[buffer] += this.parseEntity();
						this.entity = "";
						this.state = returnState;
						continue;
					}

					// If we have already started building an entity name
					if (this.entity.length > 0) {
						if (charCode === AsciiCharCode.Hash || isNameChar(codePoint)) {
							this.entity += char;
							continue; // Move to next input character
						}
					} else {
						if (charCode === AsciiCharCode.Hash || isNameStartChar(codePoint)) {
							this.entity += char;
							continue; // Move to next input character
						}
					}

					this.fail("Invalid character in entity name");

					this[buffer] += `&${this.entity}${char}`;
					this.entity = "";
					this.state = returnState;
					continue;
				}

				default:
					throw new Error(`Unknown state: ${this.state}`);
			}
		} // End of the while loop

		if (this.position >= this.bufferCheckPosition) {
			this.checkBufferLength();
		}
	}

	/**
	 * Processes characters before the first tag of the document.
	 * Safely ignores leading spaces, tabs, and newlines.
	 *
	 * @param char The current character being evaluated.
	 */
	private beginWhitespace(charCode: number): void {
		// Scenario 1: We found the opening bracket! The document officially begins here.
		// Shift state to start parsing the tag and mark our starting position.
		if (charCode === AsciiCharCode.OpenAngle) {
			this.state = State.OPEN_WAKA;
			this.startTagPosition = this.position;
			return;
		}

		// Scenario 2: We found a normal character (like a letter) before any tags.
		// This is invalid document structure. We emit an error to notify the user,
		// but gracefully recover by buffering it into a text node so the parser doesn't crash.
		if (!isWhitespace(charCode)) {
			this.fail("Non-whitespace before first tag.");
			this.textNode = this.char;
			this.state = State.TEXT;
		}
	}

	private checkBufferLength(): void {
		const threshold = Math.max(MAX_BUFFER_LENGTH, 10);
		let maxActual = 0;

		for (const buffer of BUFFERS) {
			const len = this[buffer].length;

			if (len > threshold) {
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

					case "script": {
						this.emitNode("onScript", this.script);
						this.script = "";
						break;
					}

					default: {
						this.fail(`Max buffer length exceeded: ${buffer}`);
					}
				}
			}

			maxActual = Math.max(maxActual, len);
		}

		// 2. Check nested object buffers
		const nestedBuffers = [
			{ name: "attribute.name", len: this.attribute.name.length },
			{ name: "attribute.value", len: this.attribute.value.length },
			{ name: "pi.data", len: this.pi.data.length },
			{ name: "pi.target", len: this.pi.target.length },
			{ name: "tag.name", len: this.tag.name.length },
		];

		for (const { name, len } of nestedBuffers) {
			if (len > threshold) {
				this.fail(`Max buffer length exceeded: ${name}`);
			}
			maxActual = Math.max(maxActual, len);
		}

		this.bufferCheckPosition = MAX_BUFFER_LENGTH - maxActual + this.position;
	}

	private closeTag(): void {
		if (!this.tag.name) {
			this.fail("Weird empty close tag.");
			this.textNode += "</>";
			this.state = State.TEXT;
			return;
		}
		// first make sure that the closing tag actually exists.
		// <a><b></c></b></a> will close everything, otherwise.
		let t = this.tagStack.length;
		let tagName = this.tag.name;

		if (!this.options.strict) {
			tagName = this.applyCaseTransform(tagName);
		}

		const closeTo = tagName;

		while (t--) {
			const close = this.tagStack[t];

			if (close.name === closeTo) {
				this.fail("Unexpected close tag");
			} else {
				break;
			}
		}

		if (t < 0) {
			this.fail(`Unmatched closing tag: ${this.tag.name}`);
			this.textNode += `</${this.tag.name}>`;
			this.state = State.TEXT;
			return;
		}

		this.tag.name = tagName;

		let popIndex = this.tagStack.length;
		while (popIndex-- > t) {
			const tag = this.tagStack.pop();
			this.tag = tag;
			this.tag.name = tag.name;
			this.emitNode("onCloseTag", this.tag.name);
			const parent = this.tagStack.at(-1) || this;

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

		this.resetAttribute();
		this.attributeList.length = 0;
		this.state = State.TEXT;
	}

	private closeText(): void {
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

	private fail(message: string): void {
		this.closeText();
		if (this.options.trackPosition) {
			message += `\nLine: ${this.line}
\nColumn: ${this.column}
\nChar: ${this.char}`;
		}
		const err = new Error(message);
		this.error = err;
		this.emit("onError", err);
	}

	private processOpenTag(selfClosing = false): void {
		if (this.options.namespaces) {
			const tag = this.tag;
			const qName = getQName(this.tag.name);

			tag.prefix = qName.prefix;
			tag.localName = qName.localName;
			tag.uri = tag.ns[qName.prefix] ?? "";

			if (tag.prefix && !tag.uri) {
				this.fail(`Unbound namespace prefix: ${JSON.stringify(this.tag.name)}`);
				tag.uri = qName.prefix;
			}

			const parent = this.tagStack.at(-1) || this;

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
			for (const { name, value, valueType } of this.attributeList) {
				const qName = getQName(name, true);
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
		this.tagStack.push(this.tag);

		this.emitNode("onOpenTag", this.tag);

		// Not self-closing (false): e.g., <div id="app">. This means the tag has "inside" content (children or text) that we need to parse next.
		// Self-closing (true): e.g., <img src="cat.jpg" />. This tag is immediately done; there is no "inside" content.
		if (!selfClosing) {
			this.state = State.TEXT;
			this.resetTag();
		}

		this.resetAttribute();
		this.attributeList.length = 0;
	}

	private parseEntity(): string {
		const entity = this.entity;
		let lowerCaseEntity = entity.toLowerCase();
		let number = NaN;
		let numStr = "";

		// -- Handles named entities

		if (this.entities[entity]) {
			return this.entities[entity];
		}

		if (this.entities[lowerCaseEntity]) {
			return this.entities[lowerCaseEntity];
		}

		// -- Handles numeric entities

		if (lowerCaseEntity.charCodeAt(0) === AsciiCharCode.Hash) {
			if (lowerCaseEntity.charCodeAt(1) === 0x78) {
				lowerCaseEntity = lowerCaseEntity.slice(2);
				number = parseInt(lowerCaseEntity, 16);
				numStr = number.toString(16);
			} else {
				lowerCaseEntity = lowerCaseEntity.slice(1);
				number = parseInt(lowerCaseEntity, 10);
				numStr = number.toString(10);
			}
		}

		let i = 0;

		while (
			i < lowerCaseEntity.length &&
			lowerCaseEntity.charCodeAt(i) === 0x30
		) {
			i++;
		}

		lowerCaseEntity = lowerCaseEntity.slice(i);

		if (
			Number.isNaN(number) ||
			numStr.toLowerCase() !== lowerCaseEntity ||
			number < 0 ||
			number > 0x10ffff
		) {
			this.fail("Invalid character entity");
			return `&${this.entity};`;
		}

		return String.fromCodePoint(number);
	}

	private processAttribute(): void {
		if (!this.options.strict) {
			this.attribute.name = this.applyCaseTransform(this.attribute.name);
		}

		if (
			this.attributeList.some(
				(attribute) => attribute.name === this.attribute.name,
			) ||
			Object.hasOwn(this.tag.attributes, this.attribute.name)
		) {
			this.resetAttribute();
			return;
		}

		if (this.options.namespaces) {
			const { localName, prefix } = getQName(this.attribute.name, true);

			if (prefix === "xmlns") {
				// namespace binding attribute. push the binding into scope
				if (localName === "xml" && this.attribute.value !== NAMESPACES.xml) {
					this.fail(
						`xml: prefix must be bound to ${NAMESPACES.xml}\nActual: ${this.attribute.value}`,
					);
				} else if (
					localName === "xmlns" &&
					this.attribute.value !== NAMESPACES.xmlns
				) {
					this.fail(
						`xmlns: prefix must be bound to ${NAMESPACES.xml}\nActual: ${this.attribute.value}`,
					);
				} else {
					const tag = this.tag;
					const parent = this.tagStack[this.tagStack.length - 1] || this;

					if (tag.ns === parent.ns) {
						tag.ns = Object.create(parent.ns);
					}

					tag.ns[localName] = this.attribute.value;
				}
			}

			// defer onattribute events until all attributes have been seen/
			// so any new bindings can take effect. preserve attribute order
			// so deferred events can be emitted in document order
			this.attributeList.push({
				name: this.attribute.name,
				value: this.attribute.value,
				valueType: this.attribute.valueType,
			});
		} else {
			// in non-xmlns mode, we can emit the event right away
			this.tag.attributes[this.attribute.name] = this.attribute.value;
			this.emitNode("onAttribute", {
				name: this.attribute.name,
				value: this.attribute.value,
				valueType: this.attribute.valueType,
			});
		}

		this.resetAttribute();
	}
	/**
	 * Initializes a new attribute and transitions the parser to `ATTRIBUTE_NAME`.
	 *
	 * Called when a valid name-start character is encountered inside a tag.
	 * This method:
	 * - Seeds the attribute name with its first character
	 * - Clears any previous attribute value buffer
	 * - Defaults the value type to `NoValue` (boolean attribute)
	 *
	 * @param char - The first character of the attribute name (must satisfy `isNameStartChar`).
	 *
	 * @example
	 * ``` js
	 * // Parsing:
	 * // <input disabled>
	 * //         ^
	 * // When 'd' is encountered:
	 * newAttribute("d");
	 * ```
	 * @example
	 * ``` js
	 * // Parsing:
	 * // <div class="container">
	 * //      ^
	 * // When 'c' is encountered:
	 * newAttribute("c");
	 * ```
	 */
	private newAttribute(char: string): void {
		this.attribute = {
			name: char,
			value: "",
			valueType: AttributeValueType.NoValue,
		};

		this.state = State.ATTRIBUTE_NAME;
	}

	private newTag(char: string, isCloseTag: boolean = false): void {
		this.tag = {
			name: char,
			attributes: {},
			isSelfClosing: false,
		};

		if (isCloseTag) {
			this.state = State.CLOSE_TAG;
		} else {
			this.state = State.OPEN_TAG;
		}
	}

	private resetAttribute(): void {
		this.attribute = {
			name: "",
			value: "",
			valueType: AttributeValueType.NoValue,
		};
	}

	private resetProcessingInstruction(): void {
		this.pi = {
			target: "",
			data: "",
		};
	}

	private resetTag(): void {
		this.tag.name = "";
		this.tag.attributes = {};
		this.tag.isSelfClosing = false;
	}

	public reset(): void {
		this.error = null;
		this.tagStack.length = 0;
		this.attributeList.length = 0;

		this.bufferCheckPosition = MAX_BUFFER_LENGTH;
		this.column = 0;
		this.line = 0;
		this.position = 0;
		this.startTagPosition = 0;
		this.braceDepth = 0;

		this.hasDoctype = false;
		this.hasSeenRoot = false;
		this.isEnded = false;
		this.isRootClosed = false;
		this.state = State.BEGIN;
		// Reset namespaces if enabled
		if (this.options.namespaces) {
			this.ns = Object.create(NAMESPACES);
		}
		// Clear all buffers
		this.resetAttribute();
		this.cdata = "";
		this.char = "";
		this.comment = "";
		this.doctype = "";
		this.entity = "";
		this.resetProcessingInstruction();
		this.quote = 0;
		this.sgmlDeclaration = "";
		this.resetTag();
		this.textNode = "";

		this.emit("onReady");
	}

	private updatePosition(charCode: number): void {
		if (!this.options.trackPosition) {
			return;
		}

		this.position += 1;

		if (charCode === AsciiCharCode.LineFeed) {
			this.line += 1;
			this.column = 0;
			return;
		}

		this.column += 1;
	}
}
