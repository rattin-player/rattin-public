import { Channel, WebSocketServerConfiguration } from './types.js';

interface WebSocket extends Channel {
    open(url: string): void;
    forceClose(): void;
    remoteAddress(): string | undefined;
    path(): string | undefined;
    close(): void;
    sendMessage(msg: string): boolean;
    sendMessageBinary(buffer: Uint8Array): boolean;
    isOpen(): boolean;
    bufferedAmount(): number;
    maxMessageSize(): number;
    setBufferedAmountLowThreshold(newSize: number): void;
    onOpen(cb: () => void): void;
    onClosed(cb: () => void): void;
    onError(cb: (err: string) => void): void;
    onBufferedAmountLow(cb: () => void): void;
    onMessage(cb: (msg: string | Buffer) => void): void;
}
declare const WebSocket: {
    new (config?: WebSocketServerConfiguration): WebSocket;
};

export { WebSocket };
