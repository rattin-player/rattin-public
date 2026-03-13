import RTCPeerConnection from './RTCPeerConnection.js';

declare class RTCIceTransport extends EventTarget implements globalThis.RTCIceTransport {
    #private;
    ongatheringstatechange: globalThis.RTCIceTransport['ongatheringstatechange'];
    onselectedcandidatepairchange: globalThis.RTCIceTransport['onselectedcandidatepairchange'];
    onstatechange: globalThis.RTCIceTransport['onstatechange'];
    constructor(init: {
        pc: RTCPeerConnection;
    });
    get component(): globalThis.RTCIceComponent;
    get gatheringState(): globalThis.RTCIceGatheringState;
    get role(): globalThis.RTCIceRole;
    get state(): globalThis.RTCIceTransportState;
    getLocalCandidates(): globalThis.RTCIceCandidate[];
    getLocalParameters(): RTCIceParameters | null;
    getRemoteCandidates(): globalThis.RTCIceCandidate[];
    getRemoteParameters(): any;
    getSelectedCandidatePair(): globalThis.RTCIceCandidatePair | null;
}
declare class RTCIceParameters implements globalThis.RTCIceParameters {
    usernameFragment: string;
    password: string;
    constructor({ usernameFragment, password }: {
        usernameFragment: any;
        password?: string;
    });
}

export { RTCIceParameters, RTCIceTransport as default };
