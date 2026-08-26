import { Switch, Tooltip } from '@cloudflare/kumo'

interface HookToggleProps {
  enabled: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => void
  size?: 'sm' | 'base' | 'lg'
}

/** Enable/disable toggle for bound hooks. Used in the Connections tab, Activity log, and inline chat. */
export function HookToggle({ enabled, disabled = false, onToggle, size = 'sm' }: HookToggleProps) {
  return (
    <Tooltip content={enabled ? 'Hook deaktivieren.' : 'Hook aktivieren.'} asChild>
      <span className="inline-flex items-center">
        <Switch
          checked={enabled}
          disabled={disabled}
          size={size}
          onCheckedChange={(checked) => onToggle(checked)}
          aria-label={enabled ? 'Hook deaktivieren' : 'Hook aktivieren'}
        />
      </span>
    </Tooltip>
  )
}
