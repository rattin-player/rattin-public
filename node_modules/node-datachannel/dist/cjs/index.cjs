'use strict';

var index = require('./lib/index.cjs');
var index$1 = require('./polyfill/index.cjs');

const nodeDataChannel = index.default;
const polyfill = index$1.default;

exports.nodeDataChannel = nodeDataChannel;
exports.polyfill = polyfill;
//# sourceMappingURL=index.cjs.map
