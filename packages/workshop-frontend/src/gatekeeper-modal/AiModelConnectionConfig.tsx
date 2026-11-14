import { Fragment } from 'react'
import { Select, type PortalContainer } from '@cloudflare/kumo'
import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { ConnectionConfigField } from './ConnectionConfigField'
import { useT } from '../i18n/useT'

export interface AiModelConnectionConfigProps {
  chatModels: AiChatAuthorInfo[]
  decisionModels: AiChatAuthorInfo[]
  selectedModelId: string | undefined
  onSelectedModelIdChange: (id: string | undefined) => void
  selectContainer?: PortalContainer
}

export function AiModelConnectionConfig({
  chatModels,
  decisionModels,
  selectedModelId,
  onSelectedModelIdChange,
  selectContainer,
}: AiModelConnectionConfigProps) {
  const t = useT()
  const groups = [
    { label: 'Sprachmodelle', models: chatModels },
    { label: 'Entscheidungsmodelle', models: decisionModels },
  ].filter(group => group.models.length > 0)

  return (
    <section className="grid gap-3">
      <ConnectionConfigField
        label={t('gk.aimodel.model')}
        description="Sprachmodelle schreiben Text. Entscheidungsmodelle beantworten Fragen mit Wahrscheinlichkeiten."
      >
        <Select
          aria-label={t('gk.aimodel.selectModel')}
          className="w-full text-sm [&_button]:!h-9"
          container={selectContainer}
          placeholder={t('gk.aimodel.selectModel')}
          value={selectedModelId}
          onValueChange={(v) => onSelectedModelIdChange(v as string | undefined)}
          renderValue={(id) => [...chatModels, ...decisionModels].find((m) => m.id === id)?.name ?? id}
        >
          {groups.map((group, index) => (
            <Fragment key={group.label}>
              {index > 0 && <Select.Separator />}
              <Select.Group>
                <Select.GroupLabel>{group.label}</Select.GroupLabel>
                {group.models.map(model => (
                  <Select.Option key={model.id} value={model.id}>
                    {model.name}
                  </Select.Option>
                ))}
              </Select.Group>
            </Fragment>
          ))}
        </Select>
      </ConnectionConfigField>
    </section>
  )
}
