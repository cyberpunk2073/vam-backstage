import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Graph } from '@cosmos.gl/graph'
import { Loader2, Maximize2, Play, Pause, AlertTriangle, X, RotateCcw } from 'lucide-react'
import { useGraphStore } from '@/stores/useGraphStore'

/*
 * Cosmos engine caveats:
 * - Every force is multiplied by alpha. At the ALPHA_FLOOR idle the sim runs
 *   at ~2% power: overlaps that "never resolve" are asleep, not broken.
 * - Springs are Hookean and attraction-only: rest length is a floor, pull
 *   grows with stretch forever while repulsion decays 1/r — so at long range
 *   any undamped link wins, which is what collapses a small-world graph into
 *   one ball. Structure lives in the per-link strengths, not the sliders.
 * - Stability budget: per-tick correction ≈ linkStrength × linkSpring × alpha.
 *   Past ~0.5 the sim turns into heated gas that never settles (we hit this
 *   at leaf strength 43 with alpha 0.02).
 * - 1/r repulsion is long-range: a big cluster blows a "wind" (~700·alpha
 *   measured here) on its surroundings. Leaves held by one spring stream
 *   leeward and bunch at the taut-leash point; out-stiffening the wind needs
 *   exactly the strength that crosses the stability budget, so pendant leaf
 *   fans facing away from the core are an engine limit, not a param bug.
 * - Gravity and the cluster force are harmonic traps (force ∝ distance):
 *   arbitrarily small coefficients still dominate at range. Keep gravity ~0;
 *   gate cluster strength to exactly 0 (not "small") for low-degree nodes.
 * - Collision is grid-cell-averaged, density-damped (×2/N neighbors) and
 *   per-tick capped: a soft spacing pressure, not contact resolution.
 */

const BG = '#0a0b10'
/**
 * Simulation box (cosmos clamps positions to it). This is the global density
 * ceiling: the fitted view can never be sparser than n nodes packed into this
 * area. 4096 forced a ball; 8192 gives the layout room to look like a star
 * field. Do not raise to 16384: cosmos silently halves any spaceSize >= the
 * GPU's max texture dimension (16384 here), and our seeds/anchors would then
 * fall outside the real box and clamp onto its walls.
 */
const SPACE_SIZE = 8192
/** Thumbnails are decoded/downscaled to this square size for the GPU atlas. */
const THUMB_PX = 64
/** Ring baked around each circular thumbnail, in atlas pixels. */
const THUMB_BORDER = 3
/**
 * Steady simulation energy — kept topped up so the layout never fully freezes.
 * Kept low on purpose: sustained high alpha acts like annealing and lets
 * repulsion/collision reorganize nodes into a uniform hex packing, erasing the
 * link structure. At ~0.02 the graph still breathes but keeps its shape.
 */
const ALPHA_FLOOR = 0.02

const BORDER_DIRECT = 'rgb(74, 145, 241)' // blue — installed on purpose
const BORDER_DEP = 'rgb(150, 157, 170)' // grey — pulled in as a dependency

// Keep the renderer values named so the debug panel reports the exact inputs
// currently sent to cosmos rather than approximating them from the result.
const LINK_DEFAULT_WIDTH = 1
const LINK_HOVER_WIDTH = 1.35
const LINK_WIDTH_SCALE = 1
const LINK_OPACITY = 1
const LINK_VISIBILITY_DISTANCE_RANGE = [50, 150]
const LINK_VISIBILITY_MIN_TRANSPARENCY = 0.12
const SCALE_LINKS_ON_ZOOM = false
const LINK_ZOOM_ANCHOR = 0.525954
/** Default link color (#3a3d4d) as RGBA 0..1. */
const LINK_COLOR = [58 / 255, 61 / 255, 77 / 255, 1]
/** Mildly brightened link color on node hover — intensity only, no grey-out of others. */
const LINK_HOVER_COLOR = [0.4, 0.43, 0.52, 1]

// RGBA in 0..1 — cosmos wants raw floats per point.
const COLOR_DIRECT = [0.29, 0.57, 0.95, 1] // blue — installed on purpose
const COLOR_DEP = [0.42, 0.45, 0.5, 0.85] // grey — dependency

function colorFor(node) {
  return node.isDirect ? COLOR_DIRECT : COLOR_DEP
}

function linkStyleForZoom(zoom) {
  const relativeLogZoom = Math.log2(Math.max(zoom, Number.EPSILON) / LINK_ZOOM_ANCHOR)
  const zoomIn = Math.max(0, relativeLogZoom)

  // At the fitted view the original style is already right. Farther out, most
  // links are shorter than the visibility range and therefore fully opaque, so
  // reduce only the global opacity. Farther in, long links hit the fade floor:
  // lift that floor progressively, introducing extra width only at close range.
  const opacity = relativeLogZoom < 0 ? Math.max(0.08, 2 ** (relativeLogZoom * 1.55)) : LINK_OPACITY
  const fadeFloor = Math.min(0.48, LINK_VISIBILITY_MIN_TRANSPARENCY + 0.055 * zoomIn + 0.009 * zoomIn ** 2)
  const widthProgress = Math.max(0, Math.min(1, (zoomIn - 1.4) / 2.1))
  const smoothWidthProgress = widthProgress * widthProgress * (3 - 2 * widthProgress)
  const widthScale = LINK_WIDTH_SCALE + smoothWidthProgress * 0.45

  return { opacity, fadeFloor, widthScale }
}

