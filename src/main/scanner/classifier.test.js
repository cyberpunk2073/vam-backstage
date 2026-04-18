import { describe, it, expect } from 'vitest'
import { classifyContents, derivePackageType } from './classifier'

const f = (path, size = 0) => ({ path, size })

describe('classifyContents', () => {
  // --- Scenes ---

  it('classifies scene .json', () => {
    const items = classifyContents([f('Saves/scene/MyScene.json')])
    expect(items).toEqual([
      { internalPath: 'Saves/scene/MyScene.json', displayName: 'MyScene', type: 'scene', thumbnailPath: null },
    ])
  })

  it('classifies legacy scene .vac', () => {
    const items = classifyContents([f('Saves/scene/Old.vac')])
    expect(items[0].type).toBe('legacyScene')
  })

  it('classifies subscene', () => {
    const items = classifyContents([f('Custom/SubScene/Room.json')])
    expect(items[0].type).toBe('subscene')
  })

  it('classifies subscene with plural folder', () => {
    const items = classifyContents([f('Custom/SubScenes/Room.json')])
    expect(items[0].type).toBe('subscene')
  })

  // --- Looks ---

  it('classifies modern look .vap', () => {
    const items = classifyContents([f('Custom/Atom/Person/Appearance/Cool_Look.vap')])
    expect(items[0].type).toBe('look')
    expect(items[0].displayName).toBe('Cool Look')
  })

  it('classifies legacy look .json', () => {
    const items = classifyContents([f('Saves/Person/Appearance/OldLook.json')])
    expect(items[0].type).toBe('legacyLook')
  })

  it('classifies skin preset', () => {
    const items = classifyContents([f('Custom/Atom/Person/Skin/Fair.vap')])
    expect(items[0].type).toBe('skinPreset')
  })

  // --- Poses ---

  it('classifies modern pose .vap', () => {
    const items = classifyContents([f('Custom/Atom/Person/Pose/Stand.vap')])
    expect(items[0].type).toBe('pose')
  })

  it('classifies legacy pose .json', () => {
    const items = classifyContents([f('Saves/Person/Pose/Sit.json')])
    expect(items[0].type).toBe('legacyPose')
  })

  // --- Clothing ---

  it('classifies clothing item', () => {
    const items = classifyContents([f('Custom/Clothing/Author/Dress.vab')])
    expect(items[0].type).toBe('clothingItem')
  })

  it('classifies clothing preset', () => {
    const items = classifyContents([f('Custom/Atom/Person/Clothing/Outfit.vap')])
    expect(items[0].type).toBe('clothingPreset')
  })

  // --- Hairstyles ---

  it('classifies hair item', () => {
    const items = classifyContents([f('Custom/Hair/Author/Bob.vam')])
    expect(items[0].type).toBe('hairItem')
  })

  it('classifies hair preset', () => {
    const items = classifyContents([f('Custom/Atom/Person/Hair/Curly.vap')])
    expect(items[0].type).toBe('hairPreset')
  })

  // --- Hidden types ---

  it('classifies morphs (singular and plural folder)', () => {
    expect(classifyContents([f('Custom/Atom/Person/Morphs/face.vmi')])[0].type).toBe('morphBinary')
    expect(classifyContents([f('Custom/Atom/Person/Morph/face.vmi')])[0].type).toBe('morphBinary')
  })

  it('classifies plugin script', () => {
    const items = classifyContents([f('Custom/Scripts/Author/Plugin.cs')])
    expect(items[0].type).toBe('pluginScript')
  })

  it('classifies script list', () => {
    const items = classifyContents([f('Custom/Scripts/Author/Plugin.cslist')])
    expect(items[0].type).toBe('scriptList')
  })

  it('classifies plugin preset', () => {
    const items = classifyContents([f('Custom/Atom/Person/Plugins/MyPlugin.vap')])
    expect(items[0].type).toBe('pluginPreset')
  })

  it('classifies assets', () => {
    const items = classifyContents([f('Custom/Assets/pack.assetbundle')])
    expect(items[0].type).toBe('assetbundle')
  })

  it('classifies audio assetbundle under Sounds', () => {
    const items = classifyContents([f('Custom/Sounds/fx.assetbundle')])
    expect(items[0].type).toBe('assetbundle')
  })

  it('classifies textures', () => {
    const items = classifyContents([f('Custom/Atom/Person/Textures/skin.png')])
    expect(items[0].type).toBe('texture')
  })

  it('classifies audio from Sounds/ and Audio/ folders', () => {
    expect(classifyContents([f('Custom/Sounds/fx.wav')])[0].type).toBe('audio')
    expect(classifyContents([f('Custom/Sound/fx.wav')])[0].type).toBe('audio')
    expect(classifyContents([f('Custom/Audio/fx.mp3')])[0].type).toBe('audio')
  })

  it('classifies atom preset (Empty)', () => {
    const items = classifyContents([f('Custom/Empty/Base.vap')])
    expect(items[0].type).toBe('atomPreset')
  })

  it('classifies atom preset (Image)', () => {
    const items = classifyContents([f('Custom/Image/Picture.vap')])
    expect(items[0].type).toBe('atomPreset')
  })

  it('does not classify .vap in excluded folders as atomPreset', () => {
    expect(classifyContents([f('Custom/Scripts/Thing.vap')])).toEqual([])
    expect(classifyContents([f('Custom/Assets/Thing.vap')])).toEqual([])
    expect(classifyContents([f('Custom/PluginData/Thing.vap')])).toEqual([])
  })

  it('does not match atomPreset for deep paths (only one level under Custom/)', () => {
    expect(classifyContents([f('Custom/Empty/Sub/Deep.vap')])).toEqual([])
  })

  // --- General ---

  it('ignores files that match no rule', () => {
    const items = classifyContents([f('README.txt'), f('meta.json'), f('Custom/Unknown/foo.xyz')])
    expect(items).toEqual([])
  })

  it('ignores files with wrong extension for a matching path', () => {
    const items = classifyContents([f('Saves/scene/MyScene.vap')])
    expect(items).toEqual([])
  })

  it('returns empty array for empty input', () => {
    expect(classifyContents([])).toEqual([])
  })

  it('replaces underscores with spaces in display name', () => {
    const items = classifyContents([f('Saves/scene/My_Cool_Scene.json')])
    expect(items[0].displayName).toBe('My Cool Scene')
  })

  it('strips "Preset_" prefix from display name', () => {
    const items = classifyContents([f('Custom/Atom/Person/Pose/Preset_EmbodyPose.vap')])
    expect(items[0].displayName).toBe('EmbodyPose')
  })

  it('strips "Preset " prefix case-insensitively', () => {
    const items = classifyContents([f('Custom/Atom/Person/Clothing/preset_Outfit.vap')])
    expect(items[0].displayName).toBe('Outfit')
  })

  it('keeps name intact when "Preset" is the entire name', () => {
    const items = classifyContents([f('Saves/scene/Preset.json')])
    expect(items[0].displayName).toBe('Preset')
  })

  // --- Thumbnail resolution ---

  it('finds .jpg thumbnail sibling', () => {
    const items = classifyContents([f('Saves/scene/S.json'), f('Saves/scene/S.jpg')])
    expect(items[0].thumbnailPath).toBe('Saves/scene/S.jpg')
  })

  it('finds .jpeg thumbnail sibling', () => {
    const items = classifyContents([f('Saves/scene/S.json'), f('Saves/scene/S.jpeg')])
    expect(items[0].thumbnailPath).toBe('Saves/scene/S.jpeg')
  })

  it('finds .png thumbnail sibling', () => {
    const items = classifyContents([f('Saves/scene/S.json'), f('Saves/scene/S.png')])
    expect(items[0].thumbnailPath).toBe('Saves/scene/S.png')
  })

  it('prefers .jpg over .png for thumbnails', () => {
    const items = classifyContents([f('Saves/scene/S.json'), f('Saves/scene/S.jpg'), f('Saves/scene/S.png')])
    expect(items[0].thumbnailPath).toBe('Saves/scene/S.jpg')
  })

  it('returns null thumbnail when no sibling image exists', () => {
    const items = classifyContents([f('Saves/scene/S.json')])
    expect(items[0].thumbnailPath).toBeNull()
  })

  // --- Case insensitivity ---

  it('matches paths case-insensitively', () => {
    expect(classifyContents([f('SAVES/SCENE/S.json')])[0].type).toBe('scene')
    expect(classifyContents([f('custom/clothing/A/D.vab')])[0].type).toBe('clothingItem')
  })

  // --- Same-type sibling dedup ---

  it('deduplicates clothing item siblings, keeping .vam', () => {
    const items = classifyContents([
      f('Custom/Clothing/A/Dress.vab'),
      f('Custom/Clothing/A/Dress.vaj'),
      f('Custom/Clothing/A/Dress.vam'),
    ])
    expect(items).toHaveLength(1)
    expect(items[0].internalPath).toBe('Custom/Clothing/A/Dress.vam')
  })

  it('deduplicates morph siblings, keeping .vmi', () => {
    const items = classifyContents([
      f('Custom/Atom/Person/Morphs/M.vmb'),
      f('Custom/Atom/Person/Morphs/M.vmi'),
      f('Custom/Atom/Person/Morphs/M.dsf'),
    ])
    expect(items).toHaveLength(1)
    expect(items[0].internalPath).toBe('Custom/Atom/Person/Morphs/M.vmi')
  })

  it('does not dedup items with different stems', () => {
    const items = classifyContents([f('Custom/Clothing/A/Shirt.vab'), f('Custom/Clothing/A/Pants.vab')])
    expect(items).toHaveLength(2)
  })

  it('does not dedup scenes (single extension, no prefer list)', () => {
    const items = classifyContents([f('Saves/scene/A.json'), f('Saves/scene/B.json')])
    expect(items).toHaveLength(2)
  })

  // --- Cross-type item↔preset dedup ---

  it('collapses clothing item + preset with same display name, preset wins when neither has thumbnail', () => {
    const items = classifyContents([f('Custom/Clothing/A/Dress.vab'), f('Custom/Atom/Person/Clothing/Dress.vap')])
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('clothingPreset')
  })

  it('collapses hair item + preset with same display name, preset wins when both have thumbnails', () => {
    const items = classifyContents([
      f('Custom/Hair/A/Style.vab'),
      f('Custom/Hair/A/Style.jpg'),
      f('Custom/Atom/Person/Hair/Style.vap'),
      f('Custom/Atom/Person/Hair/Style.jpg'),
    ])
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('hairPreset')
    expect(items[0].thumbnailPath).toBe('Custom/Atom/Person/Hair/Style.jpg')
  })

  it('item wins over preset when only item has thumbnail', () => {
    const items = classifyContents([
      f('Custom/Clothing/A/Dress.vab'),
      f('Custom/Clothing/A/Dress.jpg'),
      f('Custom/Atom/Person/Clothing/Dress.vap'),
    ])
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('clothingItem')
    expect(items[0].thumbnailPath).toBe('Custom/Clothing/A/Dress.jpg')
  })

  it('preset wins over item when only preset has thumbnail', () => {
    const items = classifyContents([
      f('Custom/Clothing/A/Dress.vab'),
      f('Custom/Atom/Person/Clothing/Dress.vap'),
      f('Custom/Atom/Person/Clothing/Dress.jpg'),
    ])
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('clothingPreset')
    expect(items[0].thumbnailPath).toBe('Custom/Atom/Person/Clothing/Dress.jpg')
  })

  it('preset inherits thumbnail from item when preset has none', () => {
    const items = classifyContents([
      f('Custom/Hair/A/Bob.vam'),
      f('Custom/Hair/A/Bob.jpg'),
      f('Custom/Atom/Person/Hair/Bob.vap'),
    ])
    // Item has thumb, so item wins
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('hairItem')
    expect(items[0].thumbnailPath).toBe('Custom/Hair/A/Bob.jpg')
  })

  it('does not cross-dedup items with different display names', () => {
    const items = classifyContents([f('Custom/Clothing/A/Shirt.vab'), f('Custom/Atom/Person/Clothing/Pants.vap')])
    expect(items).toHaveLength(2)
  })
})

