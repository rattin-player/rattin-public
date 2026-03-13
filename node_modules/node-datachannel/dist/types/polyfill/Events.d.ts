import RTCDataChannel from './RTCDataChannel.js';

declare class RTCPeerConnectionIceEvent extends Event implements globalThis.RTCPeerConnectionIceEvent {
    #private;
    constructor(candidate: globalThis.RTCIceCandidate);
    get candidate(): globalThis.RTCIceCandidate;
    get url(): string;
}
declare class RTCDataChannelEvent extends Event implements globalThis.RTCDataChannelEvent {
    #private;
    constructor(type: string, eventInitDict: globalThis.RTCDataChannelEventInit);
    get channel(): RTCDataChannel;
}

export { RTCDataChannelEvent, RTCPeerConnectionIceEvent };
