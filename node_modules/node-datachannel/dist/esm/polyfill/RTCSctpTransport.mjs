import RTCDtlsTransport from './RTCDtlsTransport.mjs';

var __defProp = Object.defineProperty;
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, key + "" , value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var _pc, _transport;
class RTCSctpTransport extends EventTarget {
  constructor(initial) {
    super();
    __privateAdd(this, _pc, null);
    __privateAdd(this, _transport, null);
    __publicField(this, "onstatechange", null);
    __privateSet(this, _pc, initial.pc);
    __privateSet(this, _transport, new RTCDtlsTransport({
      pc: initial.pc
    }));
    __privateGet(this, _pc).addEventListener("connectionstatechange", () => {
      const e = new Event("statechange");
      this.dispatchEvent(e);
      this.onstatechange?.(e);
    });
  }
  get maxChannels() {
    if (this.state !== "connected") return null;
    return __privateGet(this, _pc).ext_maxDataChannelId;
  }
  get maxMessageSize() {
    if (this.state !== "connected") return null;
    return __privateGet(this, _pc)?.ext_maxMessageSize ?? 65536;
  }
  get state() {
    let state = __privateGet(this, _pc).connectionState;
    if (state === "new" || state === "connecting") {
      state = "connecting";
    } else if (state === "disconnected" || state === "failed" || state === "closed") {
      state = "closed";
    }
    return state;
  }
  get transport() {
    return __privateGet(this, _transport);
  }
}
_pc = new WeakMap();
_transport = new WeakMap();

export { RTCSctpTransport as default };
//# sourceMappingURL=RTCSctpTransport.mjs.map
