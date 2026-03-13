var __typeError = (msg) => {
  throw TypeError(msg);
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var _address, _candidate, _component, _foundation, _port, _priority, _protocol, _relatedAddress, _relatedPort, _sdpMLineIndex, _sdpMid, _tcpType, _type, _usernameFragment;
class RTCIceCandidate {
  constructor({
    candidate,
    sdpMLineIndex,
    sdpMid,
    usernameFragment
  }) {
    __privateAdd(this, _address);
    __privateAdd(this, _candidate);
    __privateAdd(this, _component);
    __privateAdd(this, _foundation);
    __privateAdd(this, _port);
    __privateAdd(this, _priority);
    __privateAdd(this, _protocol);
    __privateAdd(this, _relatedAddress);
    __privateAdd(this, _relatedPort);
    __privateAdd(this, _sdpMLineIndex);
    __privateAdd(this, _sdpMid);
    __privateAdd(this, _tcpType);
    __privateAdd(this, _type);
    __privateAdd(this, _usernameFragment);
    if (sdpMLineIndex == null && sdpMid == null)
      throw new TypeError("At least one of sdpMLineIndex or sdpMid must be specified");
    __privateSet(this, _candidate, candidate === null ? "null" : candidate ?? "");
    __privateSet(this, _sdpMLineIndex, sdpMLineIndex ?? null);
    __privateSet(this, _sdpMid, sdpMid ?? null);
    __privateSet(this, _usernameFragment, usernameFragment ?? null);
    if (candidate) {
      const fields = candidate.split(" ");
      __privateSet(this, _foundation, fields[0].replace("candidate:", ""));
      __privateSet(this, _component, fields[1] == "1" ? "rtp" : "rtcp");
      __privateSet(this, _protocol, fields[2]);
      __privateSet(this, _priority, parseInt(fields[3], 10));
      __privateSet(this, _address, fields[4]);
      __privateSet(this, _port, parseInt(fields[5], 10));
      __privateSet(this, _type, fields[7]);
      __privateSet(this, _tcpType, null);
      __privateSet(this, _relatedAddress, null);
      __privateSet(this, _relatedPort, null);
      for (let i = 8; i < fields.length; i++) {
        const field = fields[i];
        if (field === "raddr") {
          __privateSet(this, _relatedAddress, fields[i + 1]);
        } else if (field === "rport") {
          __privateSet(this, _relatedPort, parseInt(fields[i + 1], 10));
        }
        if (__privateGet(this, _protocol) === "tcp" && field === "tcptype") {
          __privateSet(this, _tcpType, fields[i + 1]);
        }
      }
    }
  }
  get address() {
    return __privateGet(this, _address) ?? null;
  }
  get candidate() {
    return __privateGet(this, _candidate);
  }
  get component() {
    return __privateGet(this, _component);
  }
  get foundation() {
    return __privateGet(this, _foundation) ?? null;
  }
  get port() {
    return __privateGet(this, _port) ?? null;
  }
  get priority() {
    return __privateGet(this, _priority) ?? null;
  }
  get protocol() {
    return __privateGet(this, _protocol) ?? null;
  }
  get relatedAddress() {
    return __privateGet(this, _relatedAddress);
  }
  get relatedPort() {
    return __privateGet(this, _relatedPort) ?? null;
  }
  get sdpMLineIndex() {
    return __privateGet(this, _sdpMLineIndex);
  }
  get sdpMid() {
    return __privateGet(this, _sdpMid);
  }
  get tcpType() {
    return __privateGet(this, _tcpType);
  }
  get type() {
    return __privateGet(this, _type) ?? null;
  }
  get usernameFragment() {
    return __privateGet(this, _usernameFragment);
  }
  toJSON() {
    return {
      candidate: __privateGet(this, _candidate),
      sdpMLineIndex: __privateGet(this, _sdpMLineIndex),
      sdpMid: __privateGet(this, _sdpMid),
      usernameFragment: __privateGet(this, _usernameFragment)
    };
  }
}
_address = new WeakMap();
_candidate = new WeakMap();
_component = new WeakMap();
_foundation = new WeakMap();
_port = new WeakMap();
_priority = new WeakMap();
_protocol = new WeakMap();
_relatedAddress = new WeakMap();
_relatedPort = new WeakMap();
_sdpMLineIndex = new WeakMap();
_sdpMid = new WeakMap();
_tcpType = new WeakMap();
_type = new WeakMap();
_usernameFragment = new WeakMap();

export { RTCIceCandidate as default };
//# sourceMappingURL=RTCIceCandidate.mjs.map
