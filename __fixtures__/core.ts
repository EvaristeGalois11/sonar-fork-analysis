import { vi } from 'vitest'
import type * as core from '@actions/core'

export const getInput = vi.fn<typeof core.getInput>()
export const getMultilineInput = vi.fn<typeof core.getMultilineInput>()
export const setSecret = vi.fn<typeof core.setSecret>()
export const setFailed = vi.fn<typeof core.setFailed>()
export const info = vi.fn<typeof core.info>()
export const debug = vi.fn<typeof core.debug>()
export const warning = vi.fn<typeof core.warning>()
export const notice = vi.fn<typeof core.notice>()
export const saveState = vi.fn<typeof core.saveState>()
export const getState = vi.fn<typeof core.getState>()
