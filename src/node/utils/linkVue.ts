import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { packageDirectorySync } from 'package-directory'

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
