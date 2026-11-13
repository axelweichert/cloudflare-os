import { useState, useEffect } from 'react'
import { Dialog, Button, Input, Select, Collapsible, useKumoToastManager } from '@cloudflare/kumo'
import { AiChatAuthorInfo, AiModelProvider, AiGatewayInfo, RedactedAiModelConfig, SUGGESTED_MODELS, modelKind } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { ExtraHeadersEditor } from './features/ai-models/ExtraHeadersEditor'
import { StoredSecretInput } from './features/ai-models/StoredSecretInput'
import {
  headerRowsFromRecord, headerRowsToRecord, validateHeaderRows, type HeaderRow,
} from './features/ai-models/extraHeaders'
import { PROVIDER_LABELS, parseTokenLimit } from './features/ai-models/modelForm'

/**
 * Whether the modal adds a model from scratch, edits a stored one, or adds a model based on a
 * stored one, with the stored model's withheld secrets carried over.
 */
export type ModelModalMode =
  | { type: 'add' }
  | { type: 'edit' | 'clone', source: { profile: AiChatAuthorInfo, config: RedactedAiModelConfig } }

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  aiConfig: AiGatewayInfo | null
  mode?: ModelModalMode
  /** Leave decision models out, for callers choosing the user's chat model. */
  chatModelsOnly?: boolean
}

type SelectionType =
  | { type: 'suggested', provider: AiModelProvider, modelId: string, displayName: string }
  | { type: 'custom', provider: AiModelProvider }

// Placeholder hinting at the shape of each provider's API token.
const API_TOKEN_PLACEHOLDERS: Record<AiModelProvider, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  google: 'AIza...',
  cloudflare: 'Cloudflare-API-Token',
  ollama: '(optional)',
  // Never shown: Auto Router's one model is the deployment's (see AiGatewayInfo.enabledProviders).
  'cloudflare-auto-router': '',
}

// Providers whose client can send no API key at all, so a proxy that extra headers authenticate
// can supply its own (AI Gateway only injects a stored key into requests that carry none). Google's
// SDK always sends a key, and the Workers AI endpoint can't be redirected to a proxy.
const TOKEN_OPTIONAL_WITH_HEADERS: ReadonlySet<AiModelProvider> = new Set(['anthropic', 'openai'])

const isTokenRequired = (provider: AiModelProvider, headerRows: readonly HeaderRow[]) =>
  provider !== 'ollama' &&
  !(TOKEN_OPTIONAL_WITH_HEADERS.has(provider) && headerRowsToRecord(headerRows) !== undefined)

// Example used in the custom-model placeholders for providers that have no suggested models
// (currently Ollama, which serves whatever the user has pulled locally).
const FALLBACK_EXAMPLE_MODEL = { modelId: 'gemma4:31b', name: 'Gemma 4 31B' }

// Pick an example model to show in the custom-model placeholders for the given provider.
function exampleModel(provider: AiModelProvider): { modelId: string, name: string } {
  const first = Object.entries(SUGGESTED_MODELS[provider])[0]
  return first ? { modelId: first[0], name: first[1].name } : FALLBACK_EXAMPLE_MODEL
}

// Encode a selection into a string value for the Select component.
function encodeSelection(provider: AiModelProvider, modelId?: string): string {
  return modelId ? `${provider}:${modelId}` : `other-${provider}`
}

// Decode a Select value back into a SelectionType.
function decodeSelection(value: string): SelectionType {
  if (value.startsWith('other-')) {
    return { type: 'custom', provider: value.substring(6) as AiModelProvider }
  }
  const colonIndex = value.indexOf(':')
  const provider = value.substring(0, colonIndex) as AiModelProvider
  const modelId = value.substring(colonIndex + 1)
  const displayName = SUGGESTED_MODELS[provider][modelId].name
  return { type: 'suggested', provider, modelId, displayName }
}