/** Run `fn` over `items` with bounded concurrency (decode is the expensive bit). */
async function mapLimit(items, limit, fn) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

/**
 * Decode a 64×64 graph tile into a circular ImageData for cosmos's atlas:
 * the image is clipped to a disc and ringed with `borderCss` (direct vs dep).
 * Corners stay transparent so the point reads as a bordered circle. Main already
 * resized the JPEG; we only bake the circle + border here.
 */
async function bufferToImageData(buf, borderCss) {
  if (!buf) return null
  try {
    const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }))
    const canvas = new OffscreenCanvas(THUMB_PX, THUMB_PX)
    const ctx = canvas.getContext('2d')
    const c = THUMB_PX / 2
    const r = c - THUMB_BORDER / 2

    ctx.save()
    ctx.beginPath()
    ctx.arc(c, c, r, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(bitmap, 0, 0, THUMB_PX, THUMB_PX)
    ctx.restore()
    bitmap.close()

    ctx.beginPath()
    ctx.arc(c, c, r, 0, Math.PI * 2)
    ctx.lineWidth = THUMB_BORDER
    ctx.strokeStyle = borderCss
    ctx.stroke()

    return ctx.getImageData(0, 0, THUMB_PX, THUMB_PX)
  } catch {
    return null
  }
}

/**
 * Number of distinct *direct* (installed) packages that can transitively reach
 * each node by following dependency edges (source → target = "source depends on
 * target"). This is the transitive-aware importance metric: a dep with a single
 * immediate parent still scores high if many installed packages funnel into it
 * through longer chains. Cycles are handled via a per-root visited stamp.
 */
function computeTransitiveReach(nodes, adjacency) {
  const n = nodes.length
  const reach = new Int32Array(n)
  const visited = new Int32Array(n) // per-root stamp, avoids reallocating a Set
  const stack = []
  let stamp = 0
  for (let r = 0; r < n; r++) {
    if (!nodes[r].isDirect) continue
    stamp++
    stack.length = 0
    for (const d of adjacency[r]) {
      if (visited[d] !== stamp) {
        visited[d] = stamp
        stack.push(d)
      }
    }
    while (stack.length) {
      const cur = stack.pop()
      reach[cur] += 1
      for (const d of adjacency[cur]) {
        if (visited[d] !== stamp) {
          visited[d] = stamp
          stack.push(d)
        }
      }
    }
  }
  return reach
}

/**
 * Community detection via degree-weighted label propagation on the undirected
 * link structure. Each node starts with its own label and repeatedly adopts
 * the label with the highest summed vote among its neighbors, where a
 * neighbor's vote is damped by 1/sqrt(its degree). The damping is the point:
 * unweighted LPA lets super-hubs (used by half the library) vote everything
 * into one giant community, erasing exactly the mid-order structure we're
 * after. Weighted, a hub's label is nearly worthless while a handful of
 * mid-degree mutual neighbors dominate — communities form along "these
 * packages keep appearing together" correlations, not "everything touches the
 * same two super packages".
 *
 * Communities that are too small (noise) or too large (the hairball core —
 * gluing it together would just recreate the clump) get `undefined`, which
 * exempts those points from cosmos's cluster force.
 */
function detectCommunities(neighbors) {
  const n = neighbors.length
  const voteWeight = new Float32Array(n)
  for (let i = 0; i < n; i++) voteWeight[i] = 1 / Math.sqrt(Math.max(1, neighbors[i].length))
  const labels = new Int32Array(n)
  for (let i = 0; i < n; i++) labels[i] = i
  const order = Array.from({ length: n }, (_, i) => i)
  const counts = new Map()
  for (let iter = 0; iter < 12; iter++) {
    for (let i = n - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0
      const t = order[i]
      order[i] = order[j]
      order[j] = t
    }
    let changed = 0
    for (const v of order) {
      if (neighbors[v].length === 0) continue
      counts.clear()
      for (const u of neighbors[v]) counts.set(labels[u], (counts.get(labels[u]) ?? 0) + voteWeight[u])
      let best = labels[v]
      let bestCount = counts.get(best) ?? 0
      for (const [label, count] of counts) {
        if (count > bestCount) {
          best = label
          bestCount = count
        }
      }
      if (best !== labels[v]) {
        labels[v] = best
        changed++
      }
    }
    if (changed === 0) break
  }

  const sizes = new Map()
  for (let i = 0; i < n; i++) sizes.set(labels[i], (sizes.get(labels[i]) ?? 0) + 1)
  const maxSize = Math.max(50, n * 0.3)
  const remap = new Map()
  const clusters = new Array(n)
  for (let i = 0; i < n; i++) {
    const size = sizes.get(labels[i])
    if (size < 4 || size > maxSize) continue
    if (!remap.has(labels[i])) remap.set(labels[i], remap.size)
    clusters[i] = remap.get(labels[i])
  }

  // `core` = original community members. The remaining connective tissue is
  // then absorbed into whichever community its weighted neighbors mostly live
  // in (two passes so chains attach too). Absorbed nodes get a weaker cluster
  // pull later — they belong *near* a constellation, not *in* it — but without
  // any membership they all sag into the center of the space, which reads as
  // the central mush we're trying to kill.
  const core = clusters.map((c) => c !== undefined)
  for (let pass = 0; pass < 2; pass++) {
    for (let v = 0; v < n; v++) {
      if (clusters[v] !== undefined) continue
      counts.clear()
      for (const u of neighbors[v]) {
        if (clusters[u] === undefined) continue
        counts.set(clusters[u], (counts.get(clusters[u]) ?? 0) + voteWeight[u])
      }
      let best
      let bestCount = 0
      for (const [label, count] of counts) {
        if (count > bestCount) {
          best = label
          bestCount = count
        }
      }
      if (best !== undefined) clusters[v] = best
    }
  }
  return { clusters, core, clusterCount: remap.size }
}

