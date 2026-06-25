import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const hubView = readFileSync(resolve(import.meta.dirname, 'HubView.jsx'), 'utf8')
const filterPanel = readFileSync(resolve(import.meta.dirname, '../components/FilterPanel.jsx'), 'utf8')

describe('Hub installed filter UI', () => {
  it('uses a switch instead of a two-option list', () => {
    const start = hubView.indexOf("key: 'installed',")
    const end = hubView.indexOf('\n      },', start)
    const installedSection = hubView.slice(start, end)

    expect(installedSection).toContain("type: 'switch'")
    expect(installedSection).toContain("label: 'Installed'")
    expect(installedSection).toContain("switchLabel: 'Hide installed'")
    expect(installedSection).toContain('checked: hideInstalled')
    expect(installedSection).toContain('onCheckedChange: setHideInstalled')
    expect(installedSection).not.toContain('items:')
    expect(filterPanel).toContain("import { Switch } from '@/components/ui/switch'")
    expect(filterPanel).toContain("section.type === 'switch'")
  })
})