// Build the flat list of options for the Select dropdown.
function buildOptions(gatewayMode: boolean, enabledProviders: Set<string> | null, chatModelsOnly: boolean) {
  const options: { value: string; label: string; provider: string }[] = []
  const providerOrder = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

  for (const provider of providerOrder) {
    // Auto Router's one model is the deployment's; it runs only through a gateway.
    if (provider === 'cloudflare-auto-router') continue
    if (enabledProviders && !enabledProviders.has(provider)) continue

    // In gateway mode, suggested models are already built-in, so don't list them.
    if (!gatewayMode) {
      for (const [modelId, model] of Object.entries(SUGGESTED_MODELS[provider])) {
        if (model.hidden || (chatModelsOnly && model.kind === 'decision')) continue
        options.push({
          value: encodeSelection(provider, modelId),
          label: model.name,
          provider,
        })
      }
    }

    options.push({
      value: encodeSelection(provider),
      label: `Anderes ${PROVIDER_LABELS[provider] || provider}-Modell…`,
      provider,
    })
  }

  return options
}

export default function AddModelModal({ visible, onCancel, onSuccess, authenticatedApi, aiConfig, mode = { type: 'add' }, chatModelsOnly = false }: AddModelModalProps) {
  const toasts = useKumoToastManager()

  // Edit and clone modes take their initial state from the source model, so the caller remounts
  // the modal (with a `key`) to switch source.
  const source = mode.type === 'add' ? null : mode.source
  const editing = mode.type === 'edit'

  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(
    source && { type: 'custom', provider: source.config.provider })
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined)

  // Form fields (used for custom models). A null secret keeps the source's withheld value.
  const [modelId, setModelId] = useState(editing ? source!.config.model : '')
  const [displayName, setDisplayName] = useState(editing ? source!.profile.name : '')
  const [apiToken, setApiToken] = useState<string | null>(source ? source.config.apiToken : '')
  const [accountId, setAccountId] = useState(source?.config.accountId ?? '')
  const [apiUrl, setApiUrl] = useState(source?.config.apiUrl ?? '')
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => headerRowsFromRecord(source?.config.extraHeaders))
  // Token limits are specific to a model, so a clone doesn't inherit them.
  const [contextWindow, setContextWindow] = useState(editing ? String(source!.config.contextWindow ?? '') : '')
  const [outputLimit, setOutputLimit] = useState(editing ? String(source!.config.outputLimit ?? '') : '')

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [headerErrors, setHeaderErrors] = useState<Record<number, string>>({})

  // Advanced settings collapsible state
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const gatewayMode = aiConfig?.enabled === true
  const enabledProviders: Set<string> | null = gatewayMode
    ? new Set(aiConfig.enabledProviders)
    : null

  // The server keeps withheld secrets only for the endpoint they were configured for. Once the URL
  // changes, withheld values are shown (and sent) as blank, and header values must be re-entered.
  const storedSecretsUsable = source !== null && apiUrl.trim() === (source.config.apiUrl ?? '')
  const effectiveApiToken = apiToken === null && !storedSecretsUsable ? '' : apiToken

  // Reset all state when dialog closes
  useEffect(() => {
    if (!visible) {
      setSelection(null)
      setSelectValue(undefined)
      setModelId('')
      setDisplayName('')
      setApiToken('')
      setAccountId('')
      setApiUrl('')
      setHeaderRows([])
      setContextWindow('')
      setOutputLimit('')
      setErrors({})
      setHeaderErrors({})
      setAdvancedOpen(false)
    }
  }, [visible])

  const handleModelSelect = (value: string) => {
    setSelectValue(value)
    setErrors({})
    setHeaderErrors({})
    const sel = decodeSelection(value)
    setSelection(sel)

    if (sel.type === 'custom') {
      setModelId('')
      setDisplayName('')
    } else {
      setModelId(sel.modelId)
      setDisplayName(sel.displayName)
    }
    setApiToken('')
    setAccountId('')
    setApiUrl(sel.provider === 'ollama' ? 'http://localhost:11434' : '')
    setHeaderRows([])
    setContextWindow('')
    setOutputLimit('')
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!selection) {
      newErrors.selection = gatewayMode ? 'Bitte wähle einen Anbieter aus' : 'Bitte wähle ein Modell aus'
    }

    if (selection?.type === 'custom') {
      if (!modelId.trim()) newErrors.modelId = 'Bitte gib die Modell-ID ein'
      // The caller lists only language models, so a decision model saved here would never show up there.
      else if (chatModelsOnly && modelKind(selection.provider, modelId.trim()) === 'decision') {
        newErrors.modelId = 'Das ist ein Entscheidungsmodell, das nicht chatten kann. Füge es stattdessen unter KI-Anbieter hinzu.'
      }
      if (!displayName.trim()) newErrors.displayName = 'Bitte gib einen Anzeigenamen ein'
    }

    const isOllama = selection?.provider === 'ollama'
    const isCloudflare = selection?.provider === 'cloudflare'
    const showCredentials = !gatewayMode

    if (showCredentials && selection && isTokenRequired(selection.provider, headerRows) && effectiveApiToken?.trim() === '') {
      newErrors.apiToken = apiToken === null
        ? 'Bitte gib deinen API-Token erneut ein, da sich die API-URL geändert hat'
        : 'Bitte gib deinen API-Token ein'
    }

    if (showCredentials && isCloudflare && !accountId.trim()) {
      newErrors.accountId = 'Bitte gib deine Cloudflare-Konto-ID ein'
    }

    if (showCredentials && isOllama && !apiUrl.trim()) {
      newErrors.apiUrl = 'Bitte gib die Ollama-API-URL ein'
    }

    if (parseTokenLimit(contextWindow) === null) {
      newErrors.contextWindow = 'Please enter a positive whole number of tokens'
    }
    if (parseTokenLimit(outputLimit) === null) {
      newErrors.outputLimit = 'Please enter a positive whole number of tokens'
    }

    const newHeaderErrors = showCredentials ? validateHeaderRows(headerRows) : {}
    if (showCredentials && !storedSecretsUsable) {
      for (const row of headerRows) {
        if (row.value === null && !newHeaderErrors[row.id]) {
          newHeaderErrors[row.id] = "Please re-enter this header's value, since the API URL changed"
        }
      }
    }
    // These fields live in the collapsible, so reveal their errors if it was closed.
    if (Object.keys(newHeaderErrors).length > 0 || newErrors.contextWindow || newErrors.outputLimit) {
      setAdvancedOpen(true)
    }

    setErrors(newErrors)
    setHeaderErrors(newHeaderErrors)
    return Object.keys(newErrors).length === 0 && Object.keys(newHeaderErrors).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const isSuggested = selection!.type === 'suggested'
      const finalModelId = isSuggested ? selection!.modelId : modelId.trim()
      const finalDisplayName = isSuggested ? selection!.displayName : displayName.trim()

      const profile: AiChatAuthorInfo = {
        type: 'agent',
        // A model's ID is its identity to chats and settings, so editing never changes it.
        id: editing ? source!.profile.id : finalModelId,
        name: finalDisplayName,
      }

      const extraHeaders = gatewayMode ? undefined : headerRowsToRecord(headerRows)
      const contextWindowTokens = parseTokenLimit(contextWindow)
      const outputLimitTokens = parseTokenLimit(outputLimit)
      const config: RedactedAiModelConfig = {
        provider: selection!.provider,
        model: finalModelId,
        apiToken: gatewayMode ? '' : effectiveApiToken?.trim() ?? null,
        ...(!gatewayMode && accountId.trim() && { accountId: accountId.trim() }),
        ...(!gatewayMode && apiUrl.trim() && { apiUrl: apiUrl.trim() }),
        ...(extraHeaders && { extraHeaders }),
        ...(contextWindowTokens && { contextWindow: contextWindowTokens }),
        ...(outputLimitTokens && { outputLimit: outputLimitTokens }),
      }

      if (editing) {
        await authenticatedApi.updateModel(profile, config)
      } else {
        await authenticatedApi.addModel(profile, config, source?.profile.id)
      }
      toasts.add({ title: editing ? 'KI-Modell erfolgreich aktualisiert' : 'KI-Modell erfolgreich hinzugefügt', variant: 'success' })
      onSuccess()
    } catch (error: any) {
      console.error('Failed to save model:', error)
      toasts.add({
        title: editing ? 'Modell konnte nicht aktualisiert werden' : 'Modell konnte nicht hinzugefügt werden',
        description: error?.message,
        variant: 'error',
      })
    } finally {
      setLoading(false)
    }
  }

  const options = buildOptions(gatewayMode, enabledProviders, chatModelsOnly)
  const showCustomFields = selection?.type === 'custom'
  const example = selection ? exampleModel(selection.provider) : null
  const isOllama = selection?.provider === 'ollama'
  const isCloudflare = selection?.provider === 'cloudflare'
  const showCredentials = !gatewayMode
  const tokenRequired = selection !== null && isTokenRequired(selection.provider, headerRows)
  const title = { add: 'KI-Modell hinzufügen', edit: 'KI-Modell bearbeiten', clone: 'KI-Modell duplizieren' }[mode.type]

  // Group options by provider for rendering with visual separators.
  const groupedOptions: { provider: string; items: typeof options }[] = []
  for (const opt of options) {
    const last = groupedOptions[groupedOptions.length - 1]
    if (last && last.provider === opt.provider) {
      last.items.push(opt)
    } else {
      groupedOptions.push({ provider: opt.provider, items: [opt] })
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="responsive-dialog overflow-y-auto p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          {title}
        </Dialog.Title>

        <div className="space-y-4">
          {/* Model / Provider selection */}
          {source ? (
            <Input
              label="Provider"
              value={PROVIDER_LABELS[source.config.provider] || source.config.provider}
              disabled
            />
          ) : (
          <Select
            label={gatewayMode ? 'Anbieter auswählen' : 'Modell auswählen'}
            className="w-full text-sm"
            placeholder={gatewayMode ? 'Anbieter wählen …' : 'KI-Modell wählen …'}
            value={selectValue}
            onValueChange={(v) => handleModelSelect(v as string)}
            error={errors.selection}
            renderValue={(v) => {
              const opt = options.find(o => o.value === v)
              return opt?.label ?? String(v)
            }}
          >
            {groupedOptions.map((group, groupIndex) => (
              <div key={group.provider}>
                {groupIndex > 0 && (
                  <div className="h-px bg-kumo-line my-1 mx-2" />
                )}
                <div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle select-none">
                  {PROVIDER_LABELS[group.provider as AiModelProvider] || group.provider}
                </div>
                {group.items.map(opt => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </div>
            ))}
          </Select>
          )}

          {/* Custom model fields */}
          {showCustomFields && (
            <>
              <Input
                label="Modell-ID"
                placeholder={`z. B. ${example!.modelId}`}
                description={`Die vom Anbieter angegebene Modellkennung (z. B. '${example!.modelId}')`}
                value={modelId}
                disabled={editing}
                onChange={(e) => { setModelId(e.target.value); setErrors(prev => ({ ...prev, modelId: '' })) }}
                error={errors.modelId}
                variant={errors.modelId ? 'error' : 'default'}
              />

              <Input
                label="Anzeigename"
                placeholder={`z. B. ${example!.name}`}
                description="Lesbarer Name, der in der Oberfläche angezeigt wird"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setErrors(prev => ({ ...prev, displayName: '' })) }}
                error={errors.displayName}
                variant={errors.displayName ? 'error' : 'default'}
              />
            </>
          )}

          {/* Cloudflare account ID (the Workers AI REST endpoint is account-scoped) */}
          {showCredentials && isCloudflare && (
            <Input
              label="Cloudflare-Konto-ID"
              placeholder="z. B. 0123456789abcdef0123456789abcdef"
              description="Das Cloudflare-Konto, das für die Workers-AI-Nutzung abgerechnet wird"
              value={accountId}
              onChange={(e) => { setAccountId(e.target.value); setErrors(prev => ({ ...prev, accountId: '' })) }}
              error={errors.accountId}
              variant={errors.accountId ? 'error' : 'default'}
            />
          )}

          {/* API Token */}
          {showCredentials && selection && (
            <StoredSecretInput
              label="API-Token"
              stored={storedSecretsUsable && source!.config.apiToken === null}
              placeholder={tokenRequired ? API_TOKEN_PLACEHOLDERS[selection.provider] : '(optional)'}
              description={
                isOllama
                  ? 'Optional für lokalen Ollama-Zugriff'
                  : isCloudflare
                  ? 'Ein API-Token mit den Workers-AI-Berechtigungen „Read" + „Edit" (im Dashboard: Workers AI > Use REST API > Create a Workers AI API Token)'
                  : TOKEN_OPTIONAL_WITH_HEADERS.has(selection.provider)
                  ? `Dein ${PROVIDER_LABELS[selection.provider]}-API-Token für die Abrechnung. Leer lassen, wenn dich die zusätzlichen Header unter „Erweiterte Einstellungen" bei einem Proxy authentifizieren, der seinen eigenen Schlüssel mitbringt.`
                  : `Dein ${PROVIDER_LABELS[selection.provider]}-API-Token für die Abrechnung`
              }
              value={effectiveApiToken}
              onValueChange={(v) => { setApiToken(v); setErrors(prev => ({ ...prev, apiToken: '' })) }}
              error={errors.apiToken}
            />
          )}

          {/* Ollama API URL (always visible for Ollama) */}
          {showCredentials && isOllama && (
            <Input
              label="API-URL"
              placeholder="http://localhost:11434"
              description="URL deines Ollama-Servers"
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setErrors(prev => ({ ...prev, apiUrl: '' })) }}
              error={errors.apiUrl}
              variant={errors.apiUrl ? 'error' : 'default'}
            />
          )}

          {selection && (
            <Collapsible.Root
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            >
              <Collapsible.DefaultTrigger>Erweiterte Einstellungen</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <div className="space-y-4">
                  {/* Ollama shows its API URL above; Workers AI's endpoint is derived from the account ID. */}
                  {showCredentials && !isOllama && !isCloudflare && (
                    <Input
                      label="API-URL"
                      placeholder="https://..."
                      description="Überschreibt den Standard-API-Endpoint (nützlich für Proxys wie Cloudflare AI Gateway)"
                      value={apiUrl}
                      onChange={(e) => setApiUrl(e.target.value)}
                    />
                  )}
                  {showCredentials && (
                    <ExtraHeadersEditor
                      rows={headerRows}
                      storedValuesUsable={storedSecretsUsable}
                      errors={headerErrors}
                      onRowsChange={(rows) => {
                        setHeaderRows(rows)
                        setHeaderErrors({})
                        // Adding a header can make the token optional.
                        setErrors(prev => ({ ...prev, apiToken: '' }))
                      }}
                    />
                  )}
                  <Input
                    label="Kontextfenster"
                    inputMode="numeric"
                    placeholder="(Standard)"
                    description="Die maximale Gesamtzahl an Tokens pro Anfrage. Leer lassen, um den eingebauten Standard des Modells zu verwenden."
                    value={contextWindow}
                    onChange={(e) => { setContextWindow(e.target.value); setErrors(prev => ({ ...prev, contextWindow: '' })) }}
                    error={errors.contextWindow}
                    variant={errors.contextWindow ? 'error' : 'default'}
                  />
                  <Input
                    label="Ausgabelimit"
                    inputMode="numeric"
                    placeholder="(Standard)"
                    description="Die maximale Anzahl an Tokens pro Antwort; sie wird auch vom Kontextfenster reserviert. Leer lassen, um den eingebauten Standard des Modells zu verwenden."
                    value={outputLimit}
                    onChange={(e) => { setOutputLimit(e.target.value); setErrors(prev => ({ ...prev, outputLimit: '' })) }}
                    error={errors.outputLimit}
                    variant={errors.outputLimit ? 'error' : 'default'}
                  />
                </div>
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(props) => (
            <Button variant="secondary" {...props} disabled={loading}>
              Abbrechen
            </Button>
          )} />
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={loading}
            disabled={!selection}
          >
            {editing ? 'Änderungen speichern' : 'Modell hinzufügen'}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
