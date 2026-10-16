/** Compact presentation uses the shipped composition, not a mobile-only shell. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { connectFreshWorkspace, saveFailureShot, writeComposerDraft } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/compact-navigation', import.meta.url))
const MODE = webSnapshotMode()
const { version } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }

/** Wait for ResizeObserver and the frame's presentation transition to settle. */
async function settleFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForFunction(() => !document.querySelector('[data-animating]'))
}

/** Return header controls extending beyond the Settings panel, excluding hidden nodes. */
async function clippedHeaderControls(dialog: Locator): Promise<string[]> {
  return dialog.evaluate((element) => {
    const panel = element.getBoundingClientRect()
    const header = element.querySelector('[class*="header"]')!
    return [...header.querySelectorAll<HTMLElement>('button')].filter((button) => {
      const box = button.getBoundingClientRect()
      return box.width > 0 && (box.left < panel.left - 1 || box.right > panel.right + 1)
    }).map(button => button.getAttribute('aria-label') ?? button.textContent ?? '')
  })
}

it('preserves the mounted conversation beneath compact navigation and reuses Settings and command menus', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  const browserPromise = chromium.launch()
  onTestFinished(async () => {
    try { await (await browserPromise).close() } finally { await scaffold.close() }
  })
  const fixture = createChatScrollFixture({
    markerPrefix: 'COMPACT_NAV', title: 'Compact navigation retains this long Session title and its draft', turns: 12,
  })
  await seedSession(scaffold, fixture.log, 'compact-navigation-seed')
  const browser = await browserPromise
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 }, locale: 'en-US', hasTouch: true, isMobile: true, reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  onTestFailed(() => saveFailureShot(page, 'web-e2e-compact-navigation'))
  const tripwire = watchConsole(page)
  let sentMessages = 0
  const off = scaffold.ctx.on('session/event', (_session, event) => { if (event.type === 'user/message') sentMessages++ })
  onTestFinished(() => { off() })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const initialOpener = page.getByRole('button', { name: 'Open sidebar', exact: true })
  await initialOpener.tap()
  await page.getByRole('dialog', { name: 'Navigation', exact: true })
    .getByRole('button', { name: 'New session', exact: true }).last().tap()
  await page.getByRole('dialog', { name: 'Navigation', exact: true }).waitFor({ state: 'hidden' })
  await page.getByRole('textbox', { name: 'Choose workspace', exact: true }).waitFor()
  expect(await initialOpener.isVisible()).toBe(true)
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'compact-navigation')
  const opener = page.getByRole('button', { name: 'Open sidebar', exact: true })
  const navigation = page.getByRole('dialog', { name: 'Navigation', exact: true })
  const openNavigation = async (): Promise<void> => { await opener.tap(); await navigation.waitFor() }
  await openNavigation()
  await navigation.getByRole('button', { name: 'Search sessions', exact: true }).tap()
  await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill(fixture.title)
  expect(await navigation.isVisible()).toBe(true)
  const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => result.count(), { timeout: 60_000 }).toBe(1)
  await result.tap()
  await navigation.waitFor({ state: 'hidden' })
  await page.getByText(fixture.markers.assistant(12), { exact: false }).last().waitFor()
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await writeComposerDraft(page, input, 'alpha beta gamma')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'mobile.txt', mimeType: 'text/plain', buffer: Buffer.from('Retained compact-navigation attachment.'),
  })
  const attachments = page.getByRole('group', { name: 'Pending attachments', exact: true })
  await page.getByTitle('mobile.txt', { exact: true }).waitFor()
  await expect.poll(() => attachments.locator(':scope > *').count()).toBe(1)
  const originalInput = await input.elementHandle()
  const center = page.locator('[class*="centerCol"]')
  const scrollport = page.locator('[data-conversation-scroll]')

  for (const width of [320, 360, 393, 430]) {
    await page.setViewportSize({ width, height: 852 })
    await settleFrame(page)
    const before = await center.boundingBox()
    const scrollTop = await scrollport.evaluate(element => element.scrollTop)
    await openNavigation()
    expect(await navigation.evaluate(element => element.getBoundingClientRect().width)).toBe(width)
    expect(await center.evaluate(element => element.hasAttribute('inert'))).toBe(true)
    expect((await center.boundingBox())?.width).toBe(before?.width)
    expect(await page.locator('[data-side="sidebar"]').count()).toBe(0)
    await navigation.getByRole('button', { name: 'Collapse sidebar', exact: true }).tap()
    await navigation.waitFor({ state: 'hidden' })
    expect(await center.evaluate(element => element.hasAttribute('inert'))).toBe(false)
    expect(await input.evaluate((element, original) => element === original, originalInput)).toBe(true)
    expect(await input.innerText()).toBe('alpha beta gamma')
    expect(await attachments.locator(':scope > *').count()).toBe(1)
    expect(Math.abs(await scrollport.evaluate(element => element.scrollTop) - scrollTop)).toBeLessThan(1)
    expect(await opener.evaluate(element => element === document.activeElement)).toBe(true)
    expect((await center.boundingBox())?.x).toBe(0)
    expect((await center.boundingBox())?.width).toBe(width)
  }

  await openNavigation()
  const current = navigation.locator('[data-row-key^="session:"][aria-selected="true"]')
  const actions = current.getByRole('button', { name: /actions/i })
  const actionBox = await actions.boundingBox()
  expect(actionBox?.width).toBeGreaterThanOrEqual(44)
  expect(actionBox?.height).toBeGreaterThanOrEqual(44)
  expect(await current.evaluate((row) => {
    const outer = row.getBoundingClientRect()
    return [...row.querySelectorAll('button')].every((button) => {
      const box = button.getBoundingClientRect()
      return box.width === 0 || (box.top >= outer.top - 1 && box.bottom <= outer.bottom + 1)
    })
  })).toBe(true)
  await actions.tap()
  expect(await navigation.isVisible()).toBe(true)
  await page.keyboard.press('Escape')
  expect(await navigation.isVisible()).toBe(true)
  await current.tap()
  await navigation.waitFor({ state: 'hidden' })
  expect(await input.innerText()).toBe('alpha beta gamma')

  await input.focus()
  await page.keyboard.press('Home')
  for (let index = 0; index < 6; index++) await page.keyboard.press('ArrowRight')
  for (let index = 0; index < 4; index++) await page.keyboard.press('Shift+ArrowRight')
  const launcher = page.getByRole('button', { name: 'Add files or run commands', exact: true })
  for (const editorFocused of [false, true]) {
    if (editorFocused) await input.focus(); else await opener.focus()
    await launcher.tap()
    const suggestions = page.getByRole('listbox', { name: 'Trigger suggestions', exact: true })
    await suggestions.getByRole('option').first().waitFor()
    expect(await input.evaluate(element => element === document.activeElement)).toBe(false)
    await launcher.tap()
    await suggestions.waitFor({ state: 'hidden' })
    expect(await input.evaluate(element => element === document.activeElement)).toBe(false)
  }
  await input.focus()
  await page.keyboard.insertText('BETA')
  expect(await input.innerText()).toBe('alpha BETA gamma')
  await writeComposerDraft(page, input, 'alpha beta gamma')
  await launcher.tap()
  await page.getByRole('option', { name: /^Model\b/ }).tap()
  await page.getByRole('textbox', { name: 'Filter options', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  expect(await input.innerText()).toBe('alpha beta gamma')

  await openNavigation()
  await navigation.getByRole('button', { name: 'Settings', exact: true }).tap()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.waitFor()
  expect(await navigation.count()).toBe(0)
  await compareOrRefreshGolden(join(EXPECTED, 'settings.expected.md'),
    await captureStableAria(page, '[data-shortcut-modal="settings"]', scaffold.workspaceCwd, { replacements: [[version, '{{version}}']] }), MODE)
  for (const [width, height] of [[320, 852], [360, 852], [393, 852], [430, 852], [360, 430], [740, 360]] as const) {
    await page.setViewportSize({ width, height })
    await settleFrame(page)
    expect((await settings.boundingBox())?.width).toBe(width)
    expect((await settings.boundingBox())?.height).toBe(height)
    expect(await clippedHeaderControls(settings)).toEqual([])
  }
  await page.setViewportSize({ width: 320, height: 430 })
  const label = settings.locator('[class*="sectionSelector"] span')
  const originalLabel = await label.textContent()
  const largerFont = await page.addStyleTag({ content: 'body { font-size: 20px !important; }' })
  // Stress only this frame's geometry; section registration/selection remains unchanged.
  await label.evaluate((element) => { element.textContent = 'A long registered section label at increased font size' })
  expect(await clippedHeaderControls(settings)).toEqual([])
  await label.evaluate((element, text) => { element.textContent = text }, originalLabel)
  await largerFont.evaluate((element) => { element.parentNode?.removeChild(element) })
  await settings.getByRole('button', { name: 'General', exact: true }).tap()
  await compareOrRefreshGolden(join(EXPECTED, 'sections.expected.md'),
    await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), MODE)
  await page.getByRole('menuitem', { name: 'Models', exact: true }).tap()
  const modelSection = await settings.locator('[class*="options"]').elementHandle()
  await page.setViewportSize({ width: 1024, height: 900 })
  await settleFrame(page)
  expect(await settings.getByRole('button', { name: 'Models', exact: true }).getAttribute('aria-current')).toBe('true')
  expect(await settings.locator('[class*="options"]').evaluate((element, original) => element === original, modelSection)).toBe(true)
  await page.setViewportSize({ width: 393, height: 852 })
  await settleFrame(page)
  await settings.getByRole('button', { name: 'Close', exact: true }).tap()
  await settings.waitFor({ state: 'hidden' })
  expect(await opener.evaluate(element => element === document.activeElement)).toBe(true)

  for (const width of [767, 768, 1023, 1024, 1440, 1023, 768, 767]) {
    await page.setViewportSize({ width, height: 900 })
    await settleFrame(page)
    expect(await page.locator('[data-compact]').count()).toBe(width < 768 ? 1 : 0)
    const expectedSidebar = width < 768 ? 0 : width < 1024 ? 56 : 280
    expect((await center.boundingBox())?.x).toBe(expectedSidebar)
  }
  await openNavigation()
  const globalPages = await navigation.locator('[class*="panelRow"]').allTextContents()
  for (const title of globalPages) {
    await navigation.getByRole('button', { name: title.trim(), exact: true }).tap()
    await navigation.waitFor({ state: 'hidden' })
    expect(await opener.isVisible()).toBe(true)
    await openNavigation()
  }
  await navigation.getByRole('button', { name: 'New session', exact: true }).last().tap()
  await navigation.waitFor({ state: 'hidden' })
  expect(await opener.isVisible()).toBe(true)
  expect(sentMessages).toBe(0)
  await assertFixtureInventory(EXPECTED, ['settings.expected.md', 'sections.expected.md'])
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
}, 180_000)
