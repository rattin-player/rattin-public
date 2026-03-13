'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var RTCIceTransport = require('./RTCIceTransport.cjs');

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
var _pc, _iceTransport;
class RTCDtlsTransport extends EventTarget {
  constructor(init) {
    super();
    __privateAdd(this, _pc, null);
    __privateAdd(this, _iceTransport, null);
    __publicField(this, "onstatechange", null);
    __publicField(this, "onerror", null);
    __privateSet(this, _pc, init.pc);
    __privateSet(this, _iceTransport, new RTCIceTransport.default({
      pc: init.pc
    }));
    __privateGet(this, _pc).addEventListener("connectionstatechange", () => {
      const e = new Event("statechange");
      this.dispatchEvent(e);
      this.onstatechange?.(e);
    });
  }
  get iceTransport() {
    return __privateGet(this, _iceTransport);
  }
  get state() {
    let state = __privateGet(this, _pc) ? __privateGet(this, _pc).connectionState : "new";
    if (state === "disconnected") {
      state = "closed";
    }
    return state;
  }
  getRemoteCertificates() {
    return [new ArrayBuffer(0)];
  }
}
_pc = new WeakMap();
_iceTransport = new WeakMap();

exports.default = RTCDtlsTransport;
//# sourceMappingURL=RTCDtlsTransport.cjs.map
