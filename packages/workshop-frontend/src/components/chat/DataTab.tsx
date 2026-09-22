import { useState } from 'react'
import { Table } from '@cloudflare/kumo'
import { Badge } from '@cloudflare/kumo'
import { Button } from '@cloudflare/kumo'
import { sampleDataRows } from '../../data/chat'
import { useT } from '../../i18n/useT'

export default function DataTab() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const t = useT()

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (selectedIds.size === sampleDataRows.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(sampleDataRows.map((r) => r.id)))
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-kumo-fill bg-kumo-elevated">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-kumo-default">channels</span>
          <Badge variant="secondary">{t('chat.data.rows', { n: String(sampleDataRows.length) })}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <span className="text-xs text-kumo-subtle">
              {t('chat.data.selected', { n: String(selectedIds.size) })}
            </span>
          )}
          <Button variant="ghost" size="xs">{t('chat.data.filter')}</Button>
          <Button variant="ghost" size="xs">{t('chat.data.sort')}</Button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <Table layout="fixed">
          <Table.Header>
            <Table.Row>
              <Table.CheckHead
                checked={selectedIds.size === sampleDataRows.length}
                indeterminate={selectedIds.size > 0 && selectedIds.size < sampleDataRows.length}
                onValueChange={toggleAll}
                aria-label="Alle Zeilen auswählen"
              />
              <Table.Head>{t('chat.data.colChannel')}</Table.Head>
              <Table.Head>{t('chat.data.colMessages')}</Table.Head>
              <Table.Head>{t('chat.data.colLastActive')}</Table.Head>
              <Table.Head>{t('chat.data.colStatus')}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {sampleDataRows.map((row) => (
              <Table.Row key={row.id} variant={selectedIds.has(row.id) ? 'selected' : 'default'}>
                <Table.CheckCell
                  checked={selectedIds.has(row.id)}
                  onValueChange={() => toggleRow(row.id)}
                  aria-label={`${row.channel} auswählen`}
                />
                <Table.Cell>
                  <span className="font-mono text-sm text-kumo-default">{row.channel}</span>
                </Table.Cell>
                <Table.Cell>
                  <span className="text-sm text-kumo-subtle tabular-nums">
                    {row.messages.toLocaleString()}
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <span className="text-xs text-kumo-subtle">{row.lastActive}</span>
                </Table.Cell>
                <Table.Cell>
                  {row.unread ? (
                    <Badge variant="primary">{t('chat.data.unread')}</Badge>
                  ) : (
                    <Badge variant="secondary">{t('chat.data.read')}</Badge>
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-kumo-fill bg-kumo-elevated flex items-center justify-between">
        <span className="font-mono text-xs text-kumo-subtle">
          {t('chat.data.rowsInChannels', { n: String(sampleDataRows.length) })}
        </span>
        <span className="font-mono text-xs text-kumo-subtle">
          {t('chat.data.messagesTotal', { n: sampleDataRows.reduce((sum, r) => sum + r.messages, 0).toLocaleString() })}
        </span>
      </div>
    </div>
  )
}
