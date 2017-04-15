
const Promise = require('any-promise')
const co = require('co').wrap
const promisify = require('pify')
const collect = promisify(require('stream-collector'))
const clone = require('xtend')
const changesFeed = require('changes-feed')
const subdown = require('subleveldown')
const pump = require('pump')
const through = require('through2')
const extend = require('xtend/mutable')
// const CombinedStream = require('combined-stream2')
const merge = require('merge2')
const omit = require('object.omit')
const AsyncEmitter = require('./async-emitter')
const implAutoincrement = require('./impl-autoincrement')
const implCustomSeq = require('./impl-custom-seq')
const {
  hexint,
  unhexint,
  createPassThrough,
  assert,
  validateEncoding,
  firstInStream,
  createKeyParserTransform
} = require('./utils')

const SEPARATOR = '!'
const MIN_CHAR = '\x00'
const MAX_CHAR = '\xff'
const QUEUE_CHECKPOINT_PREFIX = MIN_CHAR

module.exports = function createQueues ({ db, separator=SEPARATOR, autoincrement=true }) {
  const { valueEncoding } = db.options
  const batchAsync = promisify(db.batch.bind(db))
  const delAsync = promisify(db.del.bind(db))
  const queues = {}
  const ee = new AsyncEmitter()
  const tips = {}
  const have = {}
  const keyParser = createKeyParserTransform(parseKey)

  function markHave ({ queue, seq }) {
    if (!have[queue]) have[queue] = {}

    have[queue][seq] = true
  }

  function clearHave ({ queue, seq }) {
    if (have[queue] && have[queue][seq]) {
      delete have[queue][seq]
      return true
    }
  }

  function getQueueKeyRange ({ queue }) {
    const prefix = getQueuePrefix(queue)
    return {
      gt: prefix,
      lt: prefix + MAX_CHAR
    }
  }

  const impl = (autoincrement ? implAutoincrement : implCustomSeq)({ createQueueStream })

  function getQueue (identifier) {
    if (!queues[identifier]) {
      queues[identifier] = createQueue(identifier)
    }

    return queues[identifier]
  }

  const getTip = co(function* ({ queue }) {
    let tip = tips[queue]
    if (typeof tip !== 'undefined') {
      return tip
    }

    tip = tips[queue] = yield impl.tip({ queue })
    return tip
  })

  const clearQueue = co(function* ({ queue }) {
    yield Promise.all([
      yield collect(pump(
        db.createReadStream(extend({
          values: false
        }, getQueueKeyRange({ queue }))),
        through.obj(function (key, enc, cb) {
          db.del(key, cb)
        })
      )),
      delAsync(QUEUE_CHECKPOINT_PREFIX + queue)
    ])

    delete tips[queue]
  })

  function createQueue (queue) {
    const sub = subdown(db, queue, { valueEncoding, separator })
    const batchEnqueueInternal = impl.batchEnqueuer({ db: sub, queue })
    const promiseTip = getTip({ queue })

    let tip
    const updateTip = co(function* ({ seq }) {
      if (typeof tip === 'undefined') tip = yield promiseTip

      let newTip = tip
      if (tips[queue] + 1 === seq) {
        clearHave({ queue, seq })
        newTip = seq
      } else {
        markHave({ queue, seq })
      }

      while (clearHave({ queue, seq: newTip + 1 })) {
        newTip++
      }

      if (newTip !== tip) {
        tip = tips[queue] = newTip
        ee.emitAsync('tip', { queue, tip })
      }

      return tip
    })

    const enqueue = co(function* ({ value, seq }) {
      const results = yield batchEnqueue({
        data: [{ value, seq }]
      })

      return results[0]
    })

    const batchEnqueue = co(function* ({ data }) {
      data = data.slice()
      if (!autoincrement) {
        data.sort(sortAscendingBySeq)
      }

      const seqs = yield batchEnqueueInternal({ data })
      let tip
      for (let seq of seqs) {
        tip = yield updateTip({ seq })
      }

      return data.map((item, i) => {
        const { value } = item
        const seq = seqs[i]
        const key = getKey({ queue, seq })
        return { key, value, queue, tip, seq }
      })
    })

    return {
      enqueue,
      dequeue: () => dequeue({ queue }),
      batchEnqueue,
      createReadStream: createQueueStream.bind(null, queue),
      tip: () => getTip({ queue }),
      clear: () => clearQueue({ queue }),
      checkpoint: () => getQueueCheckpoint({ queue })
    }
  }

  function createQueueStream (queue, opts) {
    opts = extend(getQueueKeyRange({ queue }), opts)
    return createReadStream(opts)
  }

  function validateQueueName (queue) {
    assert(typeof queue === 'string', 'expected string "queue"')
    if (queue.indexOf(separator) !== -1) {
      throw new Error('"queue" must not contain "separator"')
    }
  }

  const enqueue = co(function* ({ value, queue, seq }) {
    validateQueueName(queue)
    if (!autoincrement) {
      assert(typeof seq === 'number', 'expected "seq"')
    }

    validateEncoding({ value, encoding: valueEncoding })
    const data = yield getQueue(queue).enqueue({ value, seq })
    ee.emitAsync('enqueue', data)
  })

  const batchEnqueue = co(function* ({ queue, data }) {
    validateQueueName(queue)
    if (!autoincrement) {
      assert(data.every(data => typeof data.seq === 'number'), 'expected every item to have a "seq"')
    }

    data.forEach(data => validateEncoding({ value: data.value, encoding: valueEncoding }))
    const results = yield getQueue(queue).batchEnqueue({ queue, data })
    results.forEach(item => ee.emitAsync('enqueue', item))
  })

  const dequeue = co(function* ({ queue }) {
    assert(typeof queue === 'string', 'expected string "queue"')
    const checkpoint = yield getQueueCheckpoint({ queue })
    const seq = typeof checkpoint === 'undefined' ? impl.firstSeq : checkpoint + 1
    const key = getKey({ queue, seq })
    const batch = [
      { type: 'del', key },
      { type: 'put', key: QUEUE_CHECKPOINT_PREFIX + queue, value: seq }
    ]

    yield batchAsync(batch)
    ee.emitAsync('dequeue', { queue, seq })
  })

  /**
   * Get the seq of the last dequeued item
   */
  function getQueueCheckpoint ({ queue }) {
    const prefix = QUEUE_CHECKPOINT_PREFIX + queue
    return firstInStream(db.createReadStream({
      limit: 1,
      keys: false,
      gte: prefix,
      lt: prefix + MAX_CHAR
    }))
  }

  function createReadStream (opts={}) {
    if (opts.queue) {
      return createQueueStream(opts.queue, omit(opts, 'queue'))
    }

    const old = db.createReadStream(extend({
      keys: true,
      values: true,
      gt: separator
    }, opts))

    const merged = merge(old, { end: !opts.live })
    if (opts.live) {
      const live = createPassThrough()
      ee.on('enqueue', onEnqueue)
      merged.add(live)
      merged.on('queueDrain', () => {
        ee.removeListener('enqueue', onEnqueue)
      })

      function onEnqueue (data) {
        live.write(data)
      }
    }

    return pump(merged, keyParser(opts))
  }

  /**
   * Get the next queue after {queue}, lexicographically
   */
  const getNextQueue = co(function* (queue) {
    const opts = {
      values: false,
      limit: 1
    }

    if (queue) {
      opts.gt = getQueuePrefix(queue) + MAX_CHAR
    }

    const results = yield collect(db.createReadStream(opts))
    if (results.length) {
      return parseKey(results[0]).queue
    }
  })

  /**
   * horribly inefficient way of listing queues
   * a better way would be to atomically update list of queues
   * when a new one is created or completed
   */
  const getQueues = co(function* () {
    const queues = []
    let queue
    while (true) {
      queue = yield getNextQueue(queue)
      if (!queue) break

      queues.push(queue)
    }

    return queues
  })

  function getKey ({ queue, seq }) {
    // BAD as it assumes knowledge of changes-feed internals
    return getQueuePrefix(queue) + hexint(seq)
  }

  function getQueuePrefix (queue) {
    // BAD as it assumes knowledge of subleveldown internals
    // the less efficient but better way would be to either export the prefixer function from subleveldown
    // or use getQueue(queue).prefix instead
    return separator + queue + separator
  }

  function parseKey (key) {
    const parts = key.split(separator)
    const seq = unhexint(parts.pop())
    const queue = parts.pop()
    return { queue, seq }
  }

  return extend(ee, {
    firstSeq: impl.firstSeq,
    autoincrement,
    queue: getQueue,
    batchEnqueue,
    enqueue,
    dequeue,
    createReadStream,
    queues: getQueues,
    nextQueue: getNextQueue,
    checkpoint: getQueueCheckpoint
  })
}

function sortAscendingBySeq (a, b) {
  return a.seq - b.seq
}
