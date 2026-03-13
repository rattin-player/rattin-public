'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var index = require('../lib/index.cjs');
var RTCSessionDescription = require('./RTCSessionDescription.cjs');
var RTCDataChannel = require('./RTCDataChannel.cjs');
var RTCIceCandidate = require('./RTCIceCandidate.cjs');
var Events = require('./Events.cjs');
var RTCSctpTransport = require('./RTCSctpTransport.cjs');
var Exception = require('./Exception.cjs');

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
var __privateWrapper = (obj, member, setter, getter) => ({
  set _(value) {
    __privateSet(obj, member, value);
  },
  get _() {
    return __privateGet(obj, member, getter);
  }
});
var _peerConnection, _localOffer, _localAnswer, _dataChannels, _dataChannelsClosed, _config, _canTrickleIceCandidates, _sctp, _announceNegotiation, _localCandidates, _remoteCandidates;
class RTCPeerConnection extends EventTarget {
  constructor(config = { iceServers: [], iceTransportPolicy: "all" }) {
    super();
    __privateAdd(this, _peerConnection);
    __privateAdd(this, _localOffer);
    __privateAdd(this, _localAnswer);
    __privateAdd(this, _dataChannels);
    __privateAdd(this, _dataChannelsClosed, 0);
    __privateAdd(this, _config);
    __privateAdd(this, _canTrickleIceCandidates, null);
    __privateAdd(this, _sctp);
    __privateAdd(this, _announceNegotiation, false);
    __privateAdd(this, _localCandidates, []);
    __privateAdd(this, _remoteCandidates, []);
    // events
    __publicField(this, "onconnectionstatechange", null);
    // For ondatachannel we need to define type manually
    __publicField(this, "ondatachannel");
    __publicField(this, "onicecandidate", null);
    __publicField(this, "onicecandidateerror", null);
    __publicField(this, "oniceconnectionstatechange", null);
    __publicField(this, "onicegatheringstatechange", null);
    __publicField(this, "onnegotiationneeded", null);
    __publicField(this, "onsignalingstatechange", null);
    __publicField(this, "ontrack", null);
    this._checkConfiguration(config);
    __privateSet(this, _config, config);
    __privateSet(this, _localOffer, createDeferredPromise());
    __privateSet(this, _localAnswer, createDeferredPromise());
    __privateSet(this, _dataChannels, /* @__PURE__ */ new Set());
    __privateSet(this, _canTrickleIceCandidates, null);
    try {
      const peerIdentity = config?.peerIdentity ?? `peer-${getRandomString(7)}`;
      __privateSet(this, _peerConnection, config?.peerConnection ?? new index.PeerConnection(peerIdentity, {
        ...config,
        iceServers: config?.iceServers?.map((server) => {
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          return urls.map((url) => {
            if (server.username && server.credential) {
              const [protocol, rest] = url.split(/:(.*)/);
              return `${protocol}:${server.username}:${server.credential}@${rest}`;
            }
            return url;
          });
        }).flat() ?? []
      }));
    } catch (error) {
      if (!error || !error.message) throw new Exception.NotFoundError("Unknown error");
      throw new Exception.SyntaxError(error.message);
    }
    __privateGet(this, _peerConnection).onStateChange(() => {
      this.dispatchEvent(new Event("connectionstatechange"));
    });
    __privateGet(this, _peerConnection).onIceStateChange(() => {
      this.dispatchEvent(new Event("iceconnectionstatechange"));
    });
    __privateGet(this, _peerConnection).onSignalingStateChange(() => {
      this.dispatchEvent(new Event("signalingstatechange"));
    });
    __privateGet(this, _peerConnection).onGatheringStateChange(() => {
      this.dispatchEvent(new Event("icegatheringstatechange"));
    });
    __privateGet(this, _peerConnection).onDataChannel((channel) => {
      const dc = new RTCDataChannel.default(channel);
      __privateGet(this, _dataChannels).add(dc);
      this.dispatchEvent(new Events.RTCDataChannelEvent("datachannel", { channel: dc }));
    });
    __privateGet(this, _peerConnection).onLocalDescription((sdp, type) => {
      if (type === "offer") {
        __privateGet(this, _localOffer).resolve(new RTCSessionDescription.default({ sdp, type }));
      }
      if (type === "answer") {
        __privateGet(this, _localAnswer).resolve(new RTCSessionDescription.default({ sdp, type }));
      }
    });
    __privateGet(this, _peerConnection).onLocalCandidate((candidate, sdpMid) => {
      if (sdpMid === "unspec") {
        __privateGet(this, _localAnswer).reject(new Error(`Invalid description type ${sdpMid}`));
        return;
      }
      __privateGet(this, _localCandidates).push(new RTCIceCandidate.default({ candidate, sdpMid }));
      this.dispatchEvent(new Events.RTCPeerConnectionIceEvent(new RTCIceCandidate.default({ candidate, sdpMid })));
    });
    this.addEventListener("connectionstatechange", (e) => {
      this.onconnectionstatechange?.(e);
    });
    this.addEventListener("signalingstatechange", (e) => {
      this.onsignalingstatechange?.(e);
    });
    this.addEventListener("iceconnectionstatechange", (e) => {
      this.oniceconnectionstatechange?.(e);
    });
    this.addEventListener("icegatheringstatechange", (e) => {
      this.onicegatheringstatechange?.(e);
    });
    this.addEventListener("datachannel", (e) => {
      this.ondatachannel?.(e);
    });
    this.addEventListener("icecandidate", (e) => {
      this.onicecandidate?.(e);
    });
    this.addEventListener("track", (e) => {
      this.ontrack?.(e);
    });
    this.addEventListener("negotiationneeded", (e) => {
      __privateSet(this, _announceNegotiation, true);
      this.onnegotiationneeded?.(e);
    });
    __privateSet(this, _sctp, new RTCSctpTransport.default({
      pc: this
    }));
  }
  static async generateCertificate() {
    throw new DOMException("Not implemented");
  }
  _checkConfiguration(config) {
    if (config && config.iceServers === void 0) config.iceServers = [];
    if (config && config.iceTransportPolicy === void 0) config.iceTransportPolicy = "all";
    if (config?.iceServers === null) throw new TypeError("IceServers cannot be null");
    if (Array.isArray(config?.iceServers)) {
      for (let i = 0; i < config.iceServers.length; i++) {
        if (config.iceServers[i] === null) throw new TypeError("IceServers cannot be null");
        if (config.iceServers[i] === void 0)
          throw new TypeError("IceServers cannot be undefined");
        if (Object.keys(config.iceServers[i]).length === 0)
          throw new TypeError("IceServers cannot be empty");
        if (typeof config.iceServers[i].urls === "string")
          config.iceServers[i].urls = [config.iceServers[i].urls];
        if (config.iceServers[i].urls?.some((url) => url == ""))
          throw new Exception.SyntaxError("IceServers urls cannot be empty");
        if (config.iceServers[i].urls?.some((url) => {
          try {
            const parsedURL = new URL(url);
            return !/^(stun:|turn:|turns:)$/.test(parsedURL.protocol);
          } catch (error) {
            return true;
          }
        }))
          throw new Exception.SyntaxError("IceServers urls wrong format");
        if (config.iceServers[i].urls?.some((url) => url.startsWith("turn"))) {
          if (!config.iceServers[i].username)
            throw new Exception.InvalidAccessError("IceServers username cannot be null");
          if (!config.iceServers[i].credential)
            throw new Exception.InvalidAccessError("IceServers username cannot be undefined");
        }
        if (config.iceServers[i].urls?.length === 0)
          throw new Exception.SyntaxError("IceServers urls cannot be empty");
      }
    }
    if (config && config.iceTransportPolicy && config.iceTransportPolicy !== "all" && config.iceTransportPolicy !== "relay")
      throw new TypeError('IceTransportPolicy must be either "all" or "relay"');
  }
  setConfiguration(config) {
    this._checkConfiguration(config);
    __privateSet(this, _config, config);
  }
  // Extra FUnctions
  get ext_maxDataChannelId() {
    return __privateGet(this, _peerConnection).maxDataChannelId();
  }
  get ext_maxMessageSize() {
    return __privateGet(this, _peerConnection).maxMessageSize();
  }
  get ext_localCandidates() {
    return __privateGet(this, _localCandidates);
  }
  get ext_remoteCandidates() {
    return __privateGet(this, _remoteCandidates);
  }
  selectedCandidatePair() {
    return __privateGet(this, _peerConnection).getSelectedCandidatePair();
  }
  get canTrickleIceCandidates() {
    return __privateGet(this, _canTrickleIceCandidates);
  }
  get connectionState() {
    return __privateGet(this, _peerConnection).state();
  }
  get iceConnectionState() {
    let state = __privateGet(this, _peerConnection).iceState();
    if (state == "completed") state = "connected";
    return state;
  }
  get iceGatheringState() {
    return __privateGet(this, _peerConnection).gatheringState();
  }
  get currentLocalDescription() {
    return new RTCSessionDescription.default(__privateGet(this, _peerConnection).localDescription());
  }
  get currentRemoteDescription() {
    return new RTCSessionDescription.default(__privateGet(this, _peerConnection).remoteDescription());
  }
  get localDescription() {
    return new RTCSessionDescription.default(__privateGet(this, _peerConnection).localDescription());
  }
  get pendingLocalDescription() {
    return new RTCSessionDescription.default(__privateGet(this, _peerConnection).localDescription());
  }
  get pendingRemoteDescription() {
    return new RTCSessionDescription.default(__privateGet(this, _peerConnection).remoteDescription());
  }
  get remoteDescription() {
    return new RTCSessionDescription.default(__privateGet(this, _peerConnection).remoteDescription());
  }
  get sctp() {
    return __privateGet(this, _sctp);
  }
  get signalingState() {
    return __privateGet(this, _peerConnection).signalingState();
  }
  async addIceCandidate(candidate) {
    if (!candidate || !candidate.candidate) {
      return;
    }
    if (candidate.sdpMid === null && candidate.sdpMLineIndex === null) {
      throw new TypeError("sdpMid must be set");
    }
    if (candidate.sdpMid === void 0 && candidate.sdpMLineIndex == void 0) {
      throw new TypeError("sdpMid must be set");
    }
    if (candidate.sdpMid && candidate.sdpMid.length > 3) {
      throw new Exception.OperationError("Invalid sdpMid format");
    }
    if (!candidate.sdpMid && candidate.sdpMLineIndex > 1) {
      throw new Exception.OperationError("This is only for test case.");
    }
    try {
      __privateGet(this, _peerConnection).addRemoteCandidate(candidate.candidate, candidate.sdpMid ?? "0");
      __privateGet(this, _remoteCandidates).push(
        new RTCIceCandidate.default({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? "0"
        })
      );
    } catch (error) {
      if (!error || !error.message) throw new Exception.NotFoundError("Unknown error");
      if (error.message.includes("remote candidate without remote description"))
        throw new Exception.InvalidStateError(error.message);
      if (error.message.includes("Invalid candidate format"))
        throw new Exception.OperationError(error.message);
      throw new Exception.NotFoundError(error.message);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addTrack(_track, ..._streams) {
    throw new DOMException("Not implemented");
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addTransceiver(_trackOrKind, _init) {
    throw new DOMException("Not implemented");
  }
  close() {
    __privateGet(this, _peerConnection).close();
  }
  createAnswer() {
    return __privateGet(this, _localAnswer);
  }
  createDataChannel(label, opts = {}) {
    const nativeOpts = {
      ...opts,
      // libdatachannel uses "unordered", opposite of RTCDataChannelInit.ordered
      unordered: opts.ordered === false ? true : false
    };
    const channel = __privateGet(this, _peerConnection).createDataChannel(label, nativeOpts);
    const dataChannel = new RTCDataChannel.default(channel, opts);
    __privateGet(this, _dataChannels).add(dataChannel);
    dataChannel.addEventListener("close", () => {
      __privateGet(this, _dataChannels).delete(dataChannel);
      __privateWrapper(this, _dataChannelsClosed)._++;
    });
    if (__privateGet(this, _announceNegotiation) == null) {
      __privateSet(this, _announceNegotiation, false);
      this.dispatchEvent(new Event("negotiationneeded"));
    }
    return dataChannel;
  }
  createOffer() {
    return __privateGet(this, _localOffer);
  }
  getConfiguration() {
    return __privateGet(this, _config);
  }
  getReceivers() {
    throw new DOMException("Not implemented");
  }
  getSenders() {
    throw new DOMException("Not implemented");
  }
  getStats() {
    return new Promise((resolve) => {
      const report = /* @__PURE__ */ new Map();
      const cp = __privateGet(this, _peerConnection)?.getSelectedCandidatePair();
      const bytesSent = __privateGet(this, _peerConnection)?.bytesSent();
      const bytesReceived = __privateGet(this, _peerConnection)?.bytesReceived();
      const rtt = __privateGet(this, _peerConnection)?.rtt();
      if (!cp) {
        return resolve(report);
      }
      const localIdRs = getRandomString(8);
      const localId = "RTCIceCandidate_" + localIdRs;
      report.set(localId, {
        id: localId,
        type: "local-candidate",
        timestamp: Date.now(),
        candidateType: cp.local.type,
        ip: cp.local.address,
        port: cp.local.port
      });
      const remoteIdRs = getRandomString(8);
      const remoteId = "RTCIceCandidate_" + remoteIdRs;
      report.set(remoteId, {
        id: remoteId,
        type: "remote-candidate",
        timestamp: Date.now(),
        candidateType: cp.remote.type,
        ip: cp.remote.address,
        port: cp.remote.port
      });
      const candidateId = "RTCIceCandidatePair_" + localIdRs + "_" + remoteIdRs;
      report.set(candidateId, {
        id: candidateId,
        type: "candidate-pair",
        timestamp: Date.now(),
        localCandidateId: localId,
        remoteCandidateId: remoteId,
        state: "succeeded",
        nominated: true,
        writable: true,
        bytesSent,
        bytesReceived,
        totalRoundTripTime: rtt,
        currentRoundTripTime: rtt
      });
      const transportId = "RTCTransport_0_1";
      report.set(transportId, {
        id: transportId,
        timestamp: Date.now(),
        type: "transport",
        bytesSent,
        bytesReceived,
        dtlsState: "connected",
        selectedCandidatePairId: candidateId,
        selectedCandidatePairChanges: 1
      });
      report.set("P", {
        id: "P",
        type: "peer-connection",
        timestamp: Date.now(),
        dataChannelsOpened: __privateGet(this, _dataChannels).size,
        dataChannelsClosed: __privateGet(this, _dataChannelsClosed)
      });
      return resolve(report);
    });
  }
  getTransceivers() {
    return [];
  }
  removeTrack() {
    throw new DOMException("Not implemented");
  }
  restartIce() {
    throw new DOMException("Not implemented");
  }
  async setLocalDescription(description) {
    if (description?.type !== "offer") {
      return;
    }
    __privateGet(this, _peerConnection).setLocalDescription(description?.type);
  }
  async setRemoteDescription(description) {
    if (description.sdp == null) {
      throw new DOMException("Remote SDP must be set");
    }
    __privateGet(this, _peerConnection).setRemoteDescription(description.sdp, description.type);
  }
}
_peerConnection = new WeakMap();
_localOffer = new WeakMap();
_localAnswer = new WeakMap();
_dataChannels = new WeakMap();
_dataChannelsClosed = new WeakMap();
_config = new WeakMap();
_canTrickleIceCandidates = new WeakMap();
_sctp = new WeakMap();
_announceNegotiation = new WeakMap();
_localCandidates = new WeakMap();
_remoteCandidates = new WeakMap();
function createDeferredPromise() {
  let resolve, reject;
  const promise = new Promise(function(_resolve, _reject) {
    resolve = _resolve;
    reject = _reject;
  });
  promise.resolve = resolve;
  promise.reject = reject;
  return promise;
}
function getRandomString(length) {
  return Math.random().toString(36).substring(2, 2 + length);
}

exports.default = RTCPeerConnection;
//# sourceMappingURL=RTCPeerConnection.cjs.map
