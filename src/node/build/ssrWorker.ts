import { linkVue } from '../utils/linkVue'
import { runClientBuild, runSsrBatch } from './worker'

process.on('message', async (message: any) => {
  const unlinkVue = linkVue()
  let exitCode = 0
  let icons: string[] | undefined

  try {
    if (message?.type === 'client-build') {
      await runClientBuild(message)
    } else if (message?.type === 'ssr-batch') {
      icons = await runSsrBatch(message)
    } else {
      throw new Error(`Unknown worker message type: ${message?.type}`)
    }
  } catch (err) {
    console.error(err)
    exitCode = 1
  }

  unlinkVue()

  if (icons && process.send) {
    process.send({ type: 'icons', icons }, () => process.exit(exitCode))
  } else {
    process.exit(exitCode)
  }
})
