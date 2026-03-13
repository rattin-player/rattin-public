'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var __typeError = (msg) => {
  throw TypeError(msg);
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var _errorDetail, _receivedAlert, _sctpCauseCode, _sdpLineNumber, _sentAlert, _httpRequestStatusCode;
class RTCError extends DOMException {
  constructor(init, message) {
    super(message, "OperationError");
    __privateAdd(this, _errorDetail);
    __privateAdd(this, _receivedAlert);
    __privateAdd(this, _sctpCauseCode);
    __privateAdd(this, _sdpLineNumber);
    __privateAdd(this, _sentAlert);
    __privateAdd(this, _httpRequestStatusCode);
    if (!init || !init.errorDetail)
      throw new TypeError("Cannot construct RTCError, errorDetail is required");
    if ([
      "data-channel-failure",
      "dtls-failure",
      "fingerprint-failure",
      "hardware-encoder-error",
      "hardware-encoder-not-available",
      "sctp-failure",
      "sdp-syntax-error"
    ].indexOf(init.errorDetail) === -1)
      throw new TypeError("Cannot construct RTCError, errorDetail is invalid");
    __privateSet(this, _errorDetail, init.errorDetail);
    __privateSet(this, _receivedAlert, init.receivedAlert ?? null);
    __privateSet(this, _sctpCauseCode, init.sctpCauseCode ?? null);
    __privateSet(this, _sdpLineNumber, init.sdpLineNumber ?? null);
    __privateSet(this, _sentAlert, init.sentAlert ?? null);
    __privateSet(this, _httpRequestStatusCode, init.httpRequestStatusCode ?? null);
  }
  get errorDetail() {
    return __privateGet(this, _errorDetail);
  }
  set errorDetail(_value) {
    throw new TypeError("Cannot set errorDetail, it is read-only");
  }
  get receivedAlert() {
    return __privateGet(this, _receivedAlert);
  }
  set receivedAlert(_value) {
    throw new TypeError("Cannot set receivedAlert, it is read-only");
  }
  get sctpCauseCode() {
    return __privateGet(this, _sctpCauseCode);
  }
  set sctpCauseCode(_value) {
    throw new TypeError("Cannot set sctpCauseCode, it is read-only");
  }
  get httpRequestStatusCode() {
    return __privateGet(this, _httpRequestStatusCode);
  }
  get sdpLineNumber() {
    return __privateGet(this, _sdpLineNumber);
  }
  set sdpLineNumber(_value) {
    throw new TypeError("Cannot set sdpLineNumber, it is read-only");
  }
  get sentAlert() {
    return __privateGet(this, _sentAlert);
  }
  set sentAlert(_value) {
    throw new TypeError("Cannot set sentAlert, it is read-only");
  }
}
_errorDetail = new WeakMap();
_receivedAlert = new WeakMap();
_sctpCauseCode = new WeakMap();
_sdpLineNumber = new WeakMap();
_sentAlert = new WeakMap();
_httpRequestStatusCode = new WeakMap();

exports.default = RTCError;
//# sourceMappingURL=RTCError.cjs.map
