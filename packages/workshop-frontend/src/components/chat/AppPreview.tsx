import { Badge } from '@cloudflare/kumo'
import { Text } from '@cloudflare/kumo'
import { Circle } from '@phosphor-icons/react'
import { sampleDataRows } from '../../data/chat'

/**
 * App tab = live preview of the running app.
 * This renders a mock of what the deployed Slack summarizer looks like.
 */
export default function AppPreview() {
  return (
    <div className="flex flex-col h-full bg-kumo-base">
      {/* App content */}
      <div className="flex-1 overflow-auto p-6">
        {/* App header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <Text variant="heading2" as="h1">Kanal-Zusammenfassung</Text>
            <p className="text-sm text-kumo-subtle mt-1">
              Tägliche Zusammenfassung deiner Slack-Kanäle, powered by Workers AI
            </p>
          </div>
          <Badge variant="success">Live</Badge>
        </div>

        {/* Channel cards */}
        <div className="grid gap-3">
          {sampleDataRows.filter(r => r.unread).map((row) => (
            <div
              key={row.id}
              className="rounded-lg border border-kumo-line bg-kumo-base p-4 hover:bg-kumo-elevated transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-kumo-default">{row.channel}</span>
                  <Badge variant="primary">{row.messages} Nachr.</Badge>
                </div>
                <span className="text-xs text-kumo-subtle">{row.lastActive}</span>
              </div>
              {/* Fake summary */}
              <div className="space-y-1.5 mt-3">
                <div className="flex items-start gap-2">
                  <Circle size={5} className="text-kumo-subtle mt-1.5 flex-shrink-0" weight="fill" />
                  <p className="text-sm text-kumo-subtle">
                    {row.channel === '#general'
                      ? 'Team hat den Zeitplan der Q1-Planung besprochen und den 15. März als Frist für Vorschläge festgelegt'
                      : row.channel === '#engineering'
                        ? 'Hotfix v2.4.1 für Auth-Timeout ausgerollt. Monitoring-Dashboards zeigen wieder normale Latenz'
                        : 'Angeregte Diskussion über Hackathon-Projekte am Wochenende und Mittagspläne für Freitag'}
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  <Circle size={5} className="text-kumo-subtle mt-1.5 flex-shrink-0" weight="fill" />
                  <p className="text-sm text-kumo-subtle">
                    {row.channel === '#general'
                      ? '3 Aufgaben zugewiesen, 2 Entscheidungen getroffen'
                      : row.channel === '#engineering'
                        ? 'RFC für neue Caching-Schicht hat 5 Freigaben erhalten, geht in die Umsetzung'
                        : '12 Teilnehmende, angesagte Themen: Hackathon, Team-Lunch, Offsite'}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Quiet channels */}
        <div className="mt-6">
          <div className="text-xs font-semibold text-kumo-subtle uppercase tracking-wider mb-3">
            Keine neue Aktivität
          </div>
          <div className="flex flex-wrap gap-2">
            {sampleDataRows.filter(r => !r.unread).map((row) => (
              <div key={row.id} className="px-3 py-1.5 rounded-md bg-kumo-tint">
                <span className="font-mono text-xs text-kumo-subtle">{row.channel}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
