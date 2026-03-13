if (typeof require.addon === 'function') {
  module.exports = require.addon.bind(require)
} else {
  const url = require('url')
  const fs = require('fs')
  const resolve = require('bare-addon-resolve')

  let host = process.platform + '-' + process.arch
  const conditions = ['addon', 'node', process.platform, process.arch]
  const extensions = ['.node']

  if (isAlpine()) {
    host += '-musl'
    conditions.push('musl')
  }

  module.exports = function addon(specifier, parentURL) {
    if (typeof parentURL === 'string') parentURL = url.pathToFileURL(parentURL)

    const candidates = []

    let cause

    for (const resolution of resolve(
      specifier,
      parentURL,
      { host, conditions, extensions },
      readPackage
    )) {
      candidates.push(resolution)

      switch (resolution.protocol) {
        case 'file:':
          try {
            return require(url.fileURLToPath(resolution))
          } catch (err) {
            cause = err
            continue
          }
      }
    }

    let message = `Cannot find addon '${specifier}' imported from '${parentURL.href}'`

    if (candidates.length > 0) {
      message += '\nCandidates:'
      message += '\n' + candidates.map((url) => '- ' + url.href).join('\n')
    }

    const err = new Error(message, cause ? { cause } : {})

    err.code = 'ADDON_NOT_FOUND'
    err.specifier = specifier
    err.referrer = parentURL
    err.candidates = candidates

    throw err
  }

  function readPackage(packageURL) {
    try {
      return require(url.fileURLToPath(packageURL))
    } catch (err) {
      return null
    }
  }

  function isAlpine() {
    return process.platform === 'linux' && fs.existsSync('/etc/alpine-release')
  }
}
