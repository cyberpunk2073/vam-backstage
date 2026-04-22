import { useEffect, useState } from 'react'

let cached = null
let inflight = null

export function useIsDev() {
  const [isDev, setIsDev] = useState(cached ?? false)
  useEffect(() => {
    if (cached !== null) {
      setIsDev(cached)
      return
    }
    if (!inflight) {
      inflight = window.api.dev.isDev().then((v) => {
        cached = !!v
        return cached
      })
    }
    let active = true
    inflight.then((v) => {
      if (active) setIsDev(v)
    })
    return () => {
      active = false
    }
  }, [])
  return isDev
}
