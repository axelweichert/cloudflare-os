import { Select, type PortalContainer } from '@cloudflare/kumo'
import { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { ConnectionConfigField } from './ConnectionConfigField'
import { useT } from '../i18n/useT'

export interface AiModelConnectionConfigProps {
  availableModels: AiChatAuthorInfo[]
  selectedModelId: string | undefined
  onSelectedModelIdChange: (id: string | undefined) => void
  selectContainer?: PortalContainer
}

export function AiModelConnectionConfig({
  availableModels,
  selectedModelId,
  onSelectedModelIdChange,
  selectContainer,
}: AiModelConnectionConfigProps) {
  const t = useT()
  return (
    <section className="grid gap-3">
      <ConnectionConfigField
        label={t('gk.aimodel.model')}
        description={t('gk.aimodel.modelDesc')}
      >
        <Select
          aria-label={t('gk.aimodel.selectModel')}
          className="w-full text-sm [&_button]:!h-9"
          container={selectContainer}
          placeholder={t('gk.aimodel.selectModel')}
          value={selectedModelId}
          onValueChange={(v) => onSelectedModelIdChange(v as string | undefined)}
          renderValue={(id) => availableModels.find((m) => m.id === id)?.name ?? id}
        >
          {availableModels.map(model => (
            <Select.Option key={model.id} value={model.id}>
              {model.name}
            </Select.Option>
          ))}
        </Select>
      </ConnectionConfigField>
    </section>
  )
}
