import { InvalidStateError } from './Exception.mjs';
import { RTCErrorEvent } from './Events.mjs';

var __defProp = Object.defineProperty;
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var _dataChannel, _readyState, _bufferedAmountLowThreshold, _binaryType, _maxPacketLifeTime, _maxRetransmits, _negotiated, _ordered, _id, _label, _protocol, _closeRequested;
class RTCDataChannel extends EventTarget {
  constructor(dataChannel, opts = {}) {
    super();
    __privateAdd(this, _dataChannel);
    __privateAdd(this, _readyState);
    __privateAdd(this, _bufferedAmountLowThreshold);
    __privateAdd(this, _binaryType);
    __privateAdd(this, _maxPacketLifeTime);
    __privateAdd(this, _maxRetransmits);
    __privateAdd(this, _negotiated);
    __privateAdd(this, _ordered);
    __privateAdd(this, _id);
    __privateAdd(this, _label);
    __privateAdd(this, _protocol);
    __privateAdd(this, _closeRequested, false);
    // events
    __publicField(this, "onbufferedamountlow", null);
    __publicField(this, "onclose", null);
    __publicField(this, "onclosing", null);
    __publicField(this, "onerror", null);
    __publicField(this, "onmessage", null);
    __publicField(this, "onopen", null);
    __privateSet(this, _dataChannel, dataChannel);
    __privateSet(this, _binaryType, "arraybuffer");
    __privateSet(this, _readyState, __privateGet(this, _dataChannel).isOpen() ? "open" : "connecting");
    __privateSet(this, _bufferedAmountLowThreshold, 0);
    __privateSet(this, _maxPacketLifeTime, opts.maxPacketLifeTime ?? null);
    __privateSet(this, _maxRetransmits, opts.maxRetransmits ?? null);
    __privateSet(this, _negotiated, opts.negotiated ?? false);
    __privateSet(this, _ordered, opts.ordered ?? true);
    __privateSet(this, _id, __privateGet(this, _dataChannel).getId());
    __privateSet(this, _label, __privateGet(this, _dataChannel).getLabel());
    __privateSet(this, _protocol, __privateGet(this, _dataChannel).getProtocol());
    __privateGet(this, _dataChannel).onOpen(() => {
      __privateSet(this, _readyState, "open");
      this.dispatchEvent(new Event("open", {}));
    });
    __privateGet(this, _dataChannel).onClosed(() => {
      if (!__privateGet(this, _closeRequested)) {
        __privateSet(this, _readyState, "closing");
        this.dispatchEvent(new Event("closing"));
      }
      setImmediate(() => {
        __privateSet(this, _readyState, "closed");
        this.dispatchEvent(new Event("close"));
      });
    });
    __privateGet(this, _dataChannel).onError((msg) => {
      this.dispatchEvent(
        new RTCErrorEvent("error", {
          error: new RTCError(
            {
              errorDetail: "data-channel-failure"
            },
            msg
          )
        })
      );
    });
    __privateGet(this, _dataChannel).onBufferedAmountLow(() => {
      this.dispatchEvent(new Event("bufferedamountlow"));
    });
    __privateGet(this, _dataChannel).onMessage((message) => {
      if (typeof message === "string") {
        this.dispatchEvent(new MessageEvent("message", { data: message }));
        return;
      }
      let data;
      if (message instanceof ArrayBuffer) {
        data = message;
      } else {
        data = message.buffer;
        if (message.byteOffset !== 0 || message.byteLength !== message.buffer.byteLength) {
          data = new ArrayBuffer(message.byteLength);
          new Uint8Array(data, 0, message.byteLength).set(message);
        }
      }
      if (__privateGet(this, _binaryType) === "blob") {
        data = new Blob([data]);
      }
      this.dispatchEvent(new MessageEvent("message", { data }));
    });
    this.addEventListener("message", (e) => {
      if (this.onmessage) this.onmessage(e);
    });
    this.addEventListener("bufferedamountlow", (e) => {
      if (this.onbufferedamountlow) this.onbufferedamountlow(e);
    });
    this.addEventListener("error", (e) => {
      if (this.onerror) this.onerror(e);
    });
    this.addEventListener("close", (e) => {
      if (this.onclose) this.onclose(e);
    });
    this.addEventListener("closing", (e) => {
      if (this.onclosing) this.onclosing(e);
    });
    this.addEventListener("open", (e) => {
      if (this.onopen) this.onopen(e);
    });
  }
  set binaryType(type) {
    if (type !== "blob" && type !== "arraybuffer") {
      throw new DOMException(
        "Failed to set the 'binaryType' property on 'RTCDataChannel': Unknown binary type : " + type,
        "TypeMismatchError"
      );
    }
    __privateSet(this, _binaryType, type);
  }
  get binaryType() {
    return __privateGet(this, _binaryType);
  }
  get bufferedAmount() {
    return __privateGet(this, _dataChannel).bufferedAmount();
  }
  get bufferedAmountLowThreshold() {
    return __privateGet(this, _bufferedAmountLowThreshold);
  }
  set bufferedAmountLowThreshold(value) {
    const number = Number(value) || 0;
    __privateSet(this, _bufferedAmountLowThreshold, number);
    __privateGet(this, _dataChannel).setBufferedAmountLowThreshold(number);
  }
  get id() {
    return __privateGet(this, _id);
  }
  get label() {
    return __privateGet(this, _label);
  }
  get maxPacketLifeTime() {
    return __privateGet(this, _maxPacketLifeTime);
  }
  get maxRetransmits() {
    return __privateGet(this, _maxRetransmits);
  }
  get negotiated() {
    return __privateGet(this, _negotiated);
  }
  get ordered() {
    return __privateGet(this, _ordered);
  }
  get protocol() {
    return __privateGet(this, _protocol);
  }
  get readyState() {
    return __privateGet(this, _readyState);
  }
  send(data) {
    if (__privateGet(this, _readyState) !== "open") {
      throw new InvalidStateError(
        "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'"
      );
    }
    if (typeof data === "string") {
      __privateGet(this, _dataChannel).sendMessage(data);
    } else if (data instanceof Blob) {
      data.arrayBuffer().then((ab) => {
        if (process?.versions?.bun) {
          __privateGet(this, _dataChannel).sendMessageBinary(Buffer.from(ab));
        } else {
          __privateGet(this, _dataChannel).sendMessageBinary(new Uint8Array(ab));
        }
      });
    } else if (data instanceof Uint8Array) {
      __privateGet(this, _dataChannel).sendMessageBinary(data);
    } else {
      if (process?.versions?.bun) {
        __privateGet(this, _dataChannel).sendMessageBinary(Buffer.from(data));
      } else {
        __privateGet(this, _dataChannel).sendMessageBinary(new Uint8Array(data));
      }
    }
  }
  close() {
    __privateSet(this, _closeRequested, true);
    setImmediate(() => {
      __privateGet(this, _dataChannel).close();
    });
  }
}
_dataChannel = new WeakMap();
_readyState = new WeakMap();
_bufferedAmountLowThreshold = new WeakMap();
_binaryType = new WeakMap();
_maxPacketLifeTime = new WeakMap();
_maxRetransmits = new WeakMap();
_negotiated = new WeakMap();
_ordered = new WeakMap();
_id = new WeakMap();
_label = new WeakMap();
_protocol = new WeakMap();
_closeRequested = new WeakMap();

export { RTCDataChannel as default };
//# sourceMappingURL=RTCDataChannel.mjs.map
