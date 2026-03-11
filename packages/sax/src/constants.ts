// constants.ts

/**
 * Describes how an attribute appears syntactically in markup.
 */
export enum AttributeValueType {
	/**
	 * Attribute value wrapped in double quotes.
	 *
	 * @example
	 * <input value="hello" />
	 */
	DoubleQuoted,

	/**
	 * JSX-style attribute expression.
	 *
	 * @example
	 * <Component prop={someExpression} />
	 */
	JSX,

	/**
	 * Attribute without an explicit value (boolean attribute).
	 *
	 * @example
	 * <input disabled />
	 */
	NoValue,

	/**
	 * Attribute value wrapped in single quotes.
	 *
	 * @example
	 * <input value='hello' />
	 */
	SingleQuoted,

	/**
	 * Attribute value without quotes.
	 *
	 * @example
	 * <input value=hello />
	 */
	Unquoted,
}

export const BUFFERS = [
	"cdata",
	"comment",
	"doctype",
	"entity",
	"sgmlDeclaration",
	"script",
	"textNode",
] as const;

export const AsciiCharCode = {
	Ampersand: 0x26, // &
	Bang: 0x21, // !
	CarriageReturn: 0x0d,
	Colon: 0x3a, // :
	CloseAngle: 0x3e, // >
	CloseBrace: 0x7d, // }
	CloseBracket: 0x5d, // ]
	Dash: 0x2d, // -
	FullStop: 0x2e, // .
	DoubleQuote: 0x22, // "
	Equals: 0x3d, // =
	Hash: 0x23, // #
	HorizontalTab: 0x09,
	LineFeed: 0x0a,
	OpenAngle: 0x3c, // <
	OpenBrace: 0x7b, // {
	OpenBracket: 0x5b, // [
	QuestionMark: 0x3f, // ?
	Semicolon: 0x3b, // ;
	SingleQuote: 0x27, // '
	Slash: 0x2f, // /
	Space: 0x20,
	Underscore: 0x5f, // _
} as const;

export const UnicodeCharCode = {
	ByteOrderMark: 0xfeff,
	MiddleDot: 0x00b7, // ·
} as const;

export const MAX_BUFFER_LENGTH = 64 * 1024;

export const NAMESPACES = {
	xml: "http://www.w3.org/XML/1998/namespace",
	xmlns: "http://www.w3.org/2000/xmlns/",
} as const;

export enum State {
	ATTRIBUTE,
	ATTRIBUTE_NAME,
	ATTRIBUTE_NAME_SAW_WHITESPACE,
	ATTRIBUTE_VALUE,
	ATTRIBUTE_VALUE_CLOSED,
	ATTRIBUTE_VALUE_ENTITY_QUOTED,
	ATTRIBUTE_VALUE_ENTITY_UNQUOTED,
	ATTRIBUTE_VALUE_QUOTED,
	ATTRIBUTE_VALUE_UNQUOTED,
	BEGIN,
	BEGIN_WHITESPACE,
	CDATA,
	CDATA_ENDING,
	CDATA_ENDING_2,
	CLOSE_TAG,
	CLOSE_TAG_SAW_WHITE,
	COMMENT,
	DOCTYPE,
	DOCTYPE_DTD,
	DOCTYPE_DTD_QUOTED,
	DOCTYPE_QUOTED,
	JSX_ATTRIBUTE_EXPRESSION,
	JSX_EXPRESSION_CHILD,
	OPEN_TAG,
	OPEN_TAG_SLASH,
	OPEN_WAKA,
	PROCESSING_INSTRUCTION,
	PROCESSING_INSTRUCTION_DATA,
	PROCESSING_INSTRUCTION_ENDING,
	SCRIPT,
	SGML_DECLARATION,
	SGML_DECLARATION_QUOTED,
	TEXT,
	TEXT_ENTITY,
}
