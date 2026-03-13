'use strict';

class InvalidStateError extends DOMException {
  constructor(msg) {
    super(msg, "InvalidStateError");
  }
}
class OperationError extends DOMException {
  constructor(msg) {
    super(msg, "OperationError");
  }
}
class NotFoundError extends DOMException {
  constructor(msg) {
    super(msg, "NotFoundError");
  }
}
class InvalidAccessError extends DOMException {
  constructor(msg) {
    super(msg, "InvalidAccessError");
  }
}
class SyntaxError extends DOMException {
  constructor(msg) {
    super(msg, "SyntaxError");
  }
}

exports.InvalidAccessError = InvalidAccessError;
exports.InvalidStateError = InvalidStateError;
exports.NotFoundError = NotFoundError;
exports.OperationError = OperationError;
exports.SyntaxError = SyntaxError;
//# sourceMappingURL=Exception.cjs.map
