// lib/nm_io.ts - Chrome/Edge Native Messaging framing for Deno.
//
// Wire format (both directions): uint32 little-endian byte length, then that
// many bytes of UTF-8 JSON. No delimiters, no text-mode translation.
//
// Limits enforced by Chromium (native_message_process_host.cc):
//   host -> browser: kMaximumNativeMessageSize = 1024*1024 bytes. A larger
//                    header makes Chrome close the port ("Error when
//                    communicating with the native messaging host").
//   browser -> host: no hard cap in that file. We reject absurd headers to
//                    avoid allocating gigabytes on a desynchronised stream.

export const MAX_FROM_HOST = 1024 * 1024;
export const MAX_TO_HOST = 64 * 1024 * 1024;

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

interface Reader {
  read(p: Uint8Array): Promise<number | null>;
}
interface Writer {
  write(p: Uint8Array): Promise<number>;
}

const SMALL = 64 * 1024;

/**
 * Reads length-prefixed frames. Correct for any chunking: partial headers,
 * partial bodies, many frames in one read, frames bigger than the buffer.
 */
export class FrameReader {
  #r: Reader;
  #buf: Uint8Array<ArrayBuffer> = new Uint8Array(SMALL);
  #start = 0;
  #end = 0;
  readonly maxLen: number;

  constructor(r: Reader = Deno.stdin, maxLen = MAX_TO_HOST) {
    this.#r = r;
    this.maxLen = maxLen;
  }

  /** Make room so that `n` bytes starting at #start fit in the buffer. */
  #reserve(n: number) {
    if (this.#buf.length - this.#start >= n) return;
    const live = this.#buf.subarray(this.#start, this.#end);
    if (this.#buf.length >= n) {
      this.#buf.copyWithin(0, this.#start, this.#end);
    } else {
      const nb = new Uint8Array(Math.max(n, this.#buf.length * 2));
      nb.set(live);
      this.#buf = nb;
    }
    this.#end -= this.#start;
    this.#start = 0;
  }

  /** One read() call. Returns false on EOF. */
  async #fill(): Promise<boolean> {
    if (this.#end === this.#buf.length) this.#reserve(this.#end - this.#start + SMALL);
    let n: number | null;
    try {
      n = await this.#r.read(this.#buf.subarray(this.#end));
    } catch (e) {
      // A writer that vanished (ERROR_BROKEN_PIPE) is EOF for our purposes.
      if (e instanceof Deno.errors.BrokenPipe || e instanceof Deno.errors.UnexpectedEof) return false;
      throw e;
    }
    if (n === null || n === 0) return false;
    this.#end += n;
    return true;
  }

  /**
   * Next frame body (a copy), or null on a clean EOF between frames.
   * Throws ProtocolError on EOF inside a frame or an oversized header.
   */
  async next(): Promise<Uint8Array<ArrayBuffer> | null> {
    this.#reserve(4);
    while (this.#end - this.#start < 4) {
      if (!(await this.#fill())) {
        if (this.#end === this.#start) return null;
        throw new ProtocolError(`EOF inside frame header (${this.#end - this.#start}/4 bytes)`);
      }
    }
    const b = this.#buf;
    const s = this.#start;
    const len = (b[s] | (b[s + 1] << 8) | (b[s + 2] << 16) | (b[s + 3] << 24)) >>> 0;
    if (len > this.maxLen) {
      throw new ProtocolError(`frame header announces ${len} bytes (limit ${this.maxLen}); stream desynchronised?`);
    }
    const need = 4 + len;
    this.#reserve(need);
    while (this.#end - this.#start < need) {
      if (!(await this.#fill())) {
        throw new ProtocolError(`EOF inside frame body (${this.#end - this.#start - 4}/${len} bytes)`);
      }
    }
    const body = this.#buf.slice(this.#start + 4, this.#start + need);
    this.#start += need;
    if (this.#start === this.#end) {
      this.#start = this.#end = 0;
      // Give back memory after a big message so the idle host stays small.
      if (this.#buf.length > 4 * SMALL) this.#buf = new Uint8Array(SMALL);
    }
    return body;
  }
}

async function writeAll(w: Writer, data: Uint8Array) {
  let off = 0;
  while (off < data.length) {
    const n = await w.write(data.subarray(off));
    if (!(n > 0)) throw new ProtocolError(`write() returned ${n}`);
    off += n;
  }
}

/**
 * Writes frames. Each frame (header+body) is written with a write-all loop and
 * frames are strictly serialised through a promise chain, so concurrent
 * producers (progress streams, replies) can never interleave bytes.
 */
export class FrameWriter {
  #w: Writer;
  #tail: Promise<void> = Promise.resolve();
  #failed: unknown = null;
  readonly maxLen: number;
  bytesWritten = 0;
  framesWritten = 0;

  constructor(w: Writer = Deno.stdout, maxLen = MAX_FROM_HOST) {
    this.#w = w;
    this.maxLen = maxLen;
  }

  static encode(msg: unknown): Uint8Array {
    // JSON.stringify never emits raw control characters and (ES2019+) escapes
    // lone surrogates, so the body is always valid UTF-8.
    return new TextEncoder().encode(JSON.stringify(msg));
  }

  /** Serialise + send. Rejects (without writing anything) if the body would exceed maxLen. */
  send(msg: unknown): Promise<void> {
    return this.sendRaw(FrameWriter.encode(msg));
  }

  sendRaw(body: Uint8Array): Promise<void> {
    if (this.#failed) return Promise.reject(this.#failed);
    if (body.length > this.maxLen) {
      return Promise.reject(new ProtocolError(`outgoing message is ${body.length} bytes; Chrome accepts at most ${this.maxLen}`));
    }
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length, true);
    frame.set(body, 4);
    const p = this.#tail.then(async () => {
      if (this.#failed) throw this.#failed;
      try {
        await writeAll(this.#w, frame);
        this.bytesWritten += frame.length;
        this.framesWritten++;
      } catch (e) {
        this.#failed = e; // the browser side is gone; everything after this fails fast
        throw e;
      }
    });
    this.#tail = p.catch(() => {});
    return p;
  }

  /** Resolves when everything queued so far has been written (or failed). */
  flush(): Promise<void> {
    return this.#tail;
  }

  get failed(): unknown {
    return this.#failed;
  }
}
