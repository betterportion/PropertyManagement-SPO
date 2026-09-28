/**
 * Pages anybody can read, signed in or not.
 *
 * Everything else in the client sits behind the sign-in: a signed-out visitor
 * gets the landing page whatever the path, and a deactivated account gets
 * `AccountInactive`. A privacy notice has to be readable before somebody signs
 * in (the landing page links to it) and after they lose access, so `App.tsx`
 * checks this before either of those. The server needs nothing: it serves the
 * client for any path that is not `/api`, and every page's data is refused
 * there on its own.
 */
export const PRIVACY_PATH = "/privacy";

export function isPublicPage(path: string): boolean {
  return path === PRIVACY_PATH || path === `${PRIVACY_PATH}/`;
}
