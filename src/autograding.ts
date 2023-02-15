import * as core from '@actions/core'
import {runAll} from './runner'

const run = async (): Promise<void> => {
  try {
    await runAll()
  } catch (error) {
    // If there is any error we'll fail the action with the error message
    console.error(error.message)
    core.setFailed(`Autograding failure: ${error}`)
  }
}

// Don't auto-execute in the test environment
if (process.env['NODE_ENV'] !== 'test') {
  run()
}

export default run
