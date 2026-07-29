import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import pMap from 'p-map'
import { resolveConfig, type SiteConfig } from '../config'
import { disposeMdItInstance } from '../markdown/markdown'
import { clearCache } from '../markdownToVue'
import { slash, type HeadConfig, type SSGContext } from '../shared'
import { deserializeFunctions, serializeFunctions } from '../utils/fnSerialize'
import {
  restoreGitTimestamps,
  snapshotGitTimestamps
} from '../utils/getGitTimestamp'
import { nativeImport } from '../utils/nativeImport'
import { bundle, cache, cacheTheme } from './bundle'
import {
  createRenderMetadata,
  deserializeRenderMetadata,
  renderPage,
  serializeRenderMetadata,
  type RenderMetadata
} from './render'

export function disposeBuildCaches() {
  clearCache()
  disposeMdItInstance()
  cache.clear()
  cacheTheme.clear()
  globalThis.gc?.()
}

function createAdditionalHeadTags(
  renderMetadata: RenderMetadata
): HeadConfig[] {
  const additionalHeadTags: HeadConfig[] = []
  if (renderMetadata.isDefaultTheme) {
    const fontURL = renderMetadata.assets.find((file) =>
      /inter-roman-latin\.[\w-]+\.woff2/.test(file)
    )
    if (fontURL) {
      additionalHeadTags.push([
        'link',
        {
          rel: 'preload',
          href: fontURL,
          as: 'font',
          type: 'font/woff2',
          crossorigin: ''
        }
      ])
    }
  }
  return additionalHeadTags
}

function generateMetadataScript(
  pageToHashMap: Record<string, string>,
  config: SiteConfig
) {
  if (config.mpa) {
    return { html: '', inHead: false }
  }

  // We embed the hash map and site config strings into each page directly
  // so that it doesn't alter the main chunk's hash on every build.
  // It's also embedded as a string and JSON.parsed from the client because
  // it's faster than embedding as JS object literal.
  const hashMapString = JSON.stringify(JSON.stringify(pageToHashMap))
  const siteDataString = JSON.stringify(
    JSON.stringify(serializeFunctions({ ...config.site, head: [] }))
  )

  const metadataContent = `window.__VP_HASH_MAP__=JSON.parse(${hashMapString});${
    siteDataString.includes('_vp-fn_')
      ? `${deserializeFunctions};window.__VP_SITE_DATA__=deserializeFunctions(JSON.parse(${siteDataString}));`
      : `window.__VP_SITE_DATA__=JSON.parse(${siteDataString});`
  }`

  const metadataFile = path.join(
    config.assetsDir,
    'chunks',
    `metadata.${createHash('sha256')
      .update(metadataContent)
      .digest('hex')
      .slice(0, 8)}.js`
  )

  const resolvedMetadataFile = path.join(config.outDir, metadataFile)
  const metadataFileURL = slash(`${config.site.base}${metadataFile}`)

  fs.mkdirSync(path.dirname(resolvedMetadataFile), { recursive: true })
  fs.writeFileSync(resolvedMetadataFile, metadataContent)

  return {
    html: `<script type="module" src="${metadataFileURL}"></script>`,
    inHead: true
  }
}

export function prepareRenderInputs(
  siteConfig: SiteConfig,
  clientResult: Parameters<typeof createRenderMetadata>[1],
  serverResult: Parameters<typeof createRenderMetadata>[2],
  pageToHashMap: Record<string, string>
) {
  const renderMetadata = createRenderMetadata(
    siteConfig,
    clientResult,
    serverResult
  )
  return {
    renderMetadata,
    additionalHeadTags: createAdditionalHeadTags(renderMetadata),
    metadataScript: generateMetadataScript(pageToHashMap, siteConfig)
  }
}

export async function getRenderer(tempDir: string) {
  const { render } = await nativeImport(path.join(tempDir, 'app.js'))
  return render as (path: string) => Promise<SSGContext>
}

export async function renderPages(
  render: (path: string) => Promise<SSGContext>,
  siteConfig: SiteConfig,
  serverTempDir: string,
  pages: string[],
  renderMetadata: RenderMetadata,
  pageToHashMap: Record<string, string>,
  metadataScript: { html: string; inHead: boolean },
  additionalHeadTags: HeadConfig[],
  usedIcons: Set<string>
) {
  await pMap(
    pages,
    async (page) => {
      await renderPage(
        render,
        siteConfig,
        siteConfig.rewrites.map[page] || page,
        renderMetadata,
        pageToHashMap,
        metadataScript,
        additionalHeadTags,
        usedIcons,
        serverTempDir
      )
    },
    { concurrency: siteConfig.buildConcurrency }
  )
}

interface _BaseMessage {
  root: string
  base: string
  outDir: string
  contractPath: string
  buildOptions: any
  precomputedPages: Pick<SiteConfig, 'pages' | 'dynamicRoutes' | 'rewrites'>
}

export interface ClientBuildMessage extends _BaseMessage {
  type: 'client-build'
}

export interface SsrBatchMessage extends _BaseMessage {
  type: 'ssr-batch'
  offset: number
  pages: string[]
  serverPages: string[]
}

export async function runClientBuild(message: ClientBuildMessage) {
  const siteConfig = await resolveConfig(
    message.root,
    'build',
    'production',
    message.precomputedPages
  )
  siteConfig.site.base = message.base
  siteConfig.outDir = message.outDir

  try {
    const { clientResult, serverResult, pageToHashMap } = await bundle(
      siteConfig,
      message.buildOptions
    )

    const { renderMetadata, additionalHeadTags, metadataScript } =
      prepareRenderInputs(siteConfig, clientResult, serverResult, pageToHashMap)
    const gitTimestamps = snapshotGitTimestamps()

    fs.writeFileSync(
      message.contractPath,
      JSON.stringify({
        renderMetadata: serializeRenderMetadata(renderMetadata),
        pageToHashMap,
        metadataScript,
        additionalHeadTags,
        gitTimestamps
      })
    )
  } finally {
    disposeBuildCaches()
  }
}

export async function runSsrBatch(message: SsrBatchMessage): Promise<string[]> {
  const siteConfig = await resolveConfig(
    message.root,
    'build',
    'production',
    message.precomputedPages
  )
  const contract = JSON.parse(fs.readFileSync(message.contractPath, 'utf-8'))

  siteConfig.site.base = message.base
  siteConfig.outDir = message.outDir
  siteConfig.ssrBuildBatchSize = undefined

  restoreGitTimestamps(contract.gitTimestamps)

  fs.mkdirSync(siteConfig.tempDir, { recursive: true })
  const batchTempDir = fs.mkdtempSync(
    path.join(siteConfig.tempDir, `ssr-${message.offset}-`)
  )
  siteConfig.tempDir = batchTempDir
  const usedIcons = new Set<string>()

  try {
    await bundle(siteConfig, message.buildOptions, {
      pages: message.serverPages,
      tempDir: batchTempDir
    })
    disposeBuildCaches()
    const render = await getRenderer(batchTempDir)

    await renderPages(
      render,
      siteConfig,
      batchTempDir,
      message.pages,
      deserializeRenderMetadata(contract.renderMetadata),
      contract.pageToHashMap,
      contract.metadataScript,
      contract.additionalHeadTags,
      usedIcons
    )
  } finally {
    disposeBuildCaches()
    if (!process.env.DEBUG) {
      fs.rmSync(batchTempDir, { recursive: true, force: true })
    }
  }

  return [...usedIcons].sort()
}
