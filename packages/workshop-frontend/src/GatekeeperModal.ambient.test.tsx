// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Regression test for VON-1852: the Gadget "Create New Connection" modal's "+ Connect <vendor>"
// button did nothing for ambient/auto-provision gatekeepers (vonBusch CRM, vonBusch Mail). Those
// vendors set VendorDescription.autoProvisionsAccount and mint their account via createAccount() --
// they have no OAuth connectAccount() handshake (theirs throws "es gibt keinen Connect-Flow"). The
// modal unconditionally called authenticatedApi.connectAccount(), so the click errored / opened a
// dead tab and no account ever appeared. The fix routes ambient vendors through
// provisionAmbientAccount() instead (matching routes/gatekeepers.tsx and ObserverConfigModal.tsx).

import { act, type ReactNode, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no ResizeObserver; the modal instantiates one for layout sizing.
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// The api the mocked AuthContext hands to the component under test. Set per render().
let currentApi: RpcStub<AuthenticatedApi>

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
    },
  )
  return {
    Dialog,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: currentApi }) }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'vonBusch' }))
vi.mock('./useDialogSelectPortalContainer', () => ({ useDialogSelectPortalContainer: () => null }))
vi.mock('./errorReporting', () => ({ reportIssue: vi.fn() }))

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

// Capture the `disabled` prop -- true while no account is selected ("Choose an account before
// selecting a resource"), false once an account is selected and the resource step is reachable.
vi.mock('./ResourceConfiguratorHost', () => ({
  default: ({ disabled }: { disabled: boolean }) => (
    <div data-testid="configurator" data-disabled={String(disabled)} />
  ),
}))

vi.mock('./gatekeeper-modal/AgentSpawnerConfigForm', () => ({
  AgentSpawnerConfigForm: () => null,
  spawnerEnvFromRows: () => ({}),
  validateSpawnerEnv: () => null,
}))
vi.mock('./gatekeeper-modal/AiModelConnectionConfig', () => ({ AiModelConnectionConfig: () => null }))

import GatekeeperModal from './GatekeeperModal'

const CRM_VENDOR = {
  displayName: 'vonBusch CRM',
  color: '#1f6feb',
  autoProvisionsAccount: true,
} as VendorDescription

// A non-grantable resource so the flow needs only an account (no per-resource grant step) -- this is
// how the vonBusch gatekeepers expose their instance.
const CRM_RESOURCE: SupportedResource = {
  urlPattern: 'https://*',
  title: 'CRM',
  description: 'Kontakte, Deals und Aktivitäten.',
}

const CRM_ACCOUNT_DESC = {
  displayName: 'vonBusch CRM',
  uniqueName: 'crm-account-1',
} as AccountDescription

type Subscriber = ConnectedAccountsSubscriber

describe('GatekeeperModal ambient "+ Connect" flow (VON-1852)', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    root = undefined
    container = undefined
  })

  function buildApi() {
    let subscriber: Subscriber | undefined
    const provisionAmbientAccount = vi.fn<(vendorId: string) => Promise<void>>(async () => {
      // Simulate the backend minting the account and the subscription delivering it -- exactly what
      // provisionAmbientAccount() + subscribeConnectedAccounts() do end to end.
      subscriber!.add(1, CRM_ACCOUNT_DESC, CRM_VENDOR, [CRM_RESOURCE], true, 'vonbusch-crm')
    })
    const connectAccount = vi.fn<
      (vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>
    >()
    const api = {
      subscribeConnectedAccounts: (sub: Subscriber) => {
        subscriber = sub
        sub.ready()
        return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
      },
      listGatekeeperVendors: async () => [{
        id: 'vonbusch-crm',
        description: CRM_VENDOR,
        supportedResources: [CRM_RESOURCE],
      }],
      listAddableGatekeepers: async () => [],
      listModels: async () => [],
      provisionAmbientAccount,
      connectAccount,
      // The configurator effect calls this once an account is selected; keep it pending so the
      // mocked ResourceConfiguratorHost just reflects the `disabled` prop.
      startResourceConfigurator: () => new Promise(() => {}),
    } as unknown as RpcStub<AuthenticatedApi>
    return { api, provisionAmbientAccount, connectAccount }
  }

  async function render(api: RpcStub<AuthenticatedApi>) {
    currentApi = api
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <GatekeeperModal
          open
          onClose={() => {}}
          getOverseer={async () => ({}) as never}
          onCreated={async () => {}}
          spawnerEnvCandidates={[]}
          initialVendorId="vonbusch-crm"
        />,
      )
      await Promise.resolve()
    })
    // Let vendor loading + the initialVendorId pre-select effect settle.
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    return container!
  }

  it('provisions (not OAuth-connects) an ambient account and unblocks resource selection', async () => {
    const { api, provisionAmbientAccount, connectAccount } = buildApi()
    const rendered = await render(api)

    // Precondition: no account yet -> the "+ Connect vonBusch CRM" button is shown and the resource
    // step is disabled ("Choose an account before selecting a resource").
    const connect = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Connect vonBusch CRM'))
    expect(connect, 'the "+ Connect vonBusch CRM" button should render').toBeDefined()
    expect(rendered.querySelector('[data-testid="configurator"]')?.getAttribute('data-disabled'))
      .toBe('true')

    // Act: click "+ Connect vonBusch CRM".
    await act(async () => { connect!.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    // The fix: ambient vendors are provisioned directly, never sent through the OAuth connectAccount
    // handshake (which the vonBusch gatekeeper's connectAccount() throws on).
    expect(provisionAmbientAccount).toHaveBeenCalledWith('vonbusch-crm')
    expect(connectAccount).not.toHaveBeenCalled()

    // The minted account now appears and is auto-selected -> the resource configurator is enabled.
    expect(rendered.textContent).toContain('vonBusch CRM')
    expect(rendered.querySelector('[data-testid="configurator"]')?.getAttribute('data-disabled'))
      .toBe('false')
  })
})
