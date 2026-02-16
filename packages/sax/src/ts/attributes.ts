export class Attributes {
	/**
	 * @returns an array of attributes of the element
	 */
	public get attributes(): Attributes[] {
		if (this.attributes) {
			return attributes as Attributes[];
		}
	}

	public get qualifiedName(): string {
		if (this.qualifiedName) {
			return qualifiedName as string;
		}
	}

	public get value(): string {
		if (this.value) {
			return value as string;
		}
	}
}
