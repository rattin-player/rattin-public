import RTCPeerConnection from './RTCPeerConnection.js';

declare class RTCDtlsTransport extends EventTarget implements globalThis.RTCDtlsTransport {
    #private;
    onstatechange: globalThis.RTCDtlsTransport['onstatechange'];
    onerror: globalThis.RTCDtlsTransport['onstatechange'];
    constructor(init: {
        pc: RTCPeerConnection;
    });
    get iceTransport(): globalThis.RTCIceTransport;
    get state(): globalThis.RTCDtlsTransportState;
    getRemoteCertificates(): ArrayBuffer[];
}

export { RTCDtlsTransport as default };
