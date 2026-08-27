// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  BlueprintPublicInfo,
  PublicApi,
} from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn<() => void>(),
  useParams: () => ({ id: 'blueprint-one' }),
  useRouter: () => ({ history: { back: vi.fn<() => void>(), canGoBack: () => false } }),
}))

vi.mock('./useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    authenticatedApi: testState.authenticatedApi,
    isLoading: false,
    login: vi.fn<(token: string) => void>(),
  }),
}))

import BlueprintLandingPage from './BlueprintLandingPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const originalInnerWidth = window.innerWidth

const MODEL: AiChatAuthorInfo = {
  type: 'agent',
  id: 'model-one',
  name: 'Model one',
}

const BLUEPRINT: BlueprintPublicInfo = {
  id: 'blueprint-one',
  metadata: {
    title: 'Model blueprint',
    description: 'Requires an AI model.',
    author: { type: 'user', id: 'author', name: 'Author' },
    created: new Date('2026-08-24T00:00:00Z'),
    version: 1,
    lastUpdated: new Date('2026-08-24T00:00:00Z'),
    bindings: {
      AI: {
        type: 'aiModel',
        title: 'Claude Sonnet 5',
        description: '',
      },
    },
  },
}

function subscription() {
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
    [Symbol.dispose]() {},
  })
}

function authenticatedApi(): RpcStub<AuthenticatedApi> {
  return {
    listModels: async () => [MODEL],
    listGatekeeperVendors: async () => [],
    subscribeConnectedAccounts: subscription,
    getAdminApi: async () => null,
    isBlueprintInLibrary: async () => null,
    isBlueprintPinned: async () => false,
    getOwnBlueprint: async () => null,
  } as unknown as RpcStub<AuthenticatedApi>
}

function publicApi(): RpcStub<PublicApi> {
  return {
    getBlueprint: async () => BLUEPRINT,
  } as unknown as RpcStub<PublicApi>
}

describe('BlueprintLandingPage model configuration', () => {
  let root: Root | undefined
  let rootContainer: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    rootContainer?.remove()
    testState.authenticatedApi = null
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
  })

  it('portals model options above the configure dialog and accepts a selection', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    testState.authenticatedApi = authenticatedApi()
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)

    await act(async () => root!.render(<BlueprintLandingPage rpcStub={publicApi()} />))
    await act(async () => { await Promise.resolve() })

    const configure = Array.from(document.body.querySelectorAll('button'))
      .find(button => /konfigurieren/i.test(button.textContent ?? ''))!
    await act(async () => configure.click())

    const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="KI-Modell auswählen"]')!
    await act(async () => trigger.click())

    const option = document.body.querySelector<HTMLElement>('[role="option"]')!
    const portalHost = option.closest('[data-base-ui-portal]')!.parentElement!
    expect(portalHost.parentElement).toBe(document.body)
    expect(portalHost.style.position).toBe('relative')
    expect(portalHost.style.zIndex).toBe('1100')

    await act(async () => option.click())
    expect(trigger.textContent).toContain('Model one')

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Verbindung speichern')!
    expect(save.disabled).toBe(false)
  })
})

describe('BlueprintLandingPage ambient CRM connection (VON-1917)', () => {
  let root: Root | undefined
  let rootContainer: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    rootContainer?.remove()
    testState.authenticatedApi = null
  })

  const CRM_BLUEPRINT: BlueprintPublicInfo = {
    id: 'blueprint-one',
    metadata: {
      title: 'Angebot erstellen',
      description: 'Braucht das CRM.',
      author: { type: 'user', id: 'author', name: 'Author' },
      created: new Date('2026-08-24T00:00:00Z'),
      version: 1,
      lastUpdated: new Date('2026-08-24T00:00:00Z'),
      bindings: {
        crm: {
          type: 'gatekeeper',
          title: 'CRM (von Busch)',
          description: '',
          gatekeeperName: 'vonbusch_crm',
          typeUrlPattern: 'https://crm.vonbusch.app/',
        },
      },
    },
  } as unknown as BlueprintPublicInfo

  const AMBIENT_VENDOR = {
    id: 'vonbusch_crm',
    description: { displayName: 'vonBusch CRM', autoProvisionsAccount: true },
    supportedResources: [
      { urlPattern: 'https://crm.vonbusch.app/', title: 'CRM', description: 'Das vonBusch-CRM' },
    ],
  }

  // Regression: the CRM gatekeeper is an ambient vendor (autoProvisionsAccount). Clicking
  // "verbinden" in the blueprint flow must route through provisionAmbientAccount(), NOT the OAuth
  // connectAccount() handshake (which errors / opens a dead tab -> the "CRM-Verbindung funktioniert
  // nicht" report). Mirrors GatekeeperModal.ambient.test.tsx.
  it('provisions the ambient CRM account instead of opening an OAuth tab', async () => {
    const provisionAmbientAccount = vi.fn(async (_vendorId: string) => {})
    const connectAccount = vi.fn(async () => ({ url: 'https://oauth.example/authorize' }))

    testState.authenticatedApi = {
      listModels: async () => [MODEL],
      listGatekeeperVendors: async () => [AMBIENT_VENDOR],
      subscribeConnectedAccounts: subscription,
      provisionAmbientAccount,
      connectAccount,
      getAdminApi: async () => null,
      isBlueprintInLibrary: async () => null,
      isBlueprintPinned: async () => false,
      getOwnBlueprint: async () => null,
    } as unknown as RpcStub<AuthenticatedApi>

    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)

    const crmPublicApi = { getBlueprint: async () => CRM_BLUEPRINT } as unknown as RpcStub<PublicApi>
    await act(async () => root!.render(<BlueprintLandingPage rpcStub={crmPublicApi} />))
    await act(async () => { await Promise.resolve() })

    const configure = Array.from(document.body.querySelectorAll('button'))
      .find(button => /konfigurieren/i.test(button.textContent ?? ''))!
    await act(async () => configure.click())
    await act(async () => { await Promise.resolve() })

    const connect = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => /vonBusch CRM verbinden/i.test(button.textContent ?? ''))!
    expect(connect).toBeTruthy()
    await act(async () => connect.click())
    await act(async () => { await Promise.resolve() })

    expect(provisionAmbientAccount).toHaveBeenCalledWith('vonbusch_crm')
    expect(connectAccount).not.toHaveBeenCalled()
  })
})