/**
 * Flatten the whole-library graph into the typed arrays cosmos expects:
 * positions [x,y,…], colors [r,g,b,a,…], sizes [s,…] and links [srcIdx,tgtIdx,…].
 * Node objects are annotated with `reach` (transitive dependents) in place so
 * hover can read them back by point index. Size scales with undirected
 * degree so each link fattens both ends.
 */
function buildGraphArrays(raw) {
  const nodes = raw.nodes
  const n = nodes.length
  const indexById = new Map()
  for (let i = 0; i < n; i++) indexById.set(nodes[i].id, i)

  const adjacency = Array.from({ length: n }, () => [])
  const neighbors = Array.from({ length: n }, () => [])
  // Per-node incident link indices (incoming dependents + outgoing deps).
  // Used on hover to brighten those links without greying out the rest.
  const incidentLinks = Array.from({ length: n }, () => [])
  const outDegree = new Int32Array(n)
  const inDegree = new Int32Array(n)
  const linkPairs = []
  for (const l of raw.links) {
    const s = indexById.get(l.source)
    const t = indexById.get(l.target)
    if (s === undefined || t === undefined) continue
    adjacency[s].push(t)
    neighbors[s].push(t)
    neighbors[t].push(s)
    const linkIndex = linkPairs.length / 2
    incidentLinks[s].push(linkIndex)
    incidentLinks[t].push(linkIndex)
    outDegree[s]++
    inDegree[t]++
    linkPairs.push(s, t)
  }

  const reach = computeTransitiveReach(nodes, adjacency)
  const { clusters, core, clusterCount } = detectCommunities(neighbors)

  // Each link contributes to both ends: packages that depend on many things
  // and packages many things depend on both read as larger.
  const degree = new Int32Array(n)
  for (let i = 0; i < linkPairs.length; i += 2) {
    degree[linkPairs[i]]++
    degree[linkPairs[i + 1]]++
  }

  // Per-link spring strength — this is where the layout's structure actually
  // lives (see the engine-facts header). Uniform springs collapse a
  // small-world graph into one ball, so each link is weighted by what it
  // means, as a product of four factors:
  // - minDamp (smaller endpoint degree): a unique dependency stays strong and
  //   snaps to its parent (first-order clustering reads instantly); hub-hub
  //   links go weak. Cosmos's d3-style bias makes the light end do the
  //   moving, so parents aren't dragged by their satellites.
  // - hubDamp (larger endpoint degree past ~32): a supernode gets one pull
  //   per dependent, so even damped links sum to a degree-proportional
  //   advantage; this flattens that aggregate so mid-tier structure competes.
  //   Also the only available stand-in for "big nodes repel more" — cosmos
  //   has no per-point repulsion mass.
  // - reelIn: stiffens low-degree links so private deps orbit near rest
  //   length instead of streaming leeward of the repulsion wind. 12 is the
  //   calm-sim compromise: closing the wind gap fully needs ~45+, which sits
  //   past the stability budget (heated gas — see header).
  // - community: intra-community links boosted (that's the structure that
  //   should read), cross-community nearly cut so repulsion can hold
  //   constellations apart, links touching unclustered tissue halfway.
  const linkStrengths = new Float32Array(linkPairs.length / 2)
  for (let i = 0; i < linkStrengths.length; i++) {
    const s = linkPairs[i * 2]
    const t = linkPairs[i * 2 + 1]
    const minDeg = Math.max(1, Math.min(degree[s], degree[t]))
    const minDamp = 1 / Math.sqrt(minDeg)
    const hubDamp = 1 / Math.pow(Math.max(1, Math.max(degree[s], degree[t]) / 32), 0.35)
    const reelIn = 1 + 12 / Math.pow(minDeg, 1.5)
    const cs = clusters[s]
    const ct = clusters[t]
    const community = cs !== undefined && cs === ct ? 1.5 : cs !== undefined && ct !== undefined ? 0.1 : 0.5
    linkStrengths[i] = minDamp * hubDamp * reelIn * community
  }

  // Seeding-only spiral: each community gets a home on a golden-angle spiral
  // (biggest outermost, so super-node neighborhoods start at maximum mutual
  // distance). These positions are NOT fed to the simulation — the cluster
  // force runs in centermass mode, pulling members toward wherever their
  // community actually floats. The spiral only decides where communities are
  // born; where they end up is earned by the physics.
  const clusterSizes = new Array(clusterCount).fill(0)
  for (const c of clusters) if (c !== undefined) clusterSizes[c]++
  const bySize = Array.from({ length: clusterCount }, (_, c) => c).sort((a, b) => clusterSizes[a] - clusterSizes[b])
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
  const clusterPositions = new Array(clusterCount * 2)
  bySize.forEach((c, rank) => {
    const r = SPACE_SIZE * 0.4 * Math.sqrt((rank + 0.5) / clusterCount)
    const a = rank * GOLDEN_ANGLE
    clusterPositions[c * 2] = SPACE_SIZE / 2 + r * Math.cos(a)
    clusterPositions[c * 2 + 1] = SPACE_SIZE / 2 + r * Math.sin(a)
  })

  // Per-point cluster-force strength (toward the community's own centermass —
  // we deliberately never call setClusterPositions: fixed anchors look fine
  // until you drag a node and it snaps back, which reads as rigged).
  // CRITICAL: low-degree nodes must get exactly 0, not "small". The cluster
  // force is a harmonic trap (see header), so any nonzero coefficient beats a
  // leaf's leash at range and produces the same equilibrium regardless of
  // magnitude: every satellite piled at the taut-leash point on the centroid
  // side of its parent. Zero is the only value that lets satellites arrange
  // around their parent by spring + repulsion alone. The force only steers
  // the connected skeleton (degree > 2) that defines where a community sits.
  const clusterStrengths = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (clusters[i] === undefined) clusterStrengths[i] = 0
    else if (core[i]) clusterStrengths[i] = Math.max(0, Math.min(1, (degree[i] - 2) / 12))
    else clusterStrengths[i] = degree[i] > 2 ? 0.2 : 0
  }

  // Radius each constellation needs to hold its members at star-field density.
  const communityRadius = clusterSizes.map((s) => Math.min(SPACE_SIZE * 0.06, 45 * Math.sqrt(s)))

  const positions = new Float32Array(n * 2)
  const colors = new Float32Array(n * 4)
  const sizes = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    // Seed near-final so the layout contracts into place instead of exploding
    // from a random cloud: hubs land dead on their constellation's anchor,
    // members scatter across the constellation's radius around them, absorbed
    // tissue starts at the average of its neighbors' anchors (i.e. between the
    // constellations it bridges), and only orphans get random positions.
    const home = clusters[i]
    if (home !== undefined) {
      const hx = clusterPositions[home * 2]
      const hy = clusterPositions[home * 2 + 1]
      // Orient each constellation: least-connected members face the graph
      // center, hubs face outward. If the community later migrates inward
      // (its connected side leads the way), its own loose periphery is
      // already in the path as a cushion.
      const inward = Math.atan2(SPACE_SIZE / 2 - hy, SPACE_SIZE / 2 - hx)
      const connectedness = Math.min(1, degree[i] / 24)
      const hubTight = core[i] && degree[i] > 30 ? 0.3 : 1
      const d = communityRadius[home] * Math.sqrt(Math.random()) * hubTight
      const a = inward + Math.PI * connectedness + (Math.random() - 0.5) * Math.PI
      positions[i * 2] = hx + d * Math.cos(a)
      positions[i * 2 + 1] = hy + d * Math.sin(a)
    } else {
      let sx = 0
      let sy = 0
      let m = 0
      for (const u of neighbors[i]) {
        const cu = clusters[u]
        if (cu === undefined) continue
        sx += clusterPositions[cu * 2]
        sy += clusterPositions[cu * 2 + 1]
        m++
      }
      if (m > 0) {
        positions[i * 2] = sx / m + (Math.random() - 0.5) * 600
        positions[i * 2 + 1] = sy / m + (Math.random() - 0.5) * 600
      } else {
        // Strays go in a central disc instead of anywhere in the box: nothing
        // pulls on them except weak gravity (which points here anyway), so
        // they sit as a pressurized cushion that constellations would have to
        // compress to merge in the middle.
        const d = SPACE_SIZE * 0.18 * Math.sqrt(Math.random())
        const a = Math.random() * Math.PI * 2
        positions[i * 2] = SPACE_SIZE / 2 + d * Math.cos(a)
        positions[i * 2 + 1] = SPACE_SIZE / 2 + d * Math.sin(a)
      }
    }

    const node = nodes[i]
    node.reach = reach[i]
    node.dependencies = outDegree[i]
    node.dependents = inDegree[i]
    const c = colorFor(node)
    colors[i * 4] = c[0]
    colors[i * 4 + 1] = c[1]
    colors[i * 4 + 2] = c[2]
    colors[i * 4 + 3] = c[3]

    // Middle-ground spread — hubs clearly bigger, but not dwarfing the rest.
    // Proportioned for the 8192 box (the earlier 16384-era sizes were ~2x the
    // area and read as overcrowding after the box shrank back): the star look
    // is the gap-to-node ratio, so thumbnails stay small next to rest lengths.
    sizes[i] = Math.min(24, 5.5 + Math.sqrt(degree[i]) * 1.35)
  }

  return {
    nodes,
    positions,
    colors,
    sizes,
    links: new Float32Array(linkPairs),
    linkStrengths,
    clusters,
    clusterStrengths,
    incidentLinks,
    linkCount: linkPairs.length / 2,
  }
}

