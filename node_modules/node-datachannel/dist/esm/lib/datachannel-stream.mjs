import * as stream from 'stream';

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class DataChannelStream extends stream.Duplex {
  constructor(rawChannel, streamOptions) {
    super({
      allowHalfOpen: false,
      // Default to autoclose on end().
      ...streamOptions,
      objectMode: true
      // Preserve the string/buffer distinction (WebRTC treats them differently)
    });
    __publicField(this, "_rawChannel");
    __publicField(this, "_readActive");
    this._rawChannel = rawChannel;
    this._readActive = true;
    rawChannel.onMessage((msg) => {
      if (!this._readActive) return;
      this._readActive = this.push(msg);
    });
    rawChannel.onClosed(() => {
      this.push(null);
      this.destroy();
    });
    rawChannel.onError((errMsg) => {
      this.destroy(new Error(`DataChannel error: ${errMsg}`));
    });
    if (!rawChannel.isOpen()) {
      this.cork();
      rawChannel.onOpen(() => this.uncork());
    }
  }
  _read() {
    this._readActive = true;
  }
  _write(chunk, _encoding, callback) {
    let sentOk;
    try {
      if (Buffer.isBuffer(chunk)) {
        sentOk = this._rawChannel.sendMessageBinary(chunk);
      } else if (typeof chunk === "string") {
        sentOk = this._rawChannel.sendMessage(chunk);
      } else {
        const typeName = chunk.constructor.name || typeof chunk;
        throw new Error(`Cannot write ${typeName} to DataChannel stream`);
      }
    } catch (err) {
      return callback(err);
    }
    if (sentOk) {
      callback(null);
    } else {
      callback(new Error("Failed to write to DataChannel"));
    }
  }
  _final(callback) {
    if (!this.allowHalfOpen) this.destroy();
    callback(null);
  }
  _destroy(maybeErr, callback) {
    this._rawChannel.close();
    callback(maybeErr);
  }
  get label() {
    return this._rawChannel.getLabel();
  }
  get id() {
    return this._rawChannel.getId();
  }
  get protocol() {
    return this._rawChannel.getProtocol();
  }
}

export { DataChannelStream as default };
//# sourceMappingURL=datachannel-stream.mjs.map
