'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var __typeError = (msg) => {
  throw TypeError(msg);
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var _expires, _fingerprints;
class RTCCertificate {
  constructor() {
    __privateAdd(this, _expires, 0);
    __privateAdd(this, _fingerprints, []);
    __privateSet(this, _expires, null);
    __privateSet(this, _fingerprints, []);
  }
  get expires() {
    return __privateGet(this, _expires);
  }
  getFingerprints() {
    return __privateGet(this, _fingerprints);
  }
  getAlgorithm() {
    return "";
  }
}
_expires = new WeakMap();
_fingerprints = new WeakMap();

exports.default = RTCCertificate;
//# sourceMappingURL=RTCCertificate.cjs.map