function Slider({ label, value, min, max, step, onChange, format }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-text-tertiary">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-accent-blue"
      />
      <span className="w-11 shrink-0 text-right tabular-nums text-text-secondary">
        {format ? format(value) : value}
      </span>
    </label>
  )
}

/** Indices of nodes within `keepFraction` of the centroid (drops far outliers). */
function keepIndicesNearCentroid(pos, keepFraction = 0.95) {
  const n = pos.length / 2
  if (!n) return []
  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    cx += pos[i * 2]
    cy += pos[i * 2 + 1]
  }
  cx /= n
  cy /= n
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => {
    const da = (pos[a * 2] - cx) ** 2 + (pos[a * 2 + 1] - cy) ** 2
    const db = (pos[b * 2] - cx) ** 2 + (pos[b * 2 + 1] - cy) ** 2
    return da - db
  })
  return order.slice(0, Math.max(1, Math.floor(n * keepFraction)))
}

/** Fit the camera to all but the farthest `1 - keepFraction` nodes (centroid outliers). */
function fitViewTrimOutliers(graph, duration = 400, keepFraction = 0.95) {
  if (!graph) return
  const pos = graph.getPointPositions()
  if (!pos.length) return
  graph.fitViewByPointIndices(keepIndicesNearCentroid(pos, keepFraction), duration)
}

