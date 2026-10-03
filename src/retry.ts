import * as core from '@actions/core'
import { randomInt } from 'node:crypto'

// The policy of actions/checkout's retry-helper.ts: three attempts, a random 10 to 20 seconds apart.
export type RetryPolicy = {
  attempts: number
  minSeconds: number
  maxSeconds: number
  sleep: (seconds: number) => Promise<void>
}

const CHECKOUT_POLICY: RetryPolicy = {
  attempts: 3,
  minSeconds: 10,
  maxSeconds: 20,
  sleep: (seconds) =>
    new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

export async function retry<T>(
  action: () => Promise<T>,
  policy: RetryPolicy = CHECKOUT_POLICY
): Promise<T> {
  // Each attempt waits for the one before, which is the point: Sonar's rule against awaiting in a
  // loop is about work that could run in parallel.
  for (let attempt = 1; attempt < policy.attempts; attempt++) {
    try {
      return await action() // NOSONAR
    } catch (error) {
      core.info(error instanceof Error ? error.message : String(error))
    }
    const seconds = randomInt(policy.minSeconds, policy.maxSeconds + 1)
    core.info(`Waiting ${seconds} seconds before trying again`)
    await policy.sleep(seconds) // NOSONAR
  }
  return action()
}
