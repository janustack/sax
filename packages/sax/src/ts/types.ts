export interface Attribute {
	qualifiedName: QualifiedName;
	value: string;
}

export interface Element {
	qualifiedName: QualifiedName;
	attributes: Record<string, string>;
	isSelfClosing?: boolean;
}

export interface QualifiedName {
	prefix?: string;
	localName: string;
	uri: string;
}

export interface ProcessingInstruction {
	target: string;
	data: string;
}

export interface Position {
	column: number;
	line: number;
}

export type WasmExports = {
	isAttributeEnd(byte: number): boolean;
	isQuote(byte: number): boolean;
	isWhitespace(byte: number): boolean;
	memory: WebAssembly.Memory;
};

export interface SAXHandlers {
	onAttribute?(attribute: any): void;
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
	onOpenTag?(tag: any): void;
	onOpenTagStart?(tag: any): void;
	onProcessingInstruction?(data: { name: string; body: string }): void;
	onReady?(): void;
	onScript?(script: string): void;
	onSgmlDeclaration?(declaration: string): void;
	onText?(text: string): void;
}

export interface SAXOptions {
	lowercase?: boolean;
	normalize?: boolean;
	position?: boolean;
	strict?: boolean;
	trim?: boolean;
	xmlns?: boolean;
	trackPosition?: boolean;
	strictEntities?: boolean;
}
