var __typeError = (msg) => {
  throw TypeError(msg);
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var _type, _sdp;
class RTCSessionDescription {
  constructor(init) {
    __privateAdd(this, _type);
    __privateAdd(this, _sdp);
    __privateSet(this, _type, init?.type);
    __privateSet(this, _sdp, init?.sdp ?? "");
  }
  get type() {
    return __privateGet(this, _type);
  }
  set type(type) {
    if (type !== "offer" && type !== "answer" && type !== "pranswer" && type !== "rollback") {
      throw new TypeError(
        `Failed to set the 'type' property on 'RTCSessionDescription': The provided value '${type}' is not a valid enum value of type RTCSdpType.`
      );
    }
    __privateSet(this, _type, type);
  }
  get sdp() {
    return __privateGet(this, _sdp);
  }
  toJSON() {
    return {
      sdp: __privateGet(this, _sdp),
      type: __privateGet(this, _type)
    };
  }
}
_type = new WeakMap();
_sdp = new WeakMap();

export { RTCSessionDescription as default };
//# sourceMappingURL=RTCSessionDescription.mjs.map
