import RTCPeerConnection from './RTCPeerConnection.js';

declare class RTCSctpTransport extends EventTarget implements globalThis.RTCSctpTransport {
    #private;
    onstatechange: globalThis.RTCSctpTransport['onstatechange'];
    constructor(initial: {
        pc: RTCPeerConnection;
    });
    get maxChannels(): number | null;
    get maxMessageSize(): number;
    get state(): globalThis.RTCSctpTransportState;
    get transport(): globalThis.RTCDtlsTransport;
}

export { RTCSctpTransport as default };
