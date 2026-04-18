import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const master = resolve(root, 'resources/icon.png')

// Each target is one .ico with its own set of sizes.
// Packing more sizes means Windows picks a native tile instead of running
// its own (poor) downscaler on the 256px tile. Odd sizes (30/36/40/60/72/96)
// cover DPI-scaled taskbar/Explorer/Start-menu requests on 125%/150%/175%
// displays. installerHeaderIcon is the SpiderBanner overlay shown in the
// oneClick installer window; SpiderBanner renders it around ~100px.
const targets = [
  {
    out: 'build/icon.ico',
    sizes: [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256],
  },
  {
    out: 'build/installerIcon.ico',
    sizes: [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256],
  },
  {
    out: 'build/uninstallerIcon.ico',
    sizes: [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256],
  },
  {
    out: 'build/installerHeaderIcon.ico',
    sizes: [32, 48, 64, 96, 128, 256],
  },
]

const { width, height } = await sharp(master).metadata()
if (width !== height) {
  throw new Error(`master icon must be square, got ${width}x${height}`)
}
if (width < 256) {
  throw new Error(`master icon must be at least 256px, got ${width}`)
}
console.log(`master: ${master} (${width}x${height})`)

const pngCache = new Map()
async function pngFor(size) {
  if (!pngCache.has(size)) {
    pngCache.set(
      size,
      sharp(master).resize(size, size, { kernel: 'lanczos3', fit: 'contain' }).png({ compressionLevel: 9 }).toBuffer(),
    )
  }
  return pngCache.get(size)
}

for (const { out, sizes } of targets) {
  const outPath = resolve(root, out)
  const pngs = await Promise.all(sizes.map(pngFor))
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, await pngToIco(pngs))
  console.log(`wrote ${out} (${sizes.join(', ')} px)`)
}
