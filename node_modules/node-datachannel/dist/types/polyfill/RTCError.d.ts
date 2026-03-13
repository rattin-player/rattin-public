declare class RTCError extends DOMException implements globalThis.RTCError {
    #private;
    constructor(init: globalThis.RTCErrorInit, message?: string);
    get errorDetail(): globalThis.RTCErrorDetailType;
    set errorDetail(_value: globalThis.RTCErrorDetailType);
    get receivedAlert(): number | null;
    set receivedAlert(_value: number | null);
    get sctpCauseCode(): number | null;
    set sctpCauseCode(_value: number | null);
    get httpRequestStatusCode(): number | null;
    get sdpLineNumber(): number | null;
    set sdpLineNumber(_value: number | null);
    get sentAlert(): number | null;
    set sentAlert(_value: number | null);
}

export { RTCError as default };
