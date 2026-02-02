import { Stream } from "node:stream";
import { EVENTS } from "./constants.js";
import { SAXParser } from "./parser.js";
import type { SAXOptions } from "./types";

const streamWraps = EVENTS.filter(
	(event) => event !== "error" && event !== "end",
);

export class SAXStreamer extends Stream {
	public readable: boolean = true;
	public writeable: boolean = true;

	private _decoder: TextDecoder | null = null;
	private _parser: SAXParser;

	constructor(isStrict: boolean = false, options: SAXOptions = {}) {
		super();

		this.readable = true;
		this.writeable = true;
		this._decoder = null;

		this._parser = new SAXParser(isStrict, options);
		this._parser.onEnd = () => {
			this.emit("end");
		};

		this._parser.onError = (error) => {
			this.emit("error", error);
			this._parser.error = null;
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

		if (this._decoder) {
			const remaining = this._decoder.decode();
			if (remaining) {
				this._parser.write(remaining);
				this.emit("data", remaining);
			}
		}

		this._parser.end();
		return true;
	}

	public override on(event: string, handler: (...args: any[]) => void): this {
		const key = `on${event}`;

		if (!this._parser[key] && streamWraps.includes(event)) {
			this._parser[key] = (...args: any[]) => {
				this.emit(event, ...args);
			};
		}

		return super.on(event, handler);
	}

	public write(data): boolean {
		if (
			typeof Buffer === "function" &&
			typeof Buffer.isBuffer === "function" &&
			Buffer.isBuffer(data)
		) {
			if (!this._decoder) {
				this._decoder = new TextDecoder("utf8");
			}

			data = this._decoder.decode(data, { stream: true });
		}

		this._parser.write(data.toString());
		this.emit("data", data);
		return true;
	}
}
