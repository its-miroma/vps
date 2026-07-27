import { getIconsCSS } from '@iconify/utils'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pMap from 'p-map'
import { packageDirectorySync } from 'package-directory'
import type { BuildOptions } from 'vite'
import { resolveConfig, type SiteConfig } from '../config'
import { disposeMdItInstance } from '../markdown/markdown'
import { clearCache } from '../markdownToVue'
import {
  slash,
  type Awaitable,
  type HeadConfig,
  type SSGContext
} from '../shared'
import { deserializeFunctions, serializeFunctions } from '../utils/fnSerialize'
import {
  restoreGitTimestamps,
  snapshotGitTimestamps
} from '../utils/getGitTimestamp'
import { nativeImport } from '../utils/nativeImport'
import { task } from '../utils/task'
import { bundle, cache, cacheTheme } from './bundle'
import { generateSitemap } from './generateSitemap'
import {
  createRenderMetadata,
  deserializeRenderMetadata,
  renderPage,
  serializeRenderMetadata,
  type RenderMetadata
} from './render'

const require = createRequire(import.meta.url)

function disposeBuildCaches() {
  clearCache()
  disposeMdItInstance()
  cache.clear()
  cacheTheme.clear()
  // TODO: globalThis.gc?.() ?
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

async function renderPages(
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

function findNonJsonValue(
  value: any,
  path2 = 'buildOptions',
  seen = new Set()
): string | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : path2
  }
  if (typeof value !== 'object') {
    return path2
  }
  if (seen.has(value)) return path2
  seen.add(value)
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return path2
  }
  for (const [key, nested] of Object.entries(value)) {
    const invalidPath = findNonJsonValue(nested, `${path2}.${key}`, seen)
    if (invalidPath) return invalidPath
  }
  seen.delete(value)
}

function workerExecArgv() {
  const result: string[] = []
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index]
    if (!argument.startsWith('--inspect')) {
      result.push(argument)
      continue
    }
    if (
      (argument === '--inspect-port' || argument === '--inspect-publish-uid') &&
      index + 1 < process.execArgv.length
    ) {
      index++
    }
  }
  return result
}

interface _BaseMessage {
  root: string
  base: string
  outDir: string
  contractPath: string
  buildOptions: any
  precomputedPages: Pick<SiteConfig, 'pages' | 'dynamicRoutes' | 'rewrites'>
}

interface ClientBuildMessage extends _BaseMessage {
  type: 'client-build'
}

interface SsrBatchMessage extends _BaseMessage {
  type: 'ssr-batch'
  offset: number
  pages: string[]
  serverPages: string[]
}

function dispatchWorker(
  message: ClientBuildMessage | SsrBatchMessage
): Promise<{ icons?: string[] }> {
  const workerEntry = fileURLToPath(new URL('./ssr-worker.js', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = fork(workerEntry, {
      cwd: process.cwd(),
      execArgv: workerExecArgv(),
      stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    })
    let icons: string[] | undefined
    child.on('message', (message: any) => {
      if (message?.type === 'icons') icons = message.icons
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve({ icons })
      } else {
        reject(
          new Error(
            `Batch worker failed (${signal ? `signal ${signal}` : `exit ${code}`}).`
          )
        )
      }
    })
    child.send(message)
  })
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

    const renderMetadata = createRenderMetadata(
      siteConfig,
      clientResult,
      serverResult
    )
    const additionalHeadTags = createAdditionalHeadTags(renderMetadata)
    const metadataScript = generateMetadataScript(pageToHashMap, siteConfig)
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
    globalThis.gc?.()
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
    globalThis.gc?.()

    const entryPath = path.join(batchTempDir, 'app.js')
    const { render } = await nativeImport(entryPath)

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
    globalThis.gc?.()
    if (!process.env.DEBUG) {
      fs.rmSync(batchTempDir, { recursive: true, force: true })
    }
  }

  return [...usedIcons].sort()
}

