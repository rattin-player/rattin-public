import * as stream from 'stream';

/**
 * Turns a node-datachannel DataChannel into a real Node.js stream, complete with buffering,
 * backpressure (up to a point - if the buffer fills up, messages are dropped), and
 * support for piping data elsewhere.
 *
 * Read & written data may be either UTF-8 strings or Buffers - this difference exists at
 * the protocol level, and is preserved here throughout.
 */
declare class DataChannelStream extends stream.Duplex {
    private _rawChannel;
    private _readActive;
    constructor(rawChannel: any, streamOptions?: Omit<stream.DuplexOptions, 'objectMode'>);
    _read(): void;
    _write(chunk: any, _encoding: any, callback: any): void;
    _final(callback: any): void;
    _destroy(maybeErr: any, callback: any): void;
    get label(): string;
    get id(): number;
    get protocol(): string;
}

export { DataChannelStream as default };
