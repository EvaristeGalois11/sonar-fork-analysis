import * as core from '@actions/core'

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
  for (let attempt = 1; attempt < policy.attempts; attempt++) {
    try {
      return await action()
    } catch (error) {
      core.info(error instanceof Error ? error.message : String(error))
    }
    const seconds =
      Math.floor(Math.random() * (policy.maxSeconds - policy.minSeconds + 1)) +
      policy.minSeconds
    core.info(`Waiting ${seconds} seconds before trying again`)
    await policy.sleep(seconds)
  }
  return action()
}
