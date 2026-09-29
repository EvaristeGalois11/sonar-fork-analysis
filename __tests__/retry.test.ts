import { jest } from '@jest/globals'
import { retry } from '../src/retry.js'

const sleep = jest.fn<(seconds: number) => Promise<void>>(async () => {})
const policy = { attempts: 3, minSeconds: 10, maxSeconds: 20, sleep }

afterEach(() => {
  sleep.mockClear()
})

describe('retry', () => {
  it('returns the first success without waiting', async () => {
    await expect(retry(async () => 'done', policy)).resolves.toBe('done')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('tries again after a failure, waiting 10 to 20 seconds', async () => {
    const action = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue('done')

    await expect(retry(action, policy)).resolves.toBe('done')
    expect(action).toHaveBeenCalledTimes(2)
    const seconds = sleep.mock.calls[0][0]
    expect(seconds).toBeGreaterThanOrEqual(10)
    expect(seconds).toBeLessThanOrEqual(20)
  })

  it('gives up after three attempts with the last error', async () => {
    const action = jest
      .fn<() => Promise<string>>()
      .mockImplementation(async () => {
        throw new Error(`attempt ${action.mock.calls.length}`)
      })

    await expect(retry(action, policy)).rejects.toThrow('attempt 3')
    expect(action).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})
