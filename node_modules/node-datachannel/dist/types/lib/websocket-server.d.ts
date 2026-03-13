import { EventEmitter } from 'events';
import { WebSocketServerConfiguration } from './types.js';
import { WebSocket } from './websocket.js';

declare class WebSocketServer extends EventEmitter {
    #private;
    constructor(options: WebSocketServerConfiguration);
    port(): number;
    stop(): void;
    onClient(cb: (clientSocket: WebSocket) => void): void;
}

export { WebSocketServer };
