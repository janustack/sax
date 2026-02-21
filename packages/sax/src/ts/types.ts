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
	getQName(ptr: number, len: number, isAttribute: number): number;
	parseEntity(ptr: number, len: number): number;
	memory: WebAssembly.Memory;
	alloc(len: number): number;
	free(ptr: number, len: number): void;
};

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
	onOpenTag?(tag: unknown): void;
	onOpenTagStart?(tag: unknown): void;
	onProcessingInstruction?(data: { name: string; body: string }): void;
	onReady?(): void;
	onScript?(script: string): void;
	onSgmlDeclaration?(declaration: string): void;
	onText?(text: string): void;
}

export type SAXHandlerName = keyof SAXHandlers;

export interface SAXOptions {
	caseTransform?: "preserve" | "lowercase" | "uppercase";
	namespaces?: boolean;
	normalize?: boolean;
	strict?: boolean;
	strictEntities?: boolean;
	trackPosition?: boolean;
	trim?: boolean;
}
