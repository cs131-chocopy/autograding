import {spawn, ChildProcess} from 'child_process'
import kill from 'tree-kill'
import {v4 as uuidv4} from 'uuid'
import * as core from '@actions/core'
import {setCheckRunOutput} from './output'
import * as os from 'os'
import chalk from 'chalk'

const color = new chalk.Instance({level: 1})

export type TestComparison = 'exact' | 'included' | 'regex'

export interface Test {
  readonly name: string
  readonly setup: string
  readonly run: string
  readonly input?: string
  readonly output?: string
  readonly timeout: number
  readonly points?: number
  readonly comparison: TestComparison
}

export class TestError extends Error {
  constructor(message: string) {
    super(message)
    Error.captureStackTrace(this, TestError)
  }
}

export class TestTimeoutError extends TestError {
  constructor(message: string) {
    super(message)
    Error.captureStackTrace(this, TestTimeoutError)
  }
}

export class TestOutputError extends TestError {
  expected: string
  actual: string

  constructor(message: string, expected: string, actual: string) {
    super(`${message}\nExpected:\n${expected}\nActual:\n${actual}`)
    this.expected = expected
    this.actual = actual

    Error.captureStackTrace(this, TestOutputError)
  }
}

const log = (text: string): void => {
  process.stdout.write(text + os.EOL)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const indent = (text: any): string => {
  let str = '' + new String(text)
  str = str.replace(/\r\n/gim, '\n').replace(/\n/gim, '\n  ')
  return str
}

const waitForExit = async (child: ChildProcess, timeout: number): Promise<void> => {
  // eslint-disable-next-line no-undef
  return new Promise((resolve, reject) => {
    let timedOut = false

    const exitTimeout = setTimeout(() => {
      timedOut = true
      reject(new TestTimeoutError(`Setup timed out in ${timeout} milliseconds`))
      kill(child.pid)
    }, timeout)

    child.once('exit', (code: number, signal: string) => {
      if (timedOut) return
      clearTimeout(exitTimeout)

      if (code === 0) {
        resolve(undefined)
      } else {
        reject(new TestError(`Error: Exit with code: ${code} and signal: ${signal}`))
      }
    })

    child.once('error', (error: Error) => {
      if (timedOut) return
      clearTimeout(exitTimeout)

      reject(error)
    })
  })
}

const runSetup = async (test: Test, cwd: string, timeout: number): Promise<void> => {
  if (!test.setup || test.setup === '') {
    return
  }

  const setup = spawn(test.setup, {
    cwd,
    shell: true,
    env: {
      PATH: process.env['PATH'],
      FORCE_COLOR: 'true',
    },
  })

  // Start with a single new line
  process.stdout.write(indent('\n'))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup.stdout.on('data', chunk => {
    process.stdout.write(indent(chunk))
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup.stderr.on('data', chunk => {
    process.stderr.write(indent(chunk))
  })

  await waitForExit(setup, timeout)
}

const runCommand = async (test: Test, cwd: string, timeout: number): Promise<number> => {
  const child = spawn(test.run, {
    cwd,
    shell: true,
    env: {
      PATH: process.env['PATH'],
      FORCE_COLOR: 'true',
    },
  })

  let output = ''

  // Start with a single new line
  process.stdout.write(indent('\n'))

  child.stdout.on('data', chunk => {
    process.stdout.write(indent(chunk))
    output += chunk
  })

  child.stderr.on('data', chunk => {
    process.stderr.write(indent(chunk))
  })

  // Preload the inputs
  if (test.input && test.input !== '') {
    child.stdin.write(test.input)
    child.stdin.end()
  }

  await waitForExit(child, timeout)

  const regexp = /\[overall score: ([\d\.]*)\]\s*$/g
  const match = regexp.exec(output)
  if (match) {
    return parseFloat(match[1])
  }
  return 0
}

export const run = async (test: Test, cwd: string): Promise<number> => {
  // Timeouts are in minutes, but need to be in ms
  let timeout = (test.timeout || 1) * 60 * 1000 || 30000
  const start = process.hrtime()
  await runSetup(test, cwd, timeout)
  const elapsed = process.hrtime(start)
  // Subtract the elapsed seconds (0) and nanoseconds (1) to find the remaining timeout
  timeout -= Math.floor(elapsed[0] * 1000 + elapsed[1] / 1000000)
  return await runCommand(test, cwd, timeout)
}

export const runAll = async (tests: Array<Test>, cwd: string): Promise<void> => {
  let points = 0
  let availablePoints = 0

  // https://help.github.com/en/actions/reference/development-tools-for-github-actions#stop-and-start-log-commands-stop-commands
  const token = uuidv4()
  log('')
  log(`::stop-commands::${token}`)
  log('')

  let failed = false

  for (const test of tests) {
    try {
      if (test.points) {
        availablePoints += test.points
      }
      log(color.cyan(`📝 ${test.name}`))
      log('')
      const test_result = await run(test, cwd)
      points += test_result
      
      log('')
      if (test_result === test.points) {
        log(color.green(`✅ ${test.name}`))
      } else {
        failed = true
        log(color.red(`❌ ${test.name}`))
      }
      log('')
    } catch (error) {
      failed = true
      log('')
      log(color.red(`❌ ${test.name}`))
      core.setFailed(error.message)
    }
  }

  // Restart command processing
  log('')
  log(`::${token}::`)

  if (failed) {
    // We need a good failure experience
  } else {
    log('')
    log(color.green('All tests passed'))
    log('')
    log('✨🌟💖💎🦄💎💖🌟✨🌟💖💎🦄💎💖🌟✨')
    log('')
  }

  // Set the number of points
  points = Math.round(points)
  if (points > 0) {
    const text = `Points ${points}/${availablePoints}`
    log(color.bold.bgCyan.black(text))
    core.setOutput('Points', `${points}/${availablePoints}`)
    await setCheckRunOutput(text)
  }
}
