'use strict';

var events = require('events');
var nodeDatachannel = require('./node-datachannel.cjs');

var __typeError = (msg) => {
  throw TypeError(msg);
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var _server, _clients;
class WebSocketServer extends events.EventEmitter {
  constructor(options) {
    super();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __privateAdd(this, _server);
    __privateAdd(this, _clients, []);
    __privateSet(this, _server, new nodeDatachannel.default.WebSocketServer(options));
    __privateGet(this, _server).onClient((client) => {
      this.emit("client", client);
      __privateGet(this, _clients).push(client);
    });
  }
  port() {
    return __privateGet(this, _server)?.port() || 0;
  }
  stop() {
    __privateGet(this, _clients).forEach((client) => {
      client?.close();
    });
    __privateGet(this, _server)?.stop();
    __privateSet(this, _server, null);
    this.removeAllListeners();
  }
  onClient(cb) {
    if (__privateGet(this, _server)) this.on("client", cb);
  }
}
_server = new WeakMap();
_clients = new WeakMap();

exports.WebSocketServer = WebSocketServer;
//# sourceMappingURL=websocket-server.cjs.map
