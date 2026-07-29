import { getIconsCSS } from '@iconify/utils'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuildOptions } from 'vite'
import { resolveConfig, type SiteConfig } from '../config'
import type { PageMeta } from '../plugin'
import type { Awaitable } from '../shared'
import { linkVue } from '../utils/linkVue'
import { logVersion } from '../utils/logVersion'
import { task } from '../utils/task'
import { bundle } from './bundle'
import { generateSitemap } from './generateSitemap'
import {
  disposeBuildCaches,
  getRenderer,
  prepareRenderInputs,
  renderPages,
  type ClientBuildMessage,
  type SsrBatchMessage
} from './worker'

const require = createRequire(import.meta.url)

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

function dispatchWorker(
  message: ClientBuildMessage | SsrBatchMessage
): Promise<{ icons?: string[] }> {
  const workerEntry = fileURLToPath(new URL('./ssrWorker.js', import.meta.url))
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

export async function build(
  root?: string,
  buildOptions: BuildOptions & {
    base?: string
    mpa?: string
    onAfterConfigResolve?: (siteConfig: SiteConfig) => Awaitable<void>
  } = {}
) {
  const start = Date.now()

  process.env.NODE_ENV = 'production'

  const siteConfig = await resolveConfig(root, 'build', 'production')

  if (buildOptions.onAfterConfigResolve) {
    await buildOptions.onAfterConfigResolve(siteConfig)
  } else {
    logVersion(siteConfig.logger)
  }
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

  siteConfig.ssrBuildBatchSize ??= 0
  if (
    !Number.isInteger(siteConfig.ssrBuildBatchSize) ||
    siteConfig.ssrBuildBatchSize < 0
  ) {
    throw new Error('ssrBuildBatchSize must be a positive integer.')
  }

  if (siteConfig.mpa && siteConfig.ssrBuildBatchSize) {
    throw new Error('ssrBuildBatchSize is not compatible with MPA mode.')
  }

  if (process.env.BUNDLE_ONLY && siteConfig.ssrBuildBatchSize) {
    throw new Error('BUNDLE_ONLY is not compatible with ssrBuildBatchSize.')
  }

  const pageMetaMap = Object.create(null) as Record<string, PageMeta>
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
      Object.assign(pageMetaMap, contract.pageMetaMap)

      const renderQueue = ['404.md', ...siteConfig.pages]
      const sourcePages = new Set(siteConfig.pages)
      const batchCount = Math.ceil(
        renderQueue.length / siteConfig.ssrBuildBatchSize!
      )

      await task(
        `building server bundles + rendering pages across ${batchCount} workers`,
        async () => {
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
        }
      )
    } else {
      let {
        clientResult,
        serverResult,
        pageToHashMap: unbatchedPageToHashMap
      } = await bundle(siteConfig, buildOptions, pageMetaMap)
      pageToHashMap = unbatchedPageToHashMap

      if (process.env.BUNDLE_ONLY) {
        disposeBuildCaches()
        return
      }

      const { renderMetadata, additionalHeadTags, metadataScript } =
        prepareRenderInputs(
          siteConfig,
          clientResult,
          serverResult,
          pageToHashMap
        )

      clientResult = null
      // @ts-expect-error
      serverResult = null

      disposeBuildCaches()
      const render = await getRenderer(siteConfig.tempDir)

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

  await generateSitemap(siteConfig, pageMetaMap)
  await siteConfig.buildEnd?.(siteConfig)
  disposeBuildCaches()

  siteConfig.logger.info(
    `build complete in ${((Date.now() - start) / 1000).toFixed(2)}s.`
  )
}
