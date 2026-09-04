export function isUnauthorizedError(error: Error): boolean {
  return /^401: .*Unauthorized/.test(error.message);
}

/**
 * Whether a query failed because the server refused the caller, as opposed
 * to the record not existing or the request itself failing. The default query
 * function prefixes its error with the status, which is the only thing a page
 * needs to tell "you may not" from "something went wrong".
 */
export function isForbiddenError(error: Error): boolean {
  return /^403: /.test(error.message);
}
