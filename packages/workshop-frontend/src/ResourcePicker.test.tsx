// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import ResourcePicker from './ResourcePicker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const dispose = vi.fn<() => void>()
  const promise = Object.assign(new Promise<T>(next => { resolve = next }), {
    [Symbol.dispose]: dispose,
  })
  return { promise, resolve, dispose }
}

describe('ResourcePicker', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  it('disposes a pending connected-account subscription on unmount', async () => {
    const pendingSubscription = deferred<{ [Symbol.dispose](): void }>()
    const authenticatedApi = {
      subscribeConnectedAccounts: () => pendingSubscription.promise,
      listGatekeeperVendors: async () => [],
    } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ResourcePicker
        authenticatedApi={authenticatedApi}
        searchText="https://example.com"
        onSelectAccount={() => {}}
      />,
    ))

    act(() => root!.unmount())
    root = undefined

    expect(pendingSubscription.dispose).toHaveBeenCalledOnce()
  })

  // Regression (VON-1919): the "connect new account" row for an ambient gatekeeper (the vonBusch
  // CRM / Preiserhebung, autoProvisionsAccount) must route through provisionAmbientAccount(), NOT the
  // OAuth connectAccount() handshake -- which errors / opens a dead tab and is why "Entdecken ->
  // Ressource hinzufuegen -> Verbindung" appeared broken. Mirrors GatekeeperModal / BlueprintLandingPage.
  it('provisions an ambient vendor from the connect-new row instead of opening an OAuth tab', async () => {
    const provisionAmbientAccount = vi.fn(async (_vendorId: string) => {})
    const connectAccount = vi.fn(async () => ({ url: 'https://oauth.example/authorize' }))

    const AMBIENT_VENDOR = {
      id: 'vonbusch_crm',
      description: { displayName: 'vonBusch CRM', autoProvisionsAccount: true },
      supportedResources: [
        { urlPattern: 'https://crm.vonbusch.app/', title: 'CRM', description: 'Das vonBusch-CRM' },
      ],
    }

    const authenticatedApi = {
      listGatekeeperVendors: async () => [AMBIENT_VENDOR],
      subscribeConnectedAccounts: (subscriber: { ready: () => void }) => {
        subscriber.ready()
        return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
      },
      provisionAmbientAccount,
      connectAccount,
    } as unknown as RpcStub<AuthenticatedApi>

    const activateRef = { current: null as ((index: number) => void) | null }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ResourcePicker
        authenticatedApi={authenticatedApi}
        searchText="https://crm.vonbusch.app/"
        onSelectAccount={() => {}}
        activateRef={activateRef}
      />,
    ))
    await act(async () => { await Promise.resolve() })

    // With no connected accounts, the single selectable row is the "connect new account" row.
    await act(async () => activateRef.current?.(0))
    await act(async () => { await Promise.resolve() })

    expect(provisionAmbientAccount).toHaveBeenCalledWith('vonbusch_crm')
    expect(connectAccount).not.toHaveBeenCalled()
  })
})
