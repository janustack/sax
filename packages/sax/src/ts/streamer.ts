import { Stream } from "node:stream";
import { EVENTS } from "./constants.js";
import { Parser } from "./parser.js";
import type { SAXOptions } from "./types";

const streamWraps = EVENTS.filter(
	(event) => event !== "error" && event !== "end",
);

export class Streamer extends Stream {
	public readable: boolean = true;
	public writeable: boolean = true;

	private decoder: TextDecoder | null = null;
	private parser: Parser;

	constructor(options: SAXOptions = {}) {
		super();

		this.readable = true;
		this.writeable = true;
		this.decoder = null;

		this.parser = new Parser(options);

		this.parser.handlers.onEnd = () => {
			this.emit("end");
		};

		this.parser.handlers.onError = (error) => {
			this.emit("error", error);
			this.parser.error = null;
		};

		for (const event of streamWraps) {
			Object.defineProperty(this, `on${event}`, {
				get() {
					return this._parser[`on${event}`];
				},
				set(handler) {
					if (!handler) {
						this.removeAllListeners(event);
						this._parser[`on${event}`] = handler;
						return;
					}
					this.on(event, handler);
				},
				enumerable: true,
				configurable: false,
			});
		}
	}

	public end(chunk): boolean {
		if (chunk?.length) {
			this.write(chunk);
		}

		if (this.decoder) {
			const remaining = this.decoder.decode();
			if (remaining) {
				this.parser.write(remaining);
				this.emit("data", remaining);
			}
		}

		this._parser.end();
		return true;
	}

	public override on(event: string, handler: (...args: any[]) => void): this {
		const key = `on${event}`;

		if (!this.parser[key] && streamWraps.includes(event)) {
			this.parser[key] = (...args: any[]) => {
				this.emit(event, ...args);
			};
		}

		return super.on(event, handler);
	}

	public write(chunk: Buffer | string): boolean {
		if (
			typeof Buffer === "function" &&
			typeof Buffer.isBuffer === "function" &&
			Buffer.isBuffer(chunk)
		) {
			if (!this.decoder) {
				this.decoder = new TextDecoder("utf8");
			}

			chunk = this.decoder.decode(chunk, { stream: true });
		}

		this.parser.write(chunk.toString());
		this.emit("data", chunk);
		return true;
	}
}