export async function build(
  root?: string,
  buildOptions: BuildOptions & {
    base?: string
    mpa?: string
    __vitepressCli?: boolean
    onAfterConfigResolve?: (siteConfig: SiteConfig) => Awaitable<void>
  } = {}
) {
  const start = Date.now()

  process.env.NODE_ENV = 'production'

  const invokedFromCli = buildOptions.__vitepressCli === true
  delete buildOptions.__vitepressCli

  const hasAfterConfigResolve =
    typeof buildOptions.onAfterConfigResolve === 'function'
  const siteConfig = await resolveConfig(root, 'build', 'production')

  await buildOptions.onAfterConfigResolve?.(siteConfig)
  delete buildOptions.onAfterConfigResolve

  if (buildOptions.base) {
    siteConfig.site.base = buildOptions.base
    delete buildOptions.base
  }

  if (buildOptions.mpa) {
    siteConfig.mpa = true
    delete buildOptions.mpa
  }

  if (buildOptions.outDir) {
    siteConfig.outDir = path.resolve(process.cwd(), buildOptions.outDir)
    delete buildOptions.outDir
  }

  if (
    siteConfig.ssrBuildBatchSize != null &&
    (!Number.isInteger(siteConfig.ssrBuildBatchSize) ||
      siteConfig.ssrBuildBatchSize < 1)
  ) {
    throw new Error('ssrBuildBatchSize must be a positive integer.')
  }

  if (siteConfig.mpa && siteConfig.ssrBuildBatchSize) {
    throw new Error('ssrBuildBatchSize is not compatible with MPA mode.')
  }

  if (process.env.BUNDLE_ONLY && siteConfig.ssrBuildBatchSize) {
    throw new Error(
      'BUNDLE_ONLY is not compatible with ssrBuildBatchSize because batched server bundles are rendered and disposed incrementally.'
    )
  }

  if (
    hasAfterConfigResolve &&
    !invokedFromCli &&
    siteConfig.ssrBuildBatchSize
  ) {
    throw new Error(
      'onAfterConfigResolve is not compatible with ssrBuildBatchSize because functions cannot be transferred to SSR batch worker processes.'
    )
  }

  if (siteConfig.ssrBuildBatchSize) {
    const invalidBuildOption = findNonJsonValue(buildOptions)
    if (invalidBuildOption) {
      throw new Error(
        `${invalidBuildOption} is not JSON-serializable and cannot be transferred to SSR batch worker processes.`
      )
    }

    const batchCount = Math.ceil(
      (siteConfig.pages.length + 1) / siteConfig.ssrBuildBatchSize
    )
    if (batchCount > 50) {
      siteConfig.logger.warn(
        `ssrBuildBatchSize is ${siteConfig.ssrBuildBatchSize}, which will spawn ${batchCount} worker processes for this build. ` +
          `Each worker pays a fixed startup cost (roughly 100-200MB of memory and a couple of seconds) regardless of batch size, ` +
          `so a lot of small batches trades build time for little or no extra memory savings. Consider a larger ssrBuildBatchSize ` +
          `(aiming for roughly 10-30 batches total) unless you've confirmed smaller batches are needed to stay under your memory budget.`
      )
    }
    siteConfig.logger.info(
      `ssrBuildBatchSize is set: this limits memory for the server/SSR bundling + rendering step only. ` +
        `The client bundle is still built once, in a single process, covering every page.`
    )
  }

  const unlinkVue = linkVue()

  try {
    const usedIcons = /* @__PURE__ */ new Set<string>()
    let pageToHashMap: Record<string, string>

    if (siteConfig.ssrBuildBatchSize) {
      const precomputedPages: Pick<
        SiteConfig,
        'pages' | 'dynamicRoutes' | 'rewrites'
      > = {
        pages: siteConfig.pages,
        dynamicRoutes: siteConfig.dynamicRoutes,
        rewrites: siteConfig.rewrites
      }

      fs.mkdirSync(siteConfig.tempDir, { recursive: true })
      const coordinatorDir = fs.mkdtempSync(
        path.join(siteConfig.tempDir, 'ssr-coordinator-')
      )
      const contractPath = path.join(coordinatorDir, 'contract.json')

      await dispatchWorker({
        type: 'client-build',
        root: siteConfig.root,
        base: siteConfig.site.base,
        outDir: siteConfig.outDir,
        contractPath,
        buildOptions,
        precomputedPages
      })

      const contract = JSON.parse(fs.readFileSync(contractPath, 'utf-8'))
      pageToHashMap = contract.pageToHashMap

      const renderQueue = ['404.md', ...siteConfig.pages]
      const sourcePages = new Set(siteConfig.pages)

      await task('building server bundles + rendering pages', async () => {
        for (
          let offset = 0;
          offset < renderQueue.length;
          offset += siteConfig.ssrBuildBatchSize!
        ) {
          const pages = renderQueue.slice(
            offset,
            offset + siteConfig.ssrBuildBatchSize!
          )
          const serverPages = [
            ...new Set(pages.filter((page) => sourcePages.has(page)))
          ]

          const { icons } = await dispatchWorker({
            type: 'ssr-batch',
            root: siteConfig.root,
            base: siteConfig.site.base,
            outDir: siteConfig.outDir,
            offset,
            pages,
            serverPages,
            contractPath,
            buildOptions,
            precomputedPages
          })

          for (const icon of icons ?? []) {
            usedIcons.add(icon)
          }
        }
      })
    } else {
      let {
        clientResult,
        serverResult,
        pageToHashMap: unbatchedPageToHashMap
      } = await bundle(siteConfig, buildOptions)
      pageToHashMap = unbatchedPageToHashMap

      if (process.env.BUNDLE_ONLY) {
        disposeBuildCaches()
        return
      }

      const renderMetadata = createRenderMetadata(
        siteConfig,
        clientResult,
        serverResult
      )

      clientResult = null
      // @ts-ignore
      serverResult = null

      const additionalHeadTags = createAdditionalHeadTags(renderMetadata)
      const metadataScript = generateMetadataScript(pageToHashMap, siteConfig)

      disposeBuildCaches()
      globalThis.gc?.()

      const entryPath = path.join(siteConfig.tempDir, 'app.js')
      const { render } = await nativeImport(entryPath)

      await task('rendering pages', async () => {
        await renderPages(
          render,
          siteConfig,
          siteConfig.tempDir,
          ['404.md', ...siteConfig.pages],
          renderMetadata,
          pageToHashMap,
          metadataScript,
          additionalHeadTags,
          usedIcons
        )
      })
    }

    // TODO: await import ?
    const icons = require('@iconify-json/simple-icons/icons.json')
    const iconsCss = getIconsCSS(icons, Array.from(usedIcons).sort(), {
      iconSelector: '.vpi-social-{name}',
      commonSelector: '.vpi-social',
      varName: 'icon',
      format: process.env.DEBUG ? 'expanded' : 'compressed',
      mode: 'mask'
    }).replace(/[^]*?}\n*/, '')

    fs.writeFileSync(path.join(siteConfig.outDir, 'vp-icons.css'), iconsCss)

    // emit page hash map for the case where a user session is open
    // when the site got redeployed (which invalidates current hash map)
    fs.writeFileSync(
      path.join(siteConfig.outDir, 'hashmap.json'),
      JSON.stringify(pageToHashMap)
    )
  } finally {
    unlinkVue()
    if (!process.env.DEBUG) {
      fs.rmSync(siteConfig.tempDir, {
        recursive: true,
        force: true,
        maxRetries: 10
      })
    }
  }

  await generateSitemap(siteConfig)
  await siteConfig.buildEnd?.(siteConfig)
  disposeBuildCaches()

  siteConfig.logger.info(
    `build complete in ${((Date.now() - start) / 1000).toFixed(2)}s.`
  )
}

export function linkVue() {
  const root = packageDirectorySync()
  if (root) {
    const dest = path.resolve(root, 'node_modules/vue')
    // if user did not install vue by themselves, link VitePress' version
    if (!fs.existsSync(dest)) {
      const src = path.dirname(createRequire(import.meta.url).resolve('vue'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.symlinkSync(src, dest, 'junction')
      return () => {
        fs.unlinkSync(dest)
      }
    }
  }
  return () => {}
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
