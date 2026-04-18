/**
 * Tiny zero-dep concurrency limiter. Returns a function that wraps an async
 * thunk so at most `concurrency` of them run at once; the rest queue FIFO.
 *   const limit = pLimit(10)
 *   await Promise.all(items.map((x) => limit(() => doWork(x))))
 */
export function pLimit(concurrency) {
  const queue = []
  let active = 0
  function next() {
    if (active >= concurrency || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--
        next()
      })
  }
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      next()
    })
}
