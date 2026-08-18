import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import { PNG } from 'pngjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '..')
const sourcePath = join(repositoryRoot, 'assets', 'coomi-desktop.png')
const resourcesRoot = join(desktopRoot, 'resources')
const inlineMarkPath = join(
  repositoryRoot,
  'packages', 'client', 'ui-primitives', 'src', 'coomi-mark.ts',
)

function resizeContain(source, size) {
  const destination = new PNG({ width: size, height: size })
  const scale = Math.min(size / source.width, size / source.height)
  const drawnWidth = Math.max(1, Math.round(source.width * scale))
  const drawnHeight = Math.max(1, Math.round(source.height * scale))
  const offsetX = Math.floor((size - drawnWidth) / 2)
  const offsetY = Math.floor((size - drawnHeight) / 2)

  for (let y = 0; y < drawnHeight; y += 1) {
    const sourceY = ((y + 0.5) * source.height / drawnHeight) - 0.5
    const y0 = Math.max(0, Math.floor(sourceY))
    const y1 = Math.min(source.height - 1, y0 + 1)
    const fy = sourceY - Math.floor(sourceY)
    for (let x = 0; x < drawnWidth; x += 1) {
      const sourceX = ((x + 0.5) * source.width / drawnWidth) - 0.5
      const x0 = Math.max(0, Math.floor(sourceX))
      const x1 = Math.min(source.width - 1, x0 + 1)
      const fx = sourceX - Math.floor(sourceX)
      const samples = [
        [x0, y0, (1 - fx) * (1 - fy)],
        [x1, y0, fx * (1 - fy)],
        [x0, y1, (1 - fx) * fy],
        [x1, y1, fx * fy],
      ]
      let alpha = 0
      let red = 0
      let green = 0
      let blue = 0
      for (const [sampleX, sampleY, weight] of samples) {
        const index = ((sampleY * source.width) + sampleX) * 4
        const sampleAlpha = source.data[index + 3] / 255
        const weightedAlpha = weight * sampleAlpha
        alpha += weightedAlpha
        red += source.data[index] * weightedAlpha
        green += source.data[index + 1] * weightedAlpha
        blue += source.data[index + 2] * weightedAlpha
      }
      const destinationIndex = (((y + offsetY) * size) + x + offsetX) * 4
      destination.data[destinationIndex] = alpha === 0 ? 0 : Math.round(red / alpha)
      destination.data[destinationIndex + 1] = alpha === 0 ? 0 : Math.round(green / alpha)
      destination.data[destinationIndex + 2] = alpha === 0 ? 0 : Math.round(blue / alpha)
      destination.data[destinationIndex + 3] = Math.round(alpha * 255)
    }
  }
  return PNG.sync.write(destination)
}

const source = PNG.sync.read(await readFile(sourcePath))
const largePng = resizeContain(source, 1024)
const mediumPng = resizeContain(source, 256)
await writeFile(join(resourcesRoot, 'coomi-agent.png'), largePng)
await writeFile(join(resourcesRoot, 'coomi-256.png'), mediumPng)

const layerDirectory = await mkdtemp(join(tmpdir(), 'coomi-icon-layers-'))
try {
  const layerPaths = []
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const layerPath = join(layerDirectory, `coomi-${String(size)}.png`)
    await writeFile(layerPath, resizeContain(source, size))
    layerPaths.push(layerPath)
  }
  await writeFile(join(resourcesRoot, 'coomi.ico'), await pngToIco(layerPaths))
} finally {
  await rm(layerDirectory, { recursive: true, force: true })
}

const inlineSource = await readFile(inlineMarkPath, 'utf8')
const declaration = `export const COOMI_AGENT_DATA_URI = 'data:image/png;base64,${largePng.toString('base64')}'`
const inlineDeclarationPattern = /export const COOMI_AGENT_DATA_URI = 'data:image\/png;base64,[^']*'/
if (!inlineDeclarationPattern.test(inlineSource)) {
  throw new Error(`inline Coomi mark declaration not found at ${inlineMarkPath}`)
}
const updatedInlineSource = inlineSource.replace(inlineDeclarationPattern, declaration)
await writeFile(inlineMarkPath, updatedInlineSource)
