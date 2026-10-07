import { vi } from 'vitest'
import type * as actionsExec from '@actions/exec'

export const exec = vi.fn<typeof actionsExec.exec>()
export const getExecOutput = vi.fn<typeof actionsExec.getExecOutput>()