describe('derivePackageType', () => {
  it('returns null for empty content list', () => {
    expect(derivePackageType([])).toBeNull()
  })

  it('returns the category for a single visible type', () => {
    expect(derivePackageType([{ type: 'scene' }])).toBe('Scenes')
  })

  it('returns null when all types are hidden', () => {
    expect(derivePackageType([{ type: 'pluginScript' }, { type: 'morphBinary' }])).toBeNull()
  })

  it('picks highest-priority category from mixed content (Scenes > Looks)', () => {
    expect(derivePackageType([{ type: 'look' }, { type: 'scene' }])).toBe('Scenes')
  })

  it('picks Clothing over Hairstyles', () => {
    expect(derivePackageType([{ type: 'hairItem' }, { type: 'clothingPreset' }])).toBe('Clothing')
  })

  it('ignores hidden types when determining package type', () => {
    expect(derivePackageType([{ type: 'morphBinary' }, { type: 'pose' }])).toBe('Poses')
  })

  it('maps legacy types to their category', () => {
    expect(derivePackageType([{ type: 'legacyScene' }])).toBe('Scenes')
    expect(derivePackageType([{ type: 'legacyLook' }])).toBe('Looks')
    expect(derivePackageType([{ type: 'legacyPose' }])).toBe('Poses')
  })
})
