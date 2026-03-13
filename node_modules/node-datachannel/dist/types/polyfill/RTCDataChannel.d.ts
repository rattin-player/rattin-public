import { DataChannel } from '../lib/index';

declare class RTCDataChannel extends EventTarget implements globalThis.RTCDataChannel {
    #private;
    onbufferedamountlow: globalThis.RTCDataChannel['onbufferedamountlow'];
    onclose: globalThis.RTCDataChannel['onclose'];
    onclosing: globalThis.RTCDataChannel['onclosing'];
    onerror: globalThis.RTCDataChannel['onerror'];
    onmessage: globalThis.RTCDataChannel['onmessage'];
    onopen: globalThis.RTCDataChannel['onopen'];
    constructor(dataChannel: DataChannel, opts?: globalThis.RTCDataChannelInit);
    set binaryType(type: BinaryType);
    get binaryType(): BinaryType;
    get bufferedAmount(): number;
    get bufferedAmountLowThreshold(): number;
    set bufferedAmountLowThreshold(value: number);
    get id(): number | null;
    get label(): string;
    get maxPacketLifeTime(): number | null;
    get maxRetransmits(): number | null;
    get negotiated(): boolean;
    get ordered(): boolean;
    get protocol(): string;
    get readyState(): globalThis.RTCDataChannelState;
    send(data: any): void;
    close(): void;
}

export { RTCDataChannel as default };
