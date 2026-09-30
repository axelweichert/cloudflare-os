// @vitest-environment jsdom
//
// Covers the OWL-1754 fix: behind Cloudflare Access, an expired session must send the user through
// a full-page re-login navigation instead of a dead error box. Needs jsdom for window/sessionStorage.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AUTH_ERROR_CODES, createAuthError } from '@gadgets/workshop-shared/api'

vi.mock('./errorReporting', () => ({ reportIssue: vi.fn() }))

import {
  accessLogin, isAccessSessionExpiredError, logRpcFailure,
  redirectToAccessLoginIfSessionExpired,
} from './rpcErrors'

const rpcError = (message: string, props?: object) => Object.assign(new Error(message), props)

// The 302→Access case: the backend rejects authenticateFromCfAccess() with this coded error when
// the Access JWT is missing (session expired).
const accessExpired = () => createAuthError(AUTH_ERROR_CODES.notAuthenticatedWithAccess)

describe('isAccessSessionExpiredError', () => {
  it('matches the coded error and the bare-message fallback, nothing else', () => {
    expect(isAccessSessionExpiredError(accessExpired())).toBe(true)
    expect(isAccessSessionExpiredError(new Error('Not authenticated with Access.'))).toBe(true)
    // A stale local token is a different auth failure and must not trigger an Access reload.
    expect(isAccessSessionExpiredError(createAuthError(AUTH_ERROR_CODES.invalidSessionToken)))
        .toBe(false)
    expect(isAccessSessionExpiredError(new Error('Workspace not found.'))).toBe(false)
  })
})

describe('redirectToAccessLoginIfSessionExpired', () => {
  let reload: Mock<() => void>

  beforeEach(() => {
    reload = vi.fn<() => void>()
    vi.spyOn(accessLogin, 'reload').mockImplementation(() => reload())
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('reloads on an expired Access session when Access mode is on', () => {
    vi.stubEnv('VITE_CF_ACCESS_MODE', 'true')
    expect(redirectToAccessLoginIfSessionExpired(accessExpired())).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('does nothing outside Access mode', () => {
    vi.stubEnv('VITE_CF_ACCESS_MODE', 'false')
    expect(redirectToAccessLoginIfSessionExpired(accessExpired())).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does nothing for a non-Access-expiry error', () => {
    vi.stubEnv('VITE_CF_ACCESS_MODE', 'true')
    expect(redirectToAccessLoginIfSessionExpired(rpcError('Peer closed WebSocket'))).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads at most once per cooldown window, so a persistent failure cannot loop', () => {
    vi.stubEnv('VITE_CF_ACCESS_MODE', 'true')
    const t0 = 1_000_000
    expect(redirectToAccessLoginIfSessionExpired(accessExpired(), t0)).toBe(true)
    // A second failure moments later (e.g. after the reload) must not reload again.
    expect(redirectToAccessLoginIfSessionExpired(accessExpired(), t0 + 500)).toBe(false)
    // Once the cooldown has elapsed, a fresh expiry is allowed to re-navigate.
    expect(redirectToAccessLoginIfSessionExpired(accessExpired(), t0 + 20_000)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('is reached through logRpcFailure, the common route failure sink', () => {
    vi.stubEnv('VITE_CF_ACCESS_MODE', 'true')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      logRpcFailure('Failed to load available services:', accessExpired())
      expect(reload).toHaveBeenCalledOnce()
    } finally {
      error.mockRestore()
    }
  })
})