export default function DependencyGraphView() {
  const containerRef = useRef(null)
  const graphRef = useRef(null)
  const nodesRef = useRef([])
  const incidentLinksRef = useRef([])
  // Mutable RGBA/width buffers for hover intensity (cosmos keeps the reference).
  const linkColorsRef = useRef(null)
  const linkWidthsRef = useRef(null)
  // Tooltip is positioned imperatively (transform) so it can follow the node
  // every frame without re-rendering React while the sim runs.
  const tooltipRef = useRef(null)
  // Cosmos hover ring is hardcoded at 1.3× point size; we draw our own so it
  // sits on the thumbnail circle instead of outside it.
  const hoverRingRef = useRef(null)
  const hoverIndexRef = useRef(null)
  const rafRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [thumbsLoading, setThumbsLoading] = useState(false)
  const [hover, setHover] = useState(null)
  const [running, setRunning] = useState(true)
  const warningDismissed = useGraphStore((s) => s.warningDismissed)
  const dismissWarning = useGraphStore((s) => s.dismissWarning)
  const setParam = useGraphStore((s) => s.setParam)
  const resetParams = useGraphStore((s) => s.resetParams)
  const params = useGraphStore(
    useShallow((s) => ({
      gravity: s.gravity,
      center: s.center,
      repulsion: s.repulsion,
      friction: s.friction,
      linkSpring: s.linkSpring,
      linkDistance: s.linkDistance,
      collision: s.collision,
      collisionPadding: s.collisionPadding,
      cluster: s.cluster,
    })),
  )
  // When the sim naturally cools we reheat it so it never freezes on its own;
  // only an explicit Pause actually stops it. Drag deliberately does NOT punch
  // alpha up: we tried reheating on drag to make collision feel physical, but
  // since alpha scales every force globally it sends the whole layout flying
  // the moment you touch one node. Sleepy collision is the better trade.
  const pausedByUserRef = useRef(false)
  // Skip the delayed auto-fit if the user already moved the camera.
  const userTouchedZoomRef = useRef(false)
  // First 5s run with UI friction 0 (cosmos friction 1 = no damping) so the
  // layout can spread; then the slider value is applied.
  const frictionWarmupRef = useRef(true)
  const [stats, setStats] = useState({ nodes: 0, links: 0, direct: 0, deps: 0 })

  // Latest params for the one-shot create effect (avoids re-creating the graph).
  const paramsRef = useRef(params)
  paramsRef.current = params

  useEffect(() => {
    let cancelled = false
    let graph = null
    let refitTimer = 0
    ;(async () => {
      setLoading(true)
      setThumbsLoading(false)
      let raw
      try {
        raw = await window.api.packages.graph()
      } catch {
        if (!cancelled) setLoading(false)
        return
      }
      if (cancelled || !containerRef.current) return

      const p = paramsRef.current
      const built = buildGraphArrays(raw)
      nodesRef.current = built.nodes
      incidentLinksRef.current = built.incidentLinks
      const linkColors = new Float32Array(built.linkCount * 4)
      const linkWidths = new Float32Array(built.linkCount)
      for (let i = 0; i < built.linkCount; i++) {
        linkColors[i * 4] = LINK_COLOR[0]
        linkColors[i * 4 + 1] = LINK_COLOR[1]
        linkColors[i * 4 + 2] = LINK_COLOR[2]
        linkColors[i * 4 + 3] = LINK_COLOR[3]
        linkWidths[i] = LINK_DEFAULT_WIDTH
      }
      linkColorsRef.current = linkColors
      linkWidthsRef.current = linkWidths
      let emphasizedLinks = null

      const paintIncidentLinks = (incident) => {
        const g = graphRef.current
        const colors = linkColorsRef.current
        const widths = linkWidthsRef.current
        if (!g || !colors || !widths) return
        if (emphasizedLinks) {
          for (const li of emphasizedLinks) {
            colors[li * 4] = LINK_COLOR[0]
            colors[li * 4 + 1] = LINK_COLOR[1]
            colors[li * 4 + 2] = LINK_COLOR[2]
            colors[li * 4 + 3] = LINK_COLOR[3]
            widths[li] = LINK_DEFAULT_WIDTH
          }
        }
        emphasizedLinks = incident?.length ? incident : null
        if (emphasizedLinks) {
          for (const li of emphasizedLinks) {
            colors[li * 4] = LINK_HOVER_COLOR[0]
            colors[li * 4 + 1] = LINK_HOVER_COLOR[1]
            colors[li * 4 + 2] = LINK_HOVER_COLOR[2]
            colors[li * 4 + 3] = LINK_HOVER_COLOR[3]
            widths[li] = LINK_HOVER_WIDTH
          }
        }
        g.setLinkColors(colors)
        g.setLinkWidths(widths)
        // Snap — default 800ms color transition would lag behind the cursor.
        g.render(undefined, 0)
      }

      userTouchedZoomRef.current = false
      frictionWarmupRef.current = true
      const syncLinkStyleForZoom = () => {
        const currentGraph = graphRef.current
        const zoom = currentGraph?.getZoomLevel()
        if (!Number.isFinite(zoom)) return
        const style = linkStyleForZoom(zoom)
        currentGraph.setConfigPartial({
          linkOpacity: style.opacity,
          linkWidthScale: style.widthScale,
          linkVisibilityMinTransparency: style.fadeFloor,
        })
      }

      // Keep the tooltip and hover ring glued to the hovered node: track its live
      // position and reproject to screen space each frame (sim motion, pan & zoom).
      const positionHoverChrome = () => {
        rafRef.current = requestAnimationFrame(positionHoverChrome)
        const g = graphRef.current
        const tip = tooltipRef.current
        const ring = hoverRingRef.current
        const idx = hoverIndexRef.current
        if (!g || idx == null) {
          if (ring) ring.style.opacity = '0'
          return
        }
        const pos = g.getTrackedPointPositionsMap().get(idx)
        if (!pos) return
        const [sx, sy] = g.spaceToScreenPosition([pos[0], pos[1]])
        if (tip) tip.style.transform = `translate(${sx}px, ${sy}px)`
        if (ring) {
          // getPointRadiusByIndex returns cosmos "size" (diameter in space units);
          // pass half so spaceToScreenRadius's maxPointSize clamp stays correct.
          const spaceSize = g.getPointRadiusByIndex(idx)
          if (!(spaceSize > 0)) {
            ring.style.opacity = '0'
            return
          }
          const screenDiameter = g.spaceToScreenRadius(spaceSize / 2) * 2
          ring.style.width = `${screenDiameter}px`
          ring.style.height = `${screenDiameter}px`
          ring.style.transform = `translate(${sx - screenDiameter / 2}px, ${sy - screenDiameter / 2}px)`
          ring.style.opacity = '1'
        }
      }

      graph = new Graph(containerRef.current, {
        backgroundColor: BG,
        spaceSize: SPACE_SIZE,
        pointDefaultSize: 4,
        scalePointsOnZoom: true,
        // Built-in hover ring is fixed at 1.3× point size; we draw a matching
        // ring ourselves (see hoverRingRef) so it aligns with the thumbnail.
        renderHoveredPointRing: false,
        hoveredPointCursor: 'pointer',
        linkDefaultColor: '#3a3d4d',
        linkDefaultWidth: LINK_DEFAULT_WIDTH,
        linkWidthScale: LINK_WIDTH_SCALE,
        linkOpacity: LINK_OPACITY,
        scaleLinksOnZoom: SCALE_LINKS_ON_ZOOM,
        linkVisibilityDistanceRange: LINK_VISIBILITY_DISTANCE_RANGE,
        linkVisibilityMinTransparency: LINK_VISIBILITY_MIN_TRANSPARENCY,
        // Hover brightens link colors/widths; keep those updates instant.
        transitionDuration: 0,
        curvedLinks: false,
        // With the ALPHA_FLOOR reheat the sim never truly freezes; decay now
        // only sets how gently extra heat (slider changes) drains back to the
        // floor. Slow = no visible "kick" when params move.
        simulationDecay: 1000,
        simulationGravity: p.gravity,
        simulationCenter: p.center,
        simulationRepulsion: p.repulsion,
        simulationRepulsionTheta: 1.15,
        simulationLinkSpring: p.linkSpring,
        simulationLinkDistance: p.linkDistance,
        // Wide per-link length jitter breaks the equal-edge-length degeneracy
        // that makes repulsion-dominated layouts crystallize into hex foam.
        simulationLinkDistRandomVariationRange: [0.6, 2.2],
        // Warmup: no damping for the first 5s (restored in the timer below).
        simulationFriction: 1,
        simulationCollision: p.collision,
        simulationCollisionPadding: p.collisionPadding,
        simulationCluster: p.cluster,
        enableDrag: true,
        // Trimmed fit on init (seed positions), then again at 5s with live positions.
        fitViewOnInit: true,
        fitViewDelay: 0,
        fitViewDuration: 400,
        fitViewByPointIndices: keepIndicesNearCentroid(built.positions),
        onClick: (index) => {
          if (index == null) return
          userTouchedZoomRef.current = true
          graphRef.current?.zoomToPointByIndex(index)
        },
        onZoom: (_e, userDriven) => {
          if (userDriven) userTouchedZoomRef.current = true
          syncLinkStyleForZoom()
        },
        onPointMouseOver: (index) => {
          if (cancelled) return
          hoverIndexRef.current = index
          graphRef.current?.trackPointPositionsByIndices([index])
          paintIncidentLinks(incidentLinksRef.current[index])
          setHover(nodesRef.current[index] ?? null)
        },
        onPointMouseOut: () => {
          if (cancelled) return
          hoverIndexRef.current = null
          graphRef.current?.trackPointPositionsByIndices([])
          paintIncidentLinks(null)
          setHover(null)
        },
        onSimulationTick: (alpha) => {
          // Keep a gentle steady energy floor so it stays in motion without ever
          // cooling to a stop and getting punched back to full alpha.
          if (!pausedByUserRef.current && alpha < ALPHA_FLOOR) graphRef.current?.start(ALPHA_FLOOR)
        },
        onSimulationEnd: () => {
          if (!cancelled && !pausedByUserRef.current) graphRef.current?.start(ALPHA_FLOOR)
        },
      })
      graphRef.current = graph

      graph.setPointPositions(built.positions)
      graph.setPointColors(built.colors)
      graph.setPointSizes(built.sizes)
      graph.setLinks(built.links)
      graph.setLinkStrength(built.linkStrengths)
      graph.setLinkColors(linkColors)
      graph.setLinkWidths(linkWidths)
      graph.setPointClusters(built.clusters)
      graph.setPointClusterStrength(built.clusterStrengths)
      // Cold start at the alpha floor: seeding is near-final so no annealing
      // is needed, and the stiff leaf springs are only stable when
      // strength × alpha stays below ~1 (cosmos's default start alpha of 1.0
      // would catapult stretched links across the map).
      graph.render(ALPHA_FLOOR)
      syncLinkStyleForZoom()
      rafRef.current = requestAnimationFrame(positionHoverChrome)
      // After warmup: restore slider friction, and refit unless the user already
      // panned/zoomed, fitted, or zoomed to a node.
      refitTimer = setTimeout(() => {
        if (cancelled) return
        frictionWarmupRef.current = false
        const g = graphRef.current
        if (!g) return
        g.setConfigPartial({ simulationFriction: 1 - paramsRef.current.friction })
        if (!userTouchedZoomRef.current) fitViewTrimOutliers(g, 400)
      }, 5000)

      if (!cancelled) {
        setStats({
          nodes: built.nodes.length,
          links: built.linkCount,
          direct: built.nodes.filter((n) => n.isDirect).length,
          deps: built.nodes.filter((n) => !n.isDirect).length,
        })
        setRunning(true)
        setLoading(false)
        setThumbsLoading(true)
      }

      // Route 1 — native GPU point images. Decode every node's thumbnail into one
      // image atlas cosmos renders on the points. Index 0 is a transparent
      // placeholder, so nodes without art just keep their colored dot.
      const thumbKeys = built.nodes.map((n) => `pkg:${n.id}`)
      let results = {}
      try {
        results = await window.api.thumbnails.getGraph(thumbKeys)
      } catch {
        if (!cancelled) setThumbsLoading(false)
        return
      }
      if (cancelled) return

      const images = [new ImageData(1, 1)]
      const imageIndices = new Float32Array(built.nodes.length)
      await mapLimit(built.nodes, 48, async (node, i) => {
        const border = node.isDirect ? BORDER_DIRECT : BORDER_DEP
        const data = await bufferToImageData(results[`pkg:${node.id}`], border)
        if (cancelled || !data) return
        imageIndices[i] = images.length
        images.push(data)
      })
      if (cancelled || !graphRef.current) return
      graphRef.current.setImageData(images)
      graphRef.current.setPointImageIndices(imageIndices)
      graphRef.current.render(undefined, 0)
      if (!cancelled) setThumbsLoading(false)
    })()

    return () => {
      cancelled = true
      clearTimeout(refitTimer)
      cancelAnimationFrame(rafRef.current)
      graphRef.current?.destroy()
      graphRef.current = null
    }
  }, [])

  // Live physics tuning — push changes to the running sim and reheat.
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    graph.setConfigPartial({
      simulationGravity: params.gravity,
      simulationCenter: params.center,
      simulationRepulsion: params.repulsion,
      simulationFriction: frictionWarmupRef.current ? 1 : 1 - params.friction,
      simulationLinkSpring: params.linkSpring,
      simulationLinkDistance: params.linkDistance,
      simulationCollision: params.collision,
      simulationCollisionPadding: params.collisionPadding,
      simulationCluster: params.cluster,
    })
    pausedByUserRef.current = false
    graph.start(ALPHA_FLOOR)
    setRunning(true)
  }, [
    params.gravity,
    params.center,
    params.repulsion,
    params.friction,
    params.linkSpring,
    params.linkDistance,
    params.collision,
    params.collisionPadding,
    params.cluster,
  ])

  const toggleRunning = () => {
    const graph = graphRef.current
    if (!graph) return
    if (running) {
      pausedByUserRef.current = true
      graph.pause()
      setRunning(false)
    } else {
      pausedByUserRef.current = false
      graph.start(ALPHA_FLOOR)
      setRunning(true)
    }
  }

  const fitView = () => {
    userTouchedZoomRef.current = true
    fitViewTrimOutliers(graphRef.current, 400)
  }
  const set = (key) => (value) => setParam(key, value)

  return (
    <div className="relative h-full w-full bg-base">
      <div ref={containerRef} className="absolute inset-0" />

      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-text-secondary">
          <Loader2 size={16} className="animate-spin" />
          Building graph…
        </div>
      )}

      {thumbsLoading && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-md border border-accent-blue/40 bg-elevated px-4 py-2 text-sm font-medium text-text-primary shadow-lg shadow-black/40 ring-1 ring-white/10">
            <Loader2 size={15} className="animate-spin text-accent-blue" />
            Loading thumbnails…
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-xs rounded-md bg-elevated/90 px-3 py-2 text-xs text-text-secondary shadow-sm">
        <div className="mb-1.5 font-medium text-text-primary">Dependency graph</div>
        {!warningDismissed && (
          <div className="pointer-events-auto mb-2 flex items-start gap-2 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-text-secondary leading-snug">
            <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warning/70" />
            <span className="min-w-0 flex-1">
              Experimental — have fun and mess around with your library. May be removed in future versions. If you think
              it&apos;s cool, it would be nice if you shared what your library constellation looks like.
            </span>
            <button
              type="button"
              onClick={dismissWarning}
              title="Dismiss"
              className="-mr-0.5 -mt-0.5 shrink-0 cursor-pointer rounded p-0.5 text-text-tertiary hover:bg-white/10 hover:text-text-primary"
            >
              <X size={12} />
            </button>
          </div>
        )}
        <div className="mb-2 text-text-tertiary leading-snug">Every enabled package as one force field</div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent-blue" />
            Direct ({stats.direct})
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-text-tertiary" />
            Dependency ({stats.deps})
          </div>
          <div className="mt-1 text-text-tertiary">
            {stats.nodes} nodes · {stats.links} links
          </div>
          <div className="text-text-tertiary">Bigger = more links (dependencies + dependents)</div>
        </div>
      </div>

      <div className="absolute right-3 top-3 z-10 flex w-64 flex-col gap-2 rounded-md bg-elevated/90 px-3 py-2.5 text-xs shadow-sm">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1 font-medium text-text-primary">Physics</div>
          <button
            type="button"
            onClick={resetParams}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-text-secondary hover:bg-white/5 hover:text-text-primary"
            title="Reset physics to defaults"
          >
            <RotateCcw size={13} />
            Reset
          </button>
          <button
            type="button"
            onClick={toggleRunning}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-text-secondary hover:bg-white/5 hover:text-text-primary"
            title={running ? 'Pause layout' : 'Resume layout'}
          >
            {running ? <Pause size={13} /> : <Play size={13} />}
            {running ? 'Pause' : 'Resume'}
          </button>
          <button
            type="button"
            onClick={fitView}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-text-secondary hover:bg-white/5 hover:text-text-primary"
            title="Fit to view"
          >
            <Maximize2 size={13} />
            Fit
          </button>
        </div>
        <Slider
          label="Friction"
          value={params.friction}
          min={0}
          max={1}
          step={0.01}
          onChange={set('friction')}
          format={(v) => v.toFixed(2)}
        />
        <Slider
          label="Repulsion"
          value={params.repulsion}
          min={0}
          max={200}
          step={0.5}
          onChange={set('repulsion')}
          format={(v) => v.toFixed(1)}
        />
        <Slider
          label="Link pull"
          value={params.linkSpring}
          min={0}
          max={2}
          step={0.05}
          onChange={set('linkSpring')}
          format={(v) => v.toFixed(2)}
        />
        <Slider
          label="Link dist"
          value={params.linkDistance}
          min={2}
          max={200}
          step={1}
          onChange={set('linkDistance')}
        />
      </div>

      <div className="pointer-events-none absolute bottom-3 right-4 z-10 select-none text-2xl font-bold tracking-tight text-white/[0.10]">
        VaM Backstage
      </div>

      <div
        ref={hoverRingRef}
        className="pointer-events-none absolute left-0 top-0 z-10 box-border rounded-full border-2 border-white"
        style={{
          opacity: 0,
          transform: 'translate(-9999px, -9999px)',
          willChange: 'transform, width, height, opacity',
        }}
      />

      <div
        ref={tooltipRef}
        className="pointer-events-none absolute left-0 top-0 z-20"
        style={{ transform: 'translate(-9999px, -9999px)', willChange: 'transform' }}
      >
        {hover && (
          <div
            className="max-w-xs rounded-md bg-elevated/50 px-2.5 py-1.5 text-center text-xs shadow-md ring-1 ring-white/10 backdrop-blur-sm"
            style={{ transform: 'translate(-50%, calc(-100% - 12px))' }}
          >
            <div className="truncate text-text-primary">{hover.packageName}</div>
            {(hover.dependencies > 0 || hover.dependents > 0) && (
              <div className="truncate text-text-tertiary">
                {hover.dependencies} {hover.dependencies === 1 ? 'dependency' : 'dependencies'}
                {' · '}
                {hover.dependents} {hover.dependents === 1 ? 'dependent' : 'dependents'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
