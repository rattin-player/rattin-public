declare class RTCCertificate implements globalThis.RTCCertificate {
    #private;
    constructor();
    get expires(): number;
    getFingerprints(): globalThis.RTCDtlsFingerprint[];
    getAlgorithm(): string;
}

export { RTCCertificate as default };
