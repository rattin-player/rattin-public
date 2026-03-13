export class DOMException extends Error {
  /**
   * @param {string} message
   * @param {string} [name]
   **/
  constructor (message, name) {
    super(message)
    this.name = name
  }

  toString () {
    return `${this.name}: ${this.message}`
  }
}
