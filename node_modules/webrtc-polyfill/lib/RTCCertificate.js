/**
 * @class
 * @implements {globalThis.RTCCertificate}
 */
export default class RTCCertificate {
  #expires = null
  #fingerprints = []

  get expires () {
    return this.#expires
  }

  getFingerprints () {
    return this.#fingerprints
  }

  getAlgorithm () {
    return ''
  }
}
