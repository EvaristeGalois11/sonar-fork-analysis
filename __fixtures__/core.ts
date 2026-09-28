import type * as core from '@actions/core'
import { jest } from '@jest/globals'

export const getInput = jest.fn<typeof core.getInput>()
export const getMultilineInput = jest.fn<typeof core.getMultilineInput>()
export const setSecret = jest.fn<typeof core.setSecret>()
export const setFailed = jest.fn<typeof core.setFailed>()
export const info = jest.fn<typeof core.info>()
export const warning = jest.fn<typeof core.warning>()
