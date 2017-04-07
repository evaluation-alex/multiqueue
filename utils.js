const lexint = require('lexicographic-integer')
const Promise = require('bluebird')
const co = Promise.coroutine
const collect = Promise.promisify(require('stream-collector'))
const through = require('through2')
const MAX_INT = 2147483647

const firstInStream = co(function* (stream) {
  const results = yield collect(stream)
  return results[0]
})

module.exports = {
  assert,
  validateEncoding,
  createPassThrough,
  hexint,
  unhexint,
  firstInStream,
  MAX_INT
}

function assert (statement, err) {
  if (!statement) throw new Error(err || 'assertion failed')
}

function validateEncoding ({ value, encoding }) {
  if (encoding === 'binary') {
    assert(Buffer.isBuffer(value), 'expected Buffer')
  } else if (encoding === 'json') {
    assert(value && typeof value === 'object', 'expected object')
  } else if (encoding === 'string') {
    assert(typeof value === 'string', 'expected string')
  }
}

function createPassThrough () {
  return through.obj(function (data, enc, cb) {
    cb(null, data)
  })
}

function hexint (n) {
  return lexint.pack(n, 'hex')
}

function unhexint (hex) {
  return lexint.unpack(Array.prototype.slice.call(new Buffer(hex, 'hex')))
}
