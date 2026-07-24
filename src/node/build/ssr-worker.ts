import fs from 'node:fs'
import { build } from './build'

const descriptorPath = process.env.VITEPRESS_SSR_BATCH_DESCRIPTOR
if (!descriptorPath) {
  throw new Error('Missing VITEPRESS_SSR_BATCH_DESCRIPTOR.')
}
const descriptor = fs.readFileSync(descriptorPath, 'utf8')
const { root, buildOptions = {} } = JSON.parse(descriptor)
await build(root, buildOptions)
