import { createFileRoute } from '@tanstack/react-router'
import BlueprintsPage from '../BlueprintsPage'
import { useDocumentTitle } from '../useDocumentTitle'
import { useT } from '../i18n/useT'

export const Route = createFileRoute('/explore')({
  component: ExplorePage,
})

function ExplorePage() {
  const t = useT()
  useDocumentTitle(t('routes.explore.title'))

  return <BlueprintsPage />
}
