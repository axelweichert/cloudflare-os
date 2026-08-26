import { createFileRoute } from '@tanstack/react-router'
import { BookOpen, Sparkle, type Icon as PhosphorIcon } from '@phosphor-icons/react'
import { useDocumentTitle } from '../useDocumentTitle'
import ComingSoonPreview from '../components/ComingSoonPreview'
import { useSiteName } from '../ServerConfigContext'

/**
 * Context & Skills. The knowledge/skills surface isn't built into the rail yet — agents read
 * curated collections of documents (context) and reusable skills. Until then this page shows a
 * frosted design mock so the nav entry has a stable, on-language target.
 */
export const Route = createFileRoute('/context')({
  component: ContextPage,
})

type Kind = 'collection' | 'skill'

interface ContextItem {
  id: string
  name: string
  kind: Kind
  detail: string
  updated: string
}

const TYPE_META: Record<Kind, { label: string; Icon: PhosphorIcon }> = {
  collection: { label: 'Sammlung', Icon: BookOpen },
  skill: { label: 'Skill', Icon: Sparkle },
}

const MOCK_ITEMS: ContextItem[] = [
  { id: '1', name: 'Unternehmenshandbuch', kind: 'collection', detail: '12 Dokumente', updated: 'vor 2 T' },
  { id: '2', name: 'Markenstimme & Stil', kind: 'collection', detail: '5 Dokumente', updated: 'vor 1 Wo' },
  { id: '3', name: 'API-Referenz', kind: 'collection', detail: '28 Dokumente', updated: 'vor 1 Wo' },
  { id: '4', name: 'Besprechungsnotizen zusammenfassen', kind: 'skill', detail: 'Wiederverwendbarer Skill', updated: 'vor 3 T' },
  { id: '5', name: 'Vertriebs-Playbook', kind: 'collection', detail: '9 Dokumente', updated: 'vor 2 Wo' },
  { id: '6', name: 'Kunden-E-Mail entwerfen', kind: 'skill', detail: 'Wiederverwendbarer Skill', updated: 'vor 2 Wo' },
]

function ContextRow({ item }: { item: ContextItem }) {
  const { label, Icon } = TYPE_META[item.kind]
  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">{item.name}</p>
        <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
          {label} · {item.detail}
        </p>
      </div>
      <span className="hidden shrink-0 text-xs tracking-[-0.1px] text-kumo-inactive lg:block">
        {item.updated}
      </span>
    </div>
  )
}

function ContextPage() {
  useDocumentTitle('Kontext & Skills')
  const siteName = useSiteName()
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-3 sm:px-10">
      <header className="px-3 pb-4 pt-6 sm:pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Kontext &amp; Skills</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          Kuratierte Wissenssammlungen, die Deine Agenten lesen, plus wiederverwendbare Skills, die sie anwenden können.
        </p>
      </header>

      <ComingSoonPreview
        icon={BookOpen}
        title={`Kontext & Skills kommen bald zu ${siteName}`}
        description="Eine Vorschau, wie Du Wissenssammlungen und Skills für Deine Agenten erstellst, auf die sie zurückgreifen können."
      >
        <div className="chat-panel min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
          <div className="flex flex-col gap-0.5">
            {MOCK_ITEMS.map((item) => (
              <ContextRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      </ComingSoonPreview>
    </div>
  )
}
