import { getIconsCSS } from '@iconify/utils'
import { spawn } from 'node:child_process'
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
  // TODO: ????
  //matter?.clearCache?.()
  disposeMdItInstance()
  cache.clear()
  cacheTheme.clear()
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

function runSsrBatchWorker(descriptorPath: string): Promise<void> {
  const workerEntry = fileURLToPath(new URL('./ssr-worker.js', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...workerExecArgv(), workerEntry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VITEPRESS_SSR_BATCH_DESCRIPTOR: descriptorPath
      },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            `SSR batch worker failed (${signal ? `signal ${signal}` : `exit ${code}`}).`
          )
        )
      }
    })
  })
}

async function buildSsrBatchWorker(
  siteConfig: SiteConfig,
  buildOptions: any,
  descriptorPath: string
) {
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8'))
  const contract = JSON.parse(fs.readFileSync(descriptor.contractPath, 'utf-8'))

  siteConfig.site.base = descriptor.base
  siteConfig.outDir = descriptor.outDir
  siteConfig.ssrBuildBatchSize = undefined

  restoreGitTimestamps(contract.gitTimestamps)

  fs.mkdirSync(siteConfig.tempDir, { recursive: true })
  const batchTempDir = fs.mkdtempSync(
    path.join(siteConfig.tempDir, `ssr-${descriptor.offset}-`)
  )
  siteConfig.tempDir = batchTempDir
  const usedIcons = new Set<string>()

  try {
    await bundle(siteConfig, buildOptions, {
      pages: descriptor.serverPages,
      tempDir: batchTempDir
    })
    disposeBuildCaches()

    const entryPath = path.join(batchTempDir, 'app.js')
    const { render } = await nativeImport(entryPath)

    await renderPages(
      render,
      siteConfig,
      batchTempDir,
      descriptor.pages,
      deserializeRenderMetadata(contract.renderMetadata),
      contract.pageToHashMap,
      contract.metadataScript,
      contract.additionalHeadTags,
      usedIcons
    )
    fs.writeFileSync(
      descriptor.iconsPath,
      JSON.stringify([...usedIcons].sort())
    )
  } finally {
    disposeBuildCaches()
    if (!process.env.DEBUG) {
      fs.rmSync(batchTempDir, { recursive: true, force: true })
    }
  }
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

  const workerDescriptorPath = process.env.VITEPRESS_SSR_BATCH_DESCRIPTOR
  if (workerDescriptorPath) {
    delete process.env.VITEPRESS_SSR_BATCH_DESCRIPTOR
  }

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

  if (workerDescriptorPath) {
    const unlinkVue = linkVue()
    try {
      await buildSsrBatchWorker(siteConfig, buildOptions, workerDescriptorPath)
    } finally {
      unlinkVue()
    }
    return
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
  }

  const unlinkVue = linkVue()

  try {
    let { clientResult, serverResult, pageToHashMap } = await bundle(
      siteConfig,
      buildOptions
    )

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

    const gitTimestamps = snapshotGitTimestamps()

    disposeBuildCaches()
    globalThis.gc?.()

    const usedIcons = /* @__PURE__ */ new Set<string>()

    if (siteConfig.ssrBuildBatchSize) {
      fs.mkdirSync(siteConfig.tempDir, { recursive: true })
      const coordinatorDir = fs.mkdtempSync(
        path.join(siteConfig.tempDir, 'ssr-coordinator-')
      )
      const contractPath = path.join(coordinatorDir, 'contract.json')

      fs.writeFileSync(
        contractPath,
        JSON.stringify({
          renderMetadata: serializeRenderMetadata(renderMetadata),
          pageToHashMap,
          metadataScript,
          additionalHeadTags,
          gitTimestamps
        })
      )

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
          const descriptorPath = path.join(
            coordinatorDir,
            `batch-${offset}.json`
          )
          const iconsPath = path.join(coordinatorDir, `icons-${offset}.json`)

          fs.writeFileSync(
            descriptorPath,
            JSON.stringify({
              root: siteConfig.root,
              base: siteConfig.site.base,
              outDir: siteConfig.outDir,
              offset,
              pages,
              serverPages,
              contractPath,
              iconsPath,
              buildOptions
            })
          )

          await runSsrBatchWorker(descriptorPath)

          const iconsInBatch: string[] = JSON.parse(
            fs.readFileSync(iconsPath, 'utf-8')
          )
          for (const icon of iconsInBatch) {
            usedIcons.add(icon)
          }
        }
      })
    } else {
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

function linkVue() {
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
