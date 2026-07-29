import { createDebug } from 'obug'
import ora from 'ora'

export const okMark = '\x1b[32m✓\x1b[0m'
export const failMark = '\x1b[31m✗\x1b[0m'

const debug = createDebug('vitepress:task')

export async function task(taskName: string, task: () => Promise<void>) {
  const spinner = ora({ discardStdin: false })
  spinner.start(taskName + '...')
  const start = Date.now()

  try {
    await task()
  } catch (e) {
    spinner.stopAndPersist({ symbol: failMark })
    throw e
  }

  spinner.stopAndPersist({ symbol: okMark })
  debug(`${taskName} took ${Date.now() - start}ms`)
}
