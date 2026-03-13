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

export { InvalidAccessError, InvalidStateError, NotFoundError, OperationError, SyntaxError };
//# sourceMappingURL=Exception.mjs.map
