import type { AttributeValueType } from "./constants.js";

export interface Attribute {
	/**
	 * The name of the attribute.
	 *
	 * @example
	 * ```
	 * <input name="value">
	 * ```
	 */
	name: string;
	/**
	 * The extracted string value of the attribute.
	 *
	 * @example
	 * ```
	 * <input name="value">
	 * ```
	 */
	value: string;
	valueType: AttributeValueType;
}

export interface ProcessingInstruction {
	/**
	 * The processing instruction target.
	 *
	 * @example
	 * ```xml
	 * <?xml version="1.0"?>
	 *    ^^^
	 * ```
	 */
	target: string;

	/**
	 * The raw instruction data following the target.
	 *
	 * @example
	 * ```xml
	 * <?xml version="1.0" encoding="UTF-8"?>
	 *        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
	 * ```
	 */
	data: string;
}

export interface Tag {
	name: string;
	attributes: Record<string, Attribute>;
	isSelfClosing: boolean;
}

export interface TextNode {
	/**
	 * @example
	 * ```html
	 * <!--`<p>` has the child text node containing "value" -->
	 * <p>value</p>
	 * ```
	 */
	value: string;
	startPosition: number; // Character index in the source where the text node starts
	endPosition: number; // Character index in the source where the text node ends
}

export interface SAXHandlers {
	onAttribute?(attribute: Attribute): void;
	onCdata?(cdata: string): void;
	onCloseCdata?(): void;
	onCloseNamespace?(ns: { prefix: string; uri: string }): void;
	onCloseTag?(name: string): void;
	onComment?(comment: string): void;
	onDoctype?(doctype: string): void;
	onEnd?(): void;
	onError?(error: Error): void;
	onOpenCdata?(): void;
	onOpenNamespace?(ns: { prefix: string; uri: string }): void;
	onOpenTag?(tag: Tag): void;
	onOpenTagStart?(tag: Tag): void;
	onProcessingInstruction?(pi: ProcessingInstruction): void;
	onReady?(): void;
	onScript?(script: string): void;
	onSgmlDeclaration?(declaration: string): void;
	onText?(text: string): void;
}

export type SAXHandlerName = keyof SAXHandlers;

export interface SAXOptions {
	caseTransform?: "preserve" | "lowercase" | "uppercase";
	namespaces?: boolean;
	strict?: boolean;
	strictEntities?: boolean;
	trackPosition?: boolean;
}
