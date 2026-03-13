declare class RTCIceCandidate implements globalThis.RTCIceCandidate {
    #private;
    constructor({ candidate, sdpMLineIndex, sdpMid, usernameFragment, }: globalThis.RTCIceCandidateInit);
    get address(): string | null;
    get candidate(): string;
    get component(): globalThis.RTCIceComponent | null;
    get foundation(): string | null;
    get port(): number | null;
    get priority(): number | null;
    get protocol(): globalThis.RTCIceProtocol | null;
    get relatedAddress(): string | null;
    get relatedPort(): number | null;
    get sdpMLineIndex(): number | null;
    get sdpMid(): string | null;
    get tcpType(): globalThis.RTCIceTcpCandidateType | null;
    get type(): globalThis.RTCIceCandidateType | null;
    get usernameFragment(): string | null;
    toJSON(): globalThis.RTCIceCandidateInit;
}

export { RTCIceCandidate as default };
