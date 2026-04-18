import { useCallback, useEffect, useRef } from 'react'

export default function ResizeHandle({ side = 'right', onResize, onResizeStart, onDraggingChange }) {
  const dragging = useRef(false)
  const startX = useRef(0)
  const onResizeStartRef = useRef(onResizeStart)
  onResizeStartRef.current = onResizeStart
  const onDraggingChangeRef = useRef(onDraggingChange)
  onDraggingChangeRef.current = onDraggingChange

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    onResizeStartRef.current?.()
    onDraggingChangeRef.current?.(true)
  }, [])

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragging.current) return
      const delta = side === 'right' ? e.clientX - startX.current : startX.current - e.clientX
      onResize(delta)
    }
    const endDrag = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onDraggingChangeRef.current?.(false)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', endDrag)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', endDrag)
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        onDraggingChangeRef.current?.(false)
      }
    }
  }, [onResize, side])

  return (
    <div
      onMouseDown={onMouseDown}
      className="shrink-0 w-0 relative cursor-col-resize z-10 before:content-[''] before:absolute before:inset-y-0 before:w-2 before:-left-1"
    />
  )
}
