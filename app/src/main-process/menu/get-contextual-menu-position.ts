import { BrowserWindow, Menu, PopupOptions, screen } from 'electron'

/** The height of a menu item in a macOS menu, a bit more on older versions */
const MenuItemHeight = 24
const SeparatorHeight = 12
const MenuVerticalPadding = 16
/** The space macOS keeps between a menu and the bottom of the screen */
const ScreenBottomMargin = 8

/**
 * Get where to show a contextual menu opened at the mouse cursor.
 *
 * On macOS, a menu that doesn't fit below the cursor is moved by macOS, which
 * puts it outside of every screen when the window fills a display that isn't
 * the main one (in full screen for instance): the menu is open but invisible.
 * Such a menu is shown above the cursor instead.
 *
 * Returns an empty object to show the menu at the cursor.
 */
export function getContextualMenuPosition(
  menu: Menu,
  window: BrowserWindow | undefined
): Pick<PopupOptions, 'x' | 'y' | 'positioningItem'> {
  if (!__DARWIN__ || window === undefined) {
    return {}
  }

  const visibleItems = menu.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.visible)
  const menuHeight = visibleItems.reduce(
    (height, { item }) =>
      height + (item.type === 'separator' ? SeparatorHeight : MenuItemHeight),
    MenuVerticalPadding
  )

  const cursor = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cursor)
  if (
    cursor.y + menuHeight + ScreenBottomMargin <=
    workArea.y + workArea.height
  ) {
    return {}
  }

  const lastItem = visibleItems
    .reverse()
    .find(({ item }) => item.type !== 'separator')
  if (lastItem === undefined) {
    return {}
  }

  // The position of the positioning item, in the window's content. The cursor
  // stays out of the item so releasing the mouse button doesn't select it.
  const content = window.getContentBounds()
  return {
    positioningItem: lastItem.index,
    x: cursor.x - content.x,
    y: cursor.y - content.y - MenuItemHeight - MenuVerticalPadding / 2,
  }
}
