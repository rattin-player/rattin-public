'use strict';

var RTCDataChannel = require('./RTCDataChannel.cjs');
var RTCError = require('./RTCError.cjs');

var __typeError = (msg) => {
  throw TypeError(msg);
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var _candidate, _channel, _error;
class RTCPeerConnectionIceEvent extends Event {
  constructor(candidate) {
    super("icecandidate");
    __privateAdd(this, _candidate);
    __privateSet(this, _candidate, candidate);
  }
  get candidate() {
    return __privateGet(this, _candidate);
  }
  get url() {
    return "";
  }
}
_candidate = new WeakMap();
class RTCDataChannelEvent extends Event {
  constructor(type = "datachannel", eventInitDict) {
    super(type);
    __privateAdd(this, _channel);
    if (arguments.length === 0)
      throw new TypeError(
        `Failed to construct 'RTCDataChannelEvent': 2 arguments required, but only ${arguments.length} present.`
      );
    if (typeof eventInitDict !== "object")
      throw new TypeError(
        "Failed to construct 'RTCDataChannelEvent': The provided value is not of type 'RTCDataChannelEventInit'."
      );
    if (!eventInitDict.channel)
      throw new TypeError(
        "Failed to construct 'RTCDataChannelEvent': Failed to read the 'channel' property from 'RTCDataChannelEventInit': Required member is undefined."
      );
    if (eventInitDict.channel.constructor !== RTCDataChannel.default)
      throw new TypeError(
        "Failed to construct 'RTCDataChannelEvent': Failed to read the 'channel' property from 'RTCDataChannelEventInit': Failed to convert value to 'RTCDataChannel'."
      );
    __privateSet(this, _channel, eventInitDict?.channel);
  }
  get channel() {
    return __privateGet(this, _channel);
  }
}
_channel = new WeakMap();
class RTCErrorEvent extends Event {
  constructor(type, init) {
    if (arguments.length < 2)
      throw new TypeError(
        `Failed to construct 'RTCErrorEvent': 2 arguments required, but only ${arguments.length} present.`
      );
    if (typeof init !== "object")
      throw new TypeError(
        "Failed to construct 'RTCErrorEvent': The provided value is not of type 'RTCErrorEventInit'."
      );
    if (!init.error)
      throw new TypeError(
        "Failed to construct 'RTCErrorEvent': Failed to read the 'error' property from 'RTCErrorEventInit': Required member is undefined."
      );
    if (init.error.constructor !== RTCError.default)
      throw new TypeError(
        "Failed to construct 'RTCErrorEvent': Failed to read the 'error' property from 'RTCErrorEventInit': Failed to convert value to 'RTCError'."
      );
    super(type || "error");
    __privateAdd(this, _error);
    __privateSet(this, _error, init.error);
  }
  get error() {
    return __privateGet(this, _error);
  }
}
_error = new WeakMap();

exports.RTCDataChannelEvent = RTCDataChannelEvent;
exports.RTCErrorEvent = RTCErrorEvent;
exports.RTCPeerConnectionIceEvent = RTCPeerConnectionIceEvent;
//# sourceMappingURL=Events.cjs.map
